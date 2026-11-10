import { and, eq, sql } from "drizzle-orm";
import { type Address, type Hex } from "viem";
import { db, schema } from "../db/client.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import { attestorWallet, publicClient } from "../lib/chains.js";
import { attestationRegistryAbi, kronosGuardAbi } from "../lib/abi.generated.js";

/**
 * Attestor (scheduled): once per interval, for every live guard, computes the heavy checks off-chain and
 * posts ONE result to the AttestationRegistry. User transactions only read it (one storage read).
 *   - oracle sanity: 30-minute TWAP per listed asset (median of on-chain samples) and spot-vs-TWAP agreement
 *   - aggregate solvency: total assets vs total liabilities across all positions (kronosSolvency())
 * MVP: signed with the attestor key. Stretch: the same payload proven in SP1 and wrapped in Groth16
 * (prover/), posted with postWithProof().
 */
const TWAP_WINDOW_MS = 30 * 60_000;
const median = (xs: bigint[]) => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s.length ? s[Math.floor(s.length / 2)] : 0n;
};

export interface AttestationInput {
  assets: Address[];
  spots: bigint[];
  twaps: bigint[];
  totalAssets: bigint;
  totalLiabilities: bigint;
  maxDeviationBps: bigint;
  samples: number[];
}

/** Pure decision function (unit-tested). */
export function decide(i: AttestationInput) {
  const oracleOk = i.assets.every((_, k) => {
    const twap = i.twaps[k];
    if (twap === 0n || i.samples[k] < 3) return i.samples[k] < 3; // warming up: trust until enough samples
    const diff = i.spots[k] > twap ? i.spots[k] - twap : twap - i.spots[k];
    return diff * 10_000n <= twap * i.maxDeviationBps;
  });
  return { oracleOk, solvencyOk: i.totalAssets >= i.totalLiabilities };
}

async function attestOne(dep: typeof schema.deployments.$inferSelect, protocolId: string) {
  const wallet = attestorWallet(dep.chainId);
  if (!wallet || !dep.registryAddress) return;
  const c = publicClient(dep.chainId);
  const guard = dep.guardAddress as Address;
  const assets = (await c.readContract({ address: guard, abi: kronosGuardAbi, functionName: "kronosAssets" })) as Address[];
  const [totalAssets, totalLiabilities] = (await c.readContract({ address: guard, abi: kronosGuardAbi, functionName: "kronosSolvency" })) as [bigint, bigint];
  const params = (await c.readContract({ address: guard, abi: kronosGuardAbi, functionName: "params" })) as readonly bigint[];
  const now = Date.now();
  const spots: bigint[] = [];
  const twaps: bigint[] = [];
  const samples: number[] = [];
  for (const a of assets) {
    const spot = (await c.readContract({ address: guard, abi: kronosGuardAbi, functionName: "kronosSpotPrice", args: [a] })) as bigint;
    const key = `kronos:twap:${dep.chainId}:${guard}:${a.toLowerCase()}`;
    await redis().zadd(key, String(now), `${now}:${spot}`);
    await redis().zremrangebyscore(key, 0, now - TWAP_WINDOW_MS);
    await redis().expire(key, 3600);
    const window = (await redis().zrange(key, "0", "-1")).map((m) => BigInt(m.split(":")[1]));
    spots.push(spot);
    twaps.push(window.length ? median(window) : spot);
    samples.push(window.length);
  }
  const { oracleOk, solvencyOk } = decide({ assets, spots, twaps, totalAssets, totalLiabilities, maxDeviationBps: params[2], samples });
  const blockNumber = (await c.getBlockNumber()) - 1n;
  const hash = (await c.readContract({
    address: dep.registryAddress as Address,
    abi: attestationRegistryAbi,
    functionName: "payloadHash",
    args: [guard, blockNumber, oracleOk, solvencyOk, assets, twaps],
  })) as Hex;
  const signature = await wallet.signMessage({ account: wallet.account, message: { raw: hash } });
  const tx = await wallet.writeContract({
    account: wallet.account,
    chain: wallet.chain,
    address: dep.registryAddress as Address,
    abi: attestationRegistryAbi,
    functionName: "post",
    args: [guard, blockNumber, oracleOk, solvencyOk, assets, twaps, signature],
  });
  await db.insert(schema.attestations).values({
    protocolId,
    chainId: dep.chainId,
    block: Number(blockNumber),
    oracleOk,
    solvencyOk,
    proofRef: hash,
    postedTx: tx,
    data: {
      assets,
      spots: spots.map(String),
      twaps: twaps.map(String),
      samples,
      totalAssets: totalAssets.toString(),
      totalLiabilities: totalLiabilities.toString(),
      mode: "signed",
    },
  });
}

export function startAttestor(): () => void {
  if (!env.ATTESTOR_PRIVATE_KEY) {
    logger.info("attestor disabled (ATTESTOR_PRIVATE_KEY not set)");
    return () => undefined;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rows = await db
        .select({ dep: schema.deployments, protocolId: schema.protocols.id })
        .from(schema.deployments)
        .innerJoin(schema.protocols, eq(schema.protocols.id, schema.deployments.protocolId))
        .where(and(eq(schema.deployments.verified, true), sql`${schema.protocols.status} in ('live','paused')`));
      for (const r of rows) {
        await attestOne(r.dep, r.protocolId).catch((e) => logger.warn({ err: String(e).slice(0, 300), deployment: r.dep.id }, "attestation failed"));
      }
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), env.ATTESTOR_INTERVAL_MS);
  void tick();
  logger.info({ intervalMs: env.ATTESTOR_INTERVAL_MS }, "attestor started");
  return () => clearInterval(t);
}
