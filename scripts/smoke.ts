/**
 * Testnet smoke test: proves a live Kronos deployment works, without spending real gas.
 *
 *   npm run smoke -- 1313161555      (Aurora testnet)
 *   npm run smoke -- 84532           (Base Sepolia)
 *
 * 1. Read-only checks against the live chain: code, config hash, timelock ownership, attestation freshness.
 * 2. Starts an anvil fork of the live chain (state copied, nothing broadcast) and runs, against the
 *    real deployed contracts:
 *      - a normal user: deposit WETH, borrow within bounds          -> must succeed
 *      - oracle pump on THIN, then a large borrow                     -> must revert (CheckOracleFailed)
 *      - stolen admin key lists a fake collateral                     -> direct call reverts; timelock queues it (Tier 2, 7 days)
 *      - the monitor key tries to LOOSEN the outflow window           -> must revert (NotTighter)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  parseEther,
  publicActions,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { guardedMiniLendAbi, guardTimelockAbi, kronosGuardAbi, mockAMMOracleAbi, mockERC20Abi, attestationRegistryAbi } from "../lib/abi.generated.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC: Record<string, string> = {
  "1313161555": process.env.RPC_AURORA_TESTNET ?? "https://testnet.aurora.dev",
  "84532": process.env.RPC_BASE_SEPOLIA ?? "https://sepolia.base.org",
};
const ERRORS = [...guardedMiniLendAbi, ...guardTimelockAbi].filter((x) => x.type === "error");
// anvil's default funded account #1 (exists on any anvil fork; worthless on real chains)
const USER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
// Guarded calls get explicit gas headroom (an exact eth_estimateGas result ran out of gas on an Aurora fork).
const GAS = 1_500_000n;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass++;
  console.log(`  ✓ ${m}`);
};
const bad = (m: string) => {
  fail++;
  console.log(`  ✗ ${m}`);
};

function revertName(e: unknown): string {
  let data: Hex | undefined;
  (e as { walk?: (f: (x: unknown) => boolean) => unknown }).walk?.((x) => {
    const v = (x as { data?: unknown }).data;
    if (typeof v === "string" && v.startsWith("0x") && v.length >= 10) data = v as Hex;
    return Boolean(data);
  });
  if (!data) return "reverted";
  try {
    return decodeErrorResult({ abi: ERRORS, data }).errorName;
  } catch {
    return data.slice(0, 10);
  }
}

async function main() {
  const chainId = process.argv[2];
  if (!RPC[chainId]) throw new Error("usage: npm run smoke -- <1313161555|84532>");
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts", "deployments", `${chainId}.json`), "utf8")) as Record<string, Address>;
  const guard = d.guardedMiniLend;
  const live = createPublicClient({ transport: http(RPC[chainId]) });

  console.log(`\n[1] Live chain ${chainId}, read-only`);
  const code = await live.getCode({ address: guard });
  code && code.length > 2 ? ok(`GuardedMiniLend has code at ${guard}`) : bad("no code at the guard address");
  const hash = await live.readContract({ address: guard, abi: kronosGuardAbi, functionName: "kronosConfigHash" });
  hash === d.configHash ? ok(`config hash matches the approved package (${hash.slice(0, 10)}…)`) : bad(`config hash ${hash} != ${d.configHash}`);
  const tl = await live.readContract({ address: guard, abi: kronosGuardAbi, functionName: "kronosTimelock" });
  tl.toLowerCase() === d.timelock.toLowerCase() ? ok("guard is owned by the GuardTimelock") : bad("guard timelock mismatch");
  const att = await live.readContract({ address: d.registry, abi: attestationRegistryAbi, functionName: "latest", args: [guard] });
  const head = await live.getBlockNumber();
  if (att.blockNumber === 0n) bad("no attestation yet: is the deployment registered and the worker running with ATTESTOR_PRIVATE_KEY?");
  else {
    const age = Number(head - att.blockNumber);
    const maxAge = (await live.readContract({ address: guard, abi: kronosGuardAbi, functionName: "params" }))[3];
    const fresh = await live.readContract({ address: d.registry, abi: attestationRegistryAbi, functionName: "isFresh", args: [guard, maxAge] });
    fresh ? ok(`attestation is fresh (${age}/${maxAge} blocks old, posted ${Math.round((Date.now() / 1000 - Number(att.timestamp)) / 60)} min ago, oracleOk=${att.oracleOk}, solvencyOk=${att.solvencyOk})`)
      : bad(`attestation is stale (${age}/${maxAge} blocks old, posted ${Math.round((Date.now() / 1000 - Number(att.timestamp)) / 60)} min ago)`);
  }

  console.log(`\n[2] Attacks on an anvil fork of chain ${chainId} (nothing is broadcast)`);
  const port = 18000 + Math.floor(Math.random() * 1000);
  const anvil = spawn("anvil", ["--fork-url", RPC[chainId], "--port", String(port), "--auto-impersonate", "--silent"], { stdio: "ignore" });
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
      try {
        await createPublicClient({ transport: http(url) }).getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const fork = createTestClient({ chain: { ...foundry, id: Number(chainId) }, mode: "anvil", transport: http(url) }).extend(publicActions);
    const user = privateKeyToAccount(USER_KEY);
    const w = createWalletClient({ account: user, chain: { ...foundry, id: Number(chainId) }, transport: http(url) });
    const as = (addr: Address) => createWalletClient({ account: addr, chain: { ...foundry, id: Number(chainId) }, transport: http(url) });
    await fork.setBalance({ address: user.address, value: parseEther("100") });
    const send = async (p: Promise<Hex>) => fork.waitForTransactionReceipt({ hash: await p });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    let nonce = BigInt(Date.now());
    const sign = (kind: number, m: Record<string, unknown>) =>
      user.signTypedData({
        domain: { name: "Kronos", version: "1", chainId: Number(chainId), verifyingContract: guard },
        primaryType: ["DepositIntent", "WithdrawIntent", "BorrowIntent", "RepayIntent", "LiquidateIntent"][kind],
        types: {
          [["DepositIntent", "WithdrawIntent", "BorrowIntent", "RepayIntent", "LiquidateIntent"][kind]]: [
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
        message: m,
      } as never);
    const intent = (asset: Address, amount: bigint, maxLtvBps = 0n, minHealthBps = 0n) => ({
      asset,
      amount,
      maxLtvBps,
      minHealthBps,
      account: user.address,
      recipient: ZERO,
      deadline,
      nonce: nonce++,
    });

    // normal user
    try {
      await send(w.writeContract({ address: d.weth, abi: mockERC20Abi, functionName: "mint", args: [user.address, parseEther("10")] }));
      await send(w.writeContract({ address: d.weth, abi: mockERC20Abi, functionName: "approve", args: [guard, parseEther("10")] }));
      const dep = intent(d.weth, parseEther("10"));
      await send(w.writeContract({ address: guard, abi: guardedMiniLendAbi, functionName: "deposit", args: [dep as never, await sign(0, dep)], gas: GAS }));
      const b = intent(d.usdc, 1_000n * 10n ** 6n, 7000n, 11000n);
      const sig = await sign(2, b);
      const est = await fork.estimateContractGas({ address: guard, abi: guardedMiniLendAbi, functionName: "borrow", args: [b as never, sig], account: user.address });
      const r = await send(w.writeContract({ address: guard, abi: guardedMiniLendAbi, functionName: "borrow", args: [b as never, sig], gas: GAS }));
      const bal = await fork.readContract({ address: d.usdc, abi: mockERC20Abi, functionName: "balanceOf", args: [user.address] });
      if (process.env.SMOKE_DEBUG) console.log(`    estimate ${est}, used ${r.gasUsed}`);
      r.status === "success" && bal >= 1_000n * 10n ** 6n
        ? ok(`normal user: deposit 10 WETH + borrow 1,000 USDC with a signed intent succeeds (${r.gasUsed} gas)`)
        : bad("normal borrow failed");
    } catch (e) {
      bad(`normal user flow failed: ${revertName(e)}`);
    }

    // oracle pump
    try {
      const thin = 10_000n * 10n ** 18n;
      await send(w.writeContract({ address: d.thin, abi: mockERC20Abi, functionName: "mint", args: [user.address, thin] }));
      await send(w.writeContract({ address: d.usdc, abi: mockERC20Abi, functionName: "mint", args: [user.address, 100_000n * 10n ** 6n] }));
      await send(w.writeContract({ address: d.thin, abi: mockERC20Abi, functionName: "approve", args: [guard, thin] }));
      await send(w.writeContract({ address: d.usdc, abi: mockERC20Abi, functionName: "approve", args: [d.thinPool, 100_000n * 10n ** 6n] }));
      const p = await fork.readContract({ address: d.thinPool, abi: mockAMMOracleAbi, functionName: "price", args: [d.thin] });
      await send(w.writeContract({ address: d.thinPool, abi: mockAMMOracleAbi, functionName: "swapBaseForToken", args: [100_000n * 10n ** 6n] }));
      const p2 = await fork.readContract({ address: d.thinPool, abi: mockAMMOracleAbi, functionName: "price", args: [d.thin] });
      console.log(`    THIN pumped from $${Number(p) / 1e18} to $${(Number(p2) / 1e18).toFixed(2)}`);
      // the user already has WETH collateral; use a second account for THIN
      const attKey = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex; // anvil #3
      const att = privateKeyToAccount(attKey);
      const aw = createWalletClient({ account: att, chain: { ...foundry, id: Number(chainId) }, transport: http(url) });
      await fork.setBalance({ address: att.address, value: parseEther("10") });
      await send(w.writeContract({ address: d.thin, abi: mockERC20Abi, functionName: "transfer", args: [att.address, 1_000n * 10n ** 18n] }));
      await send(aw.writeContract({ address: d.thin, abi: mockERC20Abi, functionName: "approve", args: [guard, 1_000n * 10n ** 18n] }));
      const signAs = (kind: number, m: Record<string, unknown>) =>
        att.signTypedData({
          domain: { name: "Kronos", version: "1", chainId: Number(chainId), verifyingContract: guard },
          primaryType: ["DepositIntent", "WithdrawIntent", "BorrowIntent"][kind],
          types: {
            [["DepositIntent", "WithdrawIntent", "BorrowIntent"][kind]]: [
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
          message: m,
        } as never);
      const dep = { ...intent(d.thin, 1_000n * 10n ** 18n), account: att.address };
      await send(aw.writeContract({ address: guard, abi: guardedMiniLendAbi, functionName: "deposit", args: [dep as never, await signAs(0, dep)], gas: GAS }));
      const b = { ...intent(d.usdc, 50_000n * 10n ** 6n, 7000n, 10000n), account: att.address };
      try {
        await fork.simulateContract({ address: guard, abi: guardedMiniLendAbi, functionName: "borrow", args: [b as never, await signAs(2, b)], account: att.address });
        bad("oracle pump borrow was NOT blocked");
      } catch (e) {
        const n = revertName(e);
        n === "CheckOracleFailed" || n === "CheckCapFailed" ? ok(`oracle pump: borrowing against pumped THIN reverts at ${n}`) : bad(`oracle pump reverted with unexpected ${n}`);
      }
    } catch (e) {
      bad(`oracle pump setup failed: ${revertName(e)}`);
    }

    // fake collateral via stolen admin key
    try {
      const admin = (process.env.DEPLOYER_ADDRESS as Address | undefined) ?? (await fork.readContract({ address: guard, abi: kronosGuardAbi, functionName: "guardian" }));
      const fake = "0x000000000000000000000000000000000000fa4e" as Address;
      try {
        await fork.simulateContract({ address: guard, abi: guardedMiniLendAbi, functionName: "listAsset", args: [fake, d.fixedOracle, 18, 9000n, 10n ** 30n], account: admin });
        bad("direct listAsset with the admin key succeeded");
      } catch (e) {
        ok(`stolen admin key: direct listAsset reverts (${revertName(e)})`);
      }
      const call = encodeFunctionData({ abi: guardedMiniLendAbi, functionName: "listAsset", args: [fake, d.fixedOracle, 18, 9000n, 10n ** 30n] });
      await fork.setBalance({ address: admin, value: parseEther("1") });
      await send(as(admin).writeContract({ address: d.timelock, abi: guardTimelockAbi, functionName: "queue", args: [guard, call] }));
      const n = await fork.readContract({ address: d.timelock, abi: guardTimelockAbi, functionName: "actionsCount" });
      const a = await fork.readContract({ address: d.timelock, abi: guardTimelockAbi, functionName: "getAction", args: [n - 1n] });
      const blk = await fork.getBlock();
      const days = Number(a.eta - blk.timestamp) / 86400;
      a.tier === 2 && days >= 6.9 ? ok(`listing a new collateral is queued as Tier ${a.tier}, executable in ${days.toFixed(1)} days`) : bad(`unexpected tier ${a.tier} / ${days} days`);
      try {
        await fork.simulateContract({ address: d.timelock, abi: guardTimelockAbi, functionName: "execute", args: [n - 1n], account: admin });
        bad("queued listing executed before its ETA");
      } catch (e) {
        ok(`executing before the ETA reverts (${revertName(e)})`);
      }
    } catch (e) {
      bad(`timelock check failed: ${revertName(e)}`);
    }

    // monitor can't loosen
    try {
      const monitor = await fork.readContract({ address: guard, abi: kronosGuardAbi, functionName: "monitor" });
      const cur = await fork.readContract({ address: guard, abi: kronosGuardAbi, functionName: "outflowThreshold", args: [d.usdc] });
      try {
        await fork.simulateContract({ address: guard, abi: kronosGuardAbi, functionName: "tightenOutflow", args: [d.usdc, cur * 10n], account: monitor });
        bad("monitor key loosened the outflow window");
      } catch (e) {
        ok(`monitor key: loosening the outflow window reverts (${revertName(e)})`);
      }
      await fork.simulateContract({ address: guard, abi: kronosGuardAbi, functionName: "tightenOutflow", args: [d.usdc, cur / 2n], account: monitor });
      ok("monitor key: tightening the outflow window is allowed");
    } catch (e) {
      bad(`monitor check failed: ${revertName(e)}`);
    }
  } finally {
    anvil.kill("SIGKILL");
  }

  console.log(`\n${fail === 0 ? "All checks passed" : `${fail} check(s) failed`} (${pass} passed).`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
