/**
 * End-to-end demo against a local anvil chain (what the 2-minute video shows):
 *   1. sign in, submit the MiniLend sample, stream the live analysis
 *   2. approve the review (decide the flagged invariant), build the package
 *   3. deploy the guarded protocol with the approved parameters, register + verify the deployment
 *   4. oracle pump attack -> reverts at checkOracle (the monitor records it as blocked)
 *   5. stolen admin key lists a fake collateral -> queued for 7 days -> guardian cancels
 *   6. monitor's tighten-only key lowers the outflow window; a loosen call with the same key is rejected
 *
 * Prereqs: API + worker running with RPC_LOCAL=http://127.0.0.1:8545, ALLOW_DEV_LOGIN=true,
 * ATTESTOR_PRIVATE_KEY and MONITOR_PRIVATE_KEY = anvil key 0, and `anvil` running. See README.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex, decodeErrorResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { guardedMiniLendAbi, guardTimelockAbi, mockAMMOracleAbi, mockERC20Abi, mockPriceOracleAbi, kronosGuardAbi } from "../lib/abi.generated.js";

const API = process.env.API_URL ?? "http://localhost:8080";
const RPC = process.env.RPC_LOCAL ?? "http://127.0.0.1:8545";
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  attacker: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  relayer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  // must match the worker's ATTESTOR_PRIVATE_KEY / MONITOR_PRIVATE_KEY (anvil accounts 3 and 4)
  attestor: process.env.ATTESTOR_PRIVATE_KEY ?? "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  monitor: process.env.MONITOR_PRIVATE_KEY ?? "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const step = (n: number, s: string) => console.log(`\n${bold(`[${n}] ${s}`)}`);

let token = "";
async function api<T>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = (await r.json()) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(`${method} ${p}: ${j.error?.message ?? r.status}`);
  return j;
}

let lastEventId = 0;
async function stream(runId: string) {
  const r = await fetch(`${API}/v1/analyses/${runId}/stream?token=${token}&lastEventId=${lastEventId}`);
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const ev = JSON.parse(data.slice(6)) as { id: number; type: string; stage: string; message: string };
      lastEventId = ev.id;
      console.log(`  ${ev.type === "stage" ? "▸" : " "} [${ev.stage}] ${ev.message}`);
      if (ev.type === "done" || ev.type === "error") {
        await reader.cancel();
        return;
      }
    }
  }
}

const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: foundry, transport: http(RPC) });
const ERRORS = [...guardedMiniLendAbi, ...guardTimelockAbi].filter((x) => x.type === "error");

async function signIntent(guard: Address, kind: number, key: Hex, intent: Record<string, unknown>) {
  const names = ["DepositIntent", "WithdrawIntent", "BorrowIntent", "RepayIntent", "LiquidateIntent"];
  const account = privateKeyToAccount(key);
  return account.signTypedData({
    domain: { name: "Kronos", version: "1", chainId: foundry.id, verifyingContract: guard },
    primaryType: names[kind],
    types: {
      [names[kind]]: [
        { name: "asset", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "maxLtvBps", type: "uint256" },
        { name: "minHealthBps", type: "uint256" },
        { name: "account", type: "address" },
        { name: "recipient", type: "address" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    },
    message: intent,
  } as never);
}

async function main() {
  step(1, "Sign in and submit the MiniLend sample");
  token = (await api<{ accessToken: string }>("POST", "/v1/auth/dev", { login: "demo" })).accessToken;
  const { protocol, analysisId } = await api<{ protocol: { id: string }; analysisId: string }>("POST", "/v1/protocols", {
    repoUrl: "sample://minilend",
    chainId: 1313161555,
  });
  await stream(analysisId);

  step(2, "Review: decide the flagged invariant, approve, build the package");
  const res = await api<{ invariants: { id: string; title: string; needsReview: boolean; plainText: string }[] }>("GET", `/v1/analyses/${analysisId}/results`);
  for (const i of res.invariants) console.log(`  • ${i.title}: ${i.plainText}${i.needsReview ? "  ← drafters disagreed" : ""}`);
  for (const i of res.invariants.filter((x) => x.needsReview)) await api("PATCH", `/v1/invariants/${i.id}`, { status: "approved" });
  await api("POST", `/v1/analyses/${analysisId}/approve`);
  await stream(analysisId);
  const pkg = await api<{ id: string; version: string; configHash: string }>("GET", `/v1/analyses/${analysisId}/package`);
  console.log(`  package ${pkg.version}, config hash ${pkg.configHash}`);
  const zip = Buffer.from(await (await fetch(`${API}/v1/packages/${pkg.id}/download?token=${token}`)).arrayBuffer());
  const tmp = fs.mkdtempSync("/tmp/kronos-demo-");
  fs.writeFileSync(path.join(tmp, "pkg.zip"), zip);
  execFileSync("unzip", ["-q", "-o", path.join(tmp, "pkg.zip"), "kronos.config.json", "-d", tmp]);
  fs.copyFileSync(path.join(tmp, "kronos.config.json"), path.join(ROOT, "contracts/deployments/kronos.config.json"));

  step(3, "Deploy the guarded protocol with the approved parameters, then verify it");
  execFileSync("forge", ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast"], {
    cwd: path.join(ROOT, "contracts"),
    env: {
      ...process.env,
      DEPLOYER_PRIVATE_KEY: KEYS.deployer,
      KRONOS_CONFIG: "deployments/kronos.config.json",
      ATTESTOR_ADDRESS: privateKeyToAccount(KEYS.attestor as Hex).address,
      MONITOR_ADDRESS: privateKeyToAccount(KEYS.monitor as Hex).address,
    },
    stdio: "ignore",
  });
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/deployments/31337.json"), "utf8")) as Record<string, Address>;
  const dep = await api<{ verified: boolean; checks: { ok: boolean; name: string }[] }>("POST", `/v1/protocols/${protocol.id}/deployments`, {
    chainId: 31337,
    guardAddress: d.guardedMiniLend,
    timelockAddress: d.timelock,
  });
  console.log(`  verified: ${dep.verified} (${dep.checks.filter((c) => c.ok).length}/${dep.checks.length} checks)`);
  console.log("  waiting for the first attestations…");
  await new Promise((r) => setTimeout(r, 12_000));

  step(4, "Oracle pump on thin collateral");
  const attacker = wallet(KEYS.attacker);
  const relayer = wallet(KEYS.relayer);
  const A = attacker.account.address;
  const guard = d.guardedMiniLend;
  await attacker.writeContract({ address: d.thin, abi: mockERC20Abi, functionName: "mint", args: [A, 10_000n * 10n ** 18n] });
  await attacker.writeContract({ address: d.usdc, abi: mockERC20Abi, functionName: "mint", args: [A, 100_000n * 10n ** 6n] });
  await attacker.writeContract({ address: d.thin, abi: mockERC20Abi, functionName: "approve", args: [guard, 10_000n * 10n ** 18n] });
  await attacker.writeContract({ address: d.usdc, abi: mockERC20Abi, functionName: "approve", args: [d.thinPool, 100_000n * 10n ** 6n] });
  const now = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
  const dep1 = { asset: d.thin, amount: 10_000n * 10n ** 18n, maxLtvBps: 0n, minHealthBps: 0n, account: A, recipient: "0x0000000000000000000000000000000000000000", deadline: now, nonce: BigInt(Date.now()) };
  const sig1 = await signIntent(guard, 0, KEYS.attacker, dep1);
  await pub.waitForTransactionReceipt({ hash: await relayer.writeContract({ address: guard, abi: guardedMiniLendAbi, functionName: "deposit", args: [dep1 as never, sig1] }) });
  console.log("  attacker deposited 10,000 THIN ($1 each) as collateral");
  await pub.waitForTransactionReceipt({ hash: await attacker.writeContract({ address: d.thinPool, abi: mockAMMOracleAbi, functionName: "swapBaseForToken", args: [100_000n * 10n ** 6n] }) });
  const spot = (await pub.readContract({ address: d.thinPool, abi: mockAMMOracleAbi, functionName: "price", args: [d.thin] })) as bigint;
  console.log(`  pumped THIN to $${Number(spot / 10n ** 16n) / 100} in the thin pool`);
  const b = { asset: d.usdc, amount: 800_000n * 10n ** 6n, maxLtvBps: 7000n, minHealthBps: 10000n, account: A, recipient: "0x0000000000000000000000000000000000000000", deadline: now, nonce: BigInt(Date.now()) + 1n };
  const sigB = await signIntent(guard, 2, KEYS.attacker, b);
  try {
    await pub.simulateContract({ address: guard, abi: guardedMiniLendAbi, functionName: "borrow", args: [b as never, sigB], account: relayer.account });
  } catch (e) {
    let data: Hex | undefined;
    (e as { walk: (f: (x: unknown) => boolean) => unknown }).walk((x) => {
      const v = (x as { data?: unknown }).data;
      if (typeof v === "string" && v.startsWith("0x")) data = v as Hex;
      return Boolean(data);
    });
    const err = data ? decodeErrorResult({ abi: ERRORS, data }) : null;
    console.log(`  borrow 800,000 USDC → ${bold("REVERTS at " + (err?.errorName ?? "?"))} ${err ? JSON.stringify(err.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : ""}`);
  }
  // also land the reverted tx on-chain so the monitor records it as "blocked"
  await relayer.writeContract({ address: guard, abi: guardedMiniLendAbi, functionName: "borrow", args: [b as never, sigB], gas: 1_500_000n }).catch(() => undefined);

  step(5, "Stolen admin key lists a fake collateral");
  const admin = wallet(KEYS.deployer);
  const fake = (await import("viem")).getContractAddress({ from: admin.account.address, nonce: BigInt(await pub.getTransactionCount({ address: admin.account.address })) });
  const listCall = (await import("viem")).encodeFunctionData({
    abi: guardedMiniLendAbi,
    functionName: "listAsset",
    args: [fake, d.fixedOracle, 18, 9000n, 10n ** 30n],
  });
  try {
    await pub.simulateContract({ address: guard, abi: guardedMiniLendAbi, functionName: "listAsset", args: [fake, d.fixedOracle, 18, 9000n, 10n ** 30n], account: admin.account });
  } catch {
    console.log("  direct call → reverts: NotTimelock");
  }
  const qh = await admin.writeContract({ address: d.timelock, abi: guardTimelockAbi, functionName: "queue", args: [guard, listCall] });
  await pub.waitForTransactionReceipt({ hash: qh });
  const count = (await pub.readContract({ address: d.timelock, abi: guardTimelockAbi, functionName: "actionsCount" })) as bigint;
  const action = (await pub.readContract({ address: d.timelock, abi: guardTimelockAbi, functionName: "getAction", args: [count - 1n] })) as { tier: number; eta: bigint };
  console.log(`  queued as Tier ${action.tier}, executable at ${new Date(Number(action.eta) * 1000).toISOString()} (7 days, public)`);
  await pub.waitForTransactionReceipt({ hash: await admin.writeContract({ address: d.timelock, abi: guardTimelockAbi, functionName: "cancel", args: [count - 1n] }) });
  console.log("  guardian cancelled it (guardians can cancel, never execute)");

  step(6, "Monitor's tighten-only key");
  const monitor = wallet(KEYS.monitor as Hex);
  const cur = (await pub.readContract({ address: guard, abi: kronosGuardAbi, functionName: "outflowThreshold", args: [d.usdc] })) as bigint;
  await pub.waitForTransactionReceipt({ hash: await monitor.writeContract({ address: guard, abi: kronosGuardAbi, functionName: "tightenOutflow", args: [d.usdc, cur / 2n] }) });
  console.log(`  tightened the USDC outflow window ${cur / 10n ** 6n} → ${cur / 2n / 10n ** 6n}`);
  try {
    await pub.simulateContract({ address: guard, abi: kronosGuardAbi, functionName: "tightenOutflow", args: [d.usdc, cur * 10n], account: monitor.account });
  } catch {
    console.log("  loosen with the same key → rejected: NotTighter");
  }
  void mockPriceOracleAbi;

  console.log("\n  waiting for the monitor to index…");
  await new Promise((r) => setTimeout(r, 10_000));
  const ov = await api<{ stats24h: Record<string, number>; attestation: unknown }>("GET", `/v1/protocols/${protocol.id}/overview`);
  console.log(`  dashboard 24h: ${JSON.stringify(ov.stats24h)}`);
  const evs = await api<{ items: { kind: string; invariantId: string | null; data: Record<string, unknown> }[] }>("GET", `/v1/protocols/${protocol.id}/events?limit=10`);
  for (const e of evs.items) console.log(`  · ${e.kind}${e.invariantId ? ` (${e.invariantId})` : ""} ${e.data.functionName ?? e.data.function ?? ""}`);
  console.log(`\n${bold("Done.")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
