import { parseAbiItem, type Address } from "viem";
import { publicClient, chainInfo } from "../lib/chains.js";
import { env } from "../lib/env.js";
import { run } from "./util/exec.js";
import type { RunLogger } from "../lib/events.js";

/**
 * On-chain history: outflow thresholds from the protocol's own Transfer history (99.9th percentile of
 * daily net outflow) and a replay of recent real transactions on an anvil fork.
 */
export interface Thresholds {
  source: "history" | "default";
  note: string;
  assets: { asset: string; symbol?: string; threshold: string; staleLimit: string; p999DailyNetOutflow?: string; daysObserved?: number }[];
  windowHours: 24;
  releaseDelaySeconds: number;
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export function percentile(values: bigint[], p: number): bigint {
  if (!values.length) return 0n;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)];
}

export async function computeThresholds(
  chainId: number,
  protocolAddresses: string[],
  baseAsset: Address | null,
  decimals: number,
  log: RunLogger,
): Promise<Thresholds> {
  const unit = 10n ** BigInt(decimals);
  const fallback: Thresholds = {
    source: "default",
    note: "No on-chain history available; template defaults (200k / 100k base units). Recalibrate after 14 days live.",
    assets: [{ asset: baseAsset ?? "BASE_ASSET", threshold: (200_000n * unit).toString(), staleLimit: (100_000n * unit).toString() }],
    windowHours: 24,
    releaseDelaySeconds: 6 * 3600,
  };
  if (!baseAsset || protocolAddresses.length === 0) return fallback;
  try {
    const c = publicClient(chainId);
    const head = await c.getBlockNumber();
    const block = await c.getBlock({ blockNumber: head });
    const older = await c.getBlock({ blockNumber: head > 10_000n ? head - 10_000n : 0n });
    const secPerBlock = Math.max(0.2, Number(block.timestamp - older.timestamp) / Number(head - older.number || 1n));
    const days = 30;
    const span = BigInt(Math.floor((days * 86400) / secPerBlock));
    const from = head > span ? head - span : 0n;
    const daily = new Map<number, bigint>();
    const step = 5_000n;
    let fetched = 0;
    for (const addr of protocolAddresses) {
      for (let b = from; b <= head; b += step) {
        const to = b + step - 1n > head ? head : b + step - 1n;
        const [outs, ins] = await Promise.all([
          c.getLogs({ address: baseAsset, event: TRANSFER, args: { from: addr as Address }, fromBlock: b, toBlock: to }),
          c.getLogs({ address: baseAsset, event: TRANSFER, args: { to: addr as Address }, fromBlock: b, toBlock: to }),
        ]);
        for (const l of outs) {
          const day = Math.floor(Number(l.blockNumber) * secPerBlock / 86400);
          daily.set(day, (daily.get(day) ?? 0n) + (l.args.value ?? 0n));
        }
        for (const l of ins) {
          const day = Math.floor(Number(l.blockNumber) * secPerBlock / 86400);
          daily.set(day, (daily.get(day) ?? 0n) - (l.args.value ?? 0n));
        }
        fetched += outs.length + ins.length;
      }
    }
    if (daily.size < 3) {
      await log.info(`Only ${daily.size} days of transfer history; using template defaults`);
      return fallback;
    }
    const nets = [...daily.values()].map((v) => (v > 0n ? v : 0n));
    const p999 = percentile(nets, 99.9);
    const threshold = p999 > 0n ? (p999 * 12n) / 10n : 200_000n * unit; // 20% headroom over p99.9
    await log.info(`Calibrated from ${fetched} transfers over ${daily.size} days: p99.9 daily net outflow = ${p999 / unit}`);
    return {
      source: "history",
      note: `p99.9 of ${daily.size} days of real daily net outflow, +20% headroom`,
      assets: [
        {
          asset: baseAsset,
          threshold: threshold.toString(),
          staleLimit: (threshold / 2n).toString(),
          p999DailyNetOutflow: p999.toString(),
          daysObserved: daily.size,
        },
      ],
      windowHours: 24,
      releaseDelaySeconds: 6 * 3600,
    };
  } catch (e) {
    await log.warn(`History calibration failed (${String(e).slice(0, 120)}); using defaults`);
    return fallback;
  }
}

/** Replays the most recent real transactions to the protocol on an anvil fork (normal traffic must pass). */
export async function forkReplay(chainId: number, addresses: string[], log: RunLogger, max = 25) {
  const info = chainInfo(chainId);
  if (!info.explorerApi || addresses.length === 0) return null;
  const txs: { hash: string; from: string; to: string; input: string; value: string; blockNumber: string; isError: string }[] = [];
  for (const a of addresses) {
    const u = new URL(info.explorerApi.url);
    if (info.explorerApi.kind === "etherscan-v2") u.searchParams.set("chainid", String(chainId));
    u.searchParams.set("module", "account");
    u.searchParams.set("action", "txlist");
    u.searchParams.set("address", a);
    u.searchParams.set("sort", "desc");
    u.searchParams.set("page", "1");
    u.searchParams.set("offset", String(max));
    if (env.ETHERSCAN_API_KEY && info.explorerApi.kind === "etherscan-v2") u.searchParams.set("apikey", env.ETHERSCAN_API_KEY);
    try {
      const body = (await (await fetch(u, { signal: AbortSignal.timeout(20_000) })).json()) as { result: typeof txs | string };
      if (Array.isArray(body.result)) txs.push(...body.result.filter((t) => t.isError === "0" && t.to?.toLowerCase() === a.toLowerCase()));
    } catch {
      /* ignore */
    }
  }
  if (!txs.length) return null;
  const sorted = txs.sort((x, y) => Number(x.blockNumber) - Number(y.blockNumber)).slice(-max);
  const forkBlock = Number(sorted[0].blockNumber) - 1;
  const port = 18545 + Math.floor(Math.random() * 1000);
  await log.info(`Replaying ${sorted.length} recent transactions on an anvil fork at block ${forkBlock}`);
  const { spawn } = await import("node:child_process");
  const anvil = spawn(env.ANVIL_BIN, ["--fork-url", info.rpc, "--fork-block-number", String(forkBlock), "--port", String(port), "--silent", "--auto-impersonate"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 4000));
    const rpc = `http://127.0.0.1:${port}`;
    let pass = 0;
    const results: { hash: string; ok: boolean }[] = [];
    for (const t of sorted) {
      const r = await run(
        "cast",
        ["send", "--rpc-url", rpc, "--unlocked", "--from", t.from, t.to, t.input, "--value", t.value, "--json"],
        { timeoutMs: 60_000 },
      );
      const ok = r.code === 0 && /"status":"0x1"/.test(r.stdout);
      if (ok) pass++;
      results.push({ hash: t.hash, ok });
    }
    return { total: sorted.length, pass, forkBlock, results };
  } finally {
    anvil.kill("SIGKILL");
  }
}
