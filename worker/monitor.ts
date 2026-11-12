import { and, eq, gte, sql } from "drizzle-orm";
import {
  createWalletClient,
  decodeErrorResult,
  decodeEventLog,
  http,
  toFunctionSelector,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { db, schema } from "../db/client.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { chainInfo, publicClient } from "../lib/chains.js";
import { sendAlert, type AlertChannels } from "../lib/alerts.js";
import { nearTighten } from "../lib/near.js";
import { chainSigReady, chainSigTightenOutflow } from "../lib/chainsig.js";
import { guardTimelockAbi, guardedMiniLendAbi, kronosGuardAbi } from "../lib/abi.generated.js";

/**
 * Monitor (always on): watches every live guard with viem, records activity, computes anomaly flags and
 * reacts with tighten-only actions. Anomaly flags tighten the outflow window but never block on their own.
 *   - a new signer followed by a Tier 2 change          -> alert + tighten
 *   - many same-sized withdrawals to fresh addresses     -> alert + tighten
 *   - borrows concentrated on an asset still on probation -> alert
 * Reactions go through the NEAR registry's function-call key (`tighten` only). When the guard's `monitor` is
 * the protocol's MPC-derived address, the registry also signs the EVM `tightenOutflow` via NEAR Chain
 * Signatures; otherwise the EVM key holding the `monitor` role is used (contract-enforced: can only lower).
 */
const ERROR_ABI = [...guardedMiniLendAbi, ...kronosGuardAbi].filter((x) => x.type === "error");
const MAX_RANGE = 2_000n;
const KIND_NAMES = ["Deposit", "Withdraw", "Borrow", "Repay", "Liquidate"];

type Deployment = typeof schema.deployments.$inferSelect;
type Protocol = typeof schema.protocols.$inferSelect;

async function insertEvent(chainId: number, v: typeof schema.events.$inferInsert) {
  await db
    .insert(schema.events)
    .values({ ...v, data: { ...((v.data as object | undefined) ?? {}), chainId } })
    .onConflictDoNothing();
}

function selectorNames(): Map<string, string> {
  const m = new Map<string, string>();
  for (const item of [...guardedMiniLendAbi, ...kronosGuardAbi]) {
    if (item.type !== "function") continue;
    try {
      m.set(toFunctionSelector(item as never), item.name);
    } catch {
      /* ignore */
    }
  }
  return m;
}
const SELECTORS = selectorNames();

async function decodeRevert(chainId: number, tx: { to: Address; input: Hex; from: Address; blockNumber: bigint }) {
  try {
    await publicClient(chainId).call({ to: tx.to, data: tx.input, account: tx.from, blockNumber: tx.blockNumber - 1n });
    return null;
  } catch (e) {
    let data: Hex | undefined;
    (e as { walk?: (fn: (x: unknown) => boolean) => unknown }).walk?.((x) => {
      const d = (x as { data?: unknown })?.data;
      if (typeof d === "string" && d.startsWith("0x")) {
        data = d as Hex;
        return true;
      }
      return false;
    });
    if (!data) return { name: "unknown", args: [] as unknown[] };
    try {
      const r = decodeErrorResult({ abi: ERROR_ABI, data });
      return { name: r.errorName, args: (r.args ?? []) as unknown as unknown[] };
    } catch {
      return { name: data.slice(0, 10), args: [] as unknown[] };
    }
  }
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

export async function tightenOnChain(dep: Deployment, p: Protocol, reason: string) {
  const settings = p.settings as { thresholds?: Record<string, { threshold: string }>; autoTighten?: boolean };
  if (settings.autoTighten === false) return;
  const c = publicClient(dep.chainId);
  const guard = dep.guardAddress as Address;
  const assets: Address[] = [];
  try {
    const base = (await c.readContract({ address: guard, abi: guardedMiniLendAbi, functionName: "base" })) as Address;
    assets.push(base);
  } catch {
    /* non compound-style */
  }
  for (const asset of assets) {
    const cur = (await c.readContract({ address: guard, abi: kronosGuardAbi, functionName: "outflowThreshold", args: [asset] })) as bigint;
    if (cur === 0n) continue;
    const next = cur / 2n;
    // Preferred: Chain Signatures. The registry records the tighten AND has NEAR's MPC network sign the EVM
    // transaction for the guard's monitor (the MPC-derived address). No EVM key on this dyno is involved.
    const cs = await chainSigReady(dep.chainId, guard, p.id);
    if (cs.ready) {
      const r = await chainSigTightenOutflow({ chainId: dep.chainId, guard, protocolId: p.id, asset, newThreshold: next, reason });
      if (r.ok) {
        await insertEvent(dep.chainId, {
          protocolId: p.id,
          kind: "tightened",
          txHash: r.evmTx,
          logIndex: -1,
          asset,
          amount: next.toString(),
          data: { reason, from: cur.toString(), to: next.toString(), via: "chain-signatures", signer: r.signer, nearTx: r.nearTx, evmTx: r.evmTx },
        });
        continue;
      }
      logger.warn({ chainId: dep.chainId, err: r.error, nearTx: r.nearTx }, "Chain Signatures tighten failed; falling back to the monitor key");
    }
    const near = await nearTighten(p.id, { LowerOutflowThreshold: { asset, new_threshold: next.toString() } }, reason);
    let evmTx: string | undefined;
    if (env.MONITOR_PRIVATE_KEY) {
      try {
        const account = privateKeyToAccount(env.MONITOR_PRIVATE_KEY as Hex);
        const w = createWalletClient({ account, chain: chainInfo(dep.chainId).chain, transport: http(chainInfo(dep.chainId).rpc) });
        evmTx = await w.writeContract({ address: guard, abi: kronosGuardAbi, functionName: "tightenOutflow", args: [asset, next] });
      } catch (e) {
        logger.warn({ err: String(e).slice(0, 200) }, "EVM tightenOutflow failed");
      }
    }
    await insertEvent(dep.chainId, {
      protocolId: p.id,
      kind: "tightened",
      txHash: evmTx ?? near.tx ?? null,
      logIndex: -1,
      asset,
      amount: next.toString(),
      data: { reason, from: cur.toString(), to: next.toString(), via: "monitor-key", near, evmTx: evmTx ?? null },
    });
  }
}

async function anomaly(dep: Deployment, p: Protocol, title: string, detail: Record<string, unknown>, tighten: boolean) {
  const recent = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.events)
    .where(and(eq(schema.events.protocolId, p.id), eq(schema.events.kind, "alert"), gte(schema.events.ts, new Date(Date.now() - 3600_000)), sql`data_json->>'title' = ${title}`));
  if ((recent[0]?.n ?? 0) > 0) return; // de-duplicate within an hour
  await insertEvent(dep.chainId, { protocolId: p.id, kind: "alert", txHash: null, logIndex: null, data: json({ title, ...detail }) });
  await sendAlert(p.name, title, detail, ((p.settings as { alerts?: AlertChannels }).alerts ?? {}) as AlertChannels);
  if (tighten) await tightenOnChain(dep, p, title);
}

async function processLog(dep: Deployment, p: Protocol, l: Log, state: TickState) {
  const addr = l.address.toLowerCase();
  const isGuard = addr === dep.guardAddress;
  const abi = isGuard ? kronosGuardAbi : guardTimelockAbi;
  let ev: { eventName: string; args: Record<string, unknown> };
  try {
    ev = decodeEventLog({ abi, data: l.data, topics: l.topics }) as never;
  } catch {
    return;
  }
  const base = { protocolId: p.id, txHash: l.transactionHash, logIndex: l.logIndex };
  const a = ev.args;
  switch (ev.eventName) {
    case "OutflowQueued":
      await insertEvent(dep.chainId, { ...base, kind: "queued", asset: String(a.asset).toLowerCase(), amount: String(a.amount), data: json({ claimId: String(a.id), to: a.to, releaseAt: a.releaseAt }) });
      break;
    case "OutflowReleased":
      await insertEvent(dep.chainId, { ...base, kind: "released", asset: String(a.asset).toLowerCase(), amount: String(a.amount), data: json({ claimId: String(a.id), reason: ["delay", "fresh attestation", "guardian"][Number(a.reason)] }) });
      break;
    case "ThresholdTightened":
      await insertEvent(dep.chainId, { ...base, kind: "tightened", asset: String(a.asset).toLowerCase(), amount: String(a.newThreshold), data: json(a) });
      break;
    case "IntentExecuted":
      state.intents.push({ kind: KIND_NAMES[Number(a.kind)], signer: String(a.signer).toLowerCase(), amount: BigInt(a.amount as bigint), asset: String(a.asset).toLowerCase() });
      break;
    case "ActionQueued": {
      const sel = String(a.selector);
      const tier = Number(a.tier);
      await db
        .insert(schema.adminActions)
        .values({
          protocolId: p.id,
          chainId: dep.chainId,
          actionId: Number(a.id),
          target: String(a.target).toLowerCase(),
          selector: sel,
          functionName: SELECTORS.get(sel) ?? null,
          tier,
          eta: new Date(Number(a.eta) * 1000),
          proposer: String(a.proposer).toLowerCase(),
          txHash: l.transactionHash,
        })
        .onConflictDoNothing();
      await insertEvent(dep.chainId, { ...base, kind: "admin_queued", data: json({ actionId: a.id, tier, selector: sel, functionName: SELECTORS.get(sel) ?? null, eta: a.eta }) });
      if (tier >= 2) state.tier2.push({ functionName: SELECTORS.get(sel) ?? sel, actionId: Number(a.id) });
      break;
    }
    case "ActionCancelled":
      await db
        .update(schema.adminActions)
        .set({ status: "cancelled" })
        .where(and(eq(schema.adminActions.protocolId, p.id), eq(schema.adminActions.chainId, dep.chainId), eq(schema.adminActions.actionId, Number(a.id))));
      await insertEvent(dep.chainId, { ...base, kind: "admin_cancelled", data: json(a) });
      break;
    case "ActionExecuted":
      await db
        .update(schema.adminActions)
        .set({ status: "executed" })
        .where(and(eq(schema.adminActions.protocolId, p.id), eq(schema.adminActions.chainId, dep.chainId), eq(schema.adminActions.actionId, Number(a.id))));
      await insertEvent(dep.chainId, { ...base, kind: "admin_executed", data: json(a) });
      break;
    case "TightenExecuted":
      await insertEvent(dep.chainId, { ...base, kind: "tightened", data: json({ ...a, functionName: SELECTORS.get(String(a.selector)) ?? null }) });
      break;
    case "RoleSet":
      if (a.enabled) state.newSigners.push(String(a.account).toLowerCase());
      break;
  }
}

interface TickState {
  intents: { kind: string; signer: string; amount: bigint; asset: string }[];
  tier2: { functionName: string; actionId: number }[];
  newSigners: string[];
}

async function watch(dep: Deployment, p: Protocol) {
  const c = publicClient(dep.chainId);
  const head = await c.getBlockNumber();
  // Start ~100 blocks back on a fresh deployment (never below block 0); after a chain reset (a local node
  // restarted, a testnet regenesis) the stored cursor is ahead of the head: rewind instead of stalling.
  const start = (n: bigint) => (n > 100n ? n - 100n : 0n);
  let from = dep.lastBlock === null || dep.lastBlock === undefined ? start(head) : BigInt(dep.lastBlock) + 1n;
  if (from > head + 1n) from = start(head);
  if (from > head) return;
  const to = head - from > MAX_RANGE ? from + MAX_RANGE : head;
  const state: TickState = { intents: [], tier2: [], newSigners: [] };
  const addresses = [dep.guardAddress, dep.timelockAddress].filter(Boolean) as Address[];
  const logs = await c.getLogs({ address: addresses, fromBlock: from, toBlock: to });
  for (const l of logs) await processLog(dep, p, l, state);

  // Reverted calls into the guard = blocked actions (scan only small ranges to bound RPC usage).
  if (to - from <= 200n) {
    for (let b = from; b <= to; b++) {
      const block = await c.getBlock({ blockNumber: b, includeTransactions: true });
      for (const tx of block.transactions) {
        if (typeof tx === "string" || tx.to?.toLowerCase() !== dep.guardAddress) continue;
        const rc = await c.getTransactionReceipt({ hash: tx.hash });
        if (rc.status !== "reverted") continue;
        const err = await decodeRevert(dep.chainId, { to: tx.to as Address, input: tx.input, from: tx.from, blockNumber: b });
        if (!err) continue;
        const fn = SELECTORS.get(tx.input.slice(0, 10)) ?? tx.input.slice(0, 10);
        await insertEvent(dep.chainId, { protocolId: p.id, kind: "blocked", txHash: tx.hash, logIndex: -1, invariantId: err.name, data: json({ function: fn, error: err.name, args: err.args, from: tx.from }) });
      }
    }
  }
  from = to;
  await db.update(schema.deployments).set({ lastBlock: Number(to) }).where(eq(schema.deployments.id, dep.id));

  // ---- anomaly flags
  const since = new Date(Date.now() - 7 * 86400_000);
  if (state.tier2.length) {
    const signerEvents = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.events)
      .where(and(eq(schema.events.protocolId, p.id), gte(schema.events.ts, since), sql`data_json->>'title' = 'New signer added'`));
    if (state.newSigners.length || (signerEvents[0]?.n ?? 0) > 0) {
      await anomaly(dep, p, "New signer followed by a Tier 2 change", { tier2: state.tier2, newSigners: state.newSigners }, true);
    }
  }
  if (state.newSigners.length) await anomaly(dep, p, "New signer added", { signers: state.newSigners }, false);
  // Borrows concentrated on a collateral that is still on probation (newly listed or oracle just changed).
  const borrows = state.intents.filter((i) => i.kind === "Borrow");
  if (borrows.length) {
    try {
      const guard = dep.guardAddress as Address;
      const params = (await c.readContract({ address: guard, abi: kronosGuardAbi, functionName: "params" })) as readonly bigint[];
      const nowTs = BigInt(Math.floor(Date.now() / 1000));
      const onProbation = new Map<string, number>();
      for (const b of borrows) {
        const acc = (await c.readContract({ address: guard, abi: guardedMiniLendAbi, functionName: "accounts", args: [b.signer as Address] })) as readonly [Address, bigint, bigint];
        const m = (await c.readContract({ address: guard, abi: guardedMiniLendAbi, functionName: "markets", args: [acc[0]] })) as readonly unknown[];
        const listedAt = BigInt(m[6] as bigint);
        if (nowTs - listedAt < params[4]) onProbation.set(acc[0], (onProbation.get(acc[0]) ?? 0) + 1);
      }
      for (const [asset, n] of onProbation) {
        if (n >= 3) await anomaly(dep, p, "Borrows concentrated on an asset still on probation", { asset, borrows: n }, true);
      }
    } catch {
      /* protocol without the compound-v2-style getters: skip this flag */
    }
  }
  const outflows = state.intents.filter((i) => i.kind === "Withdraw" || i.kind === "Borrow");
  const bySize = new Map<string, Set<string>>();
  for (const o of outflows) {
    const k = `${o.asset}:${o.amount}`;
    bySize.set(k, (bySize.get(k) ?? new Set()).add(o.signer));
  }
  for (const [k, signers] of bySize) {
    if (signers.size >= 5) await anomaly(dep, p, "Many same-sized outflows from different accounts", { key: k, accounts: signers.size }, true);
  }
}

export function startMonitor(): () => void {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const rows = await db
        .select({ dep: schema.deployments, protocol: schema.protocols })
        .from(schema.deployments)
        .innerJoin(schema.protocols, eq(schema.protocols.id, schema.deployments.protocolId))
        .where(and(eq(schema.deployments.verified, true), sql`${schema.protocols.status} in ('live','paused')`));
      for (const r of rows) {
        await watch(r.dep, r.protocol).catch((e) => logger.warn({ err: String(e).slice(0, 300), deployment: r.dep.id }, "monitor tick failed"));
      }
    } catch (e) {
      logger.warn({ err: String(e) }, "monitor loop error");
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), env.MONITOR_INTERVAL_MS);
  void tick();
  logger.info("monitor started");
  return () => {
    stopped = true;
    clearInterval(t);
  };
}
