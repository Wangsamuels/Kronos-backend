import { decodeErrorResult, encodeFunctionData, parseAbiItem, type AbiFunction, type AbiParameter, type Address, type Hex, toFunctionSelector } from "viem";
import { publicClient } from "./chains.js";
import { guardTimelockAbi, guardedMiniLendAbi, kronosGuardAbi } from "./abi.generated.js";

const ERRORS = [...guardedMiniLendAbi, ...kronosGuardAbi, ...guardTimelockAbi].filter((x) => x.type === "error");
const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, "").slice(0, 200);

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PackageManifestForVerify {
  configHash: Hex;
  guardedFunctions: { name: string; kind: string }[];
  privileged: { signature: string; selector: Hex; tier: number }[];
}

const INTENT_TUPLE: AbiParameter = {
  type: "tuple",
  name: "intent",
  components: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "maxLtvBps", type: "uint256" },
    { name: "minHealthBps", type: "uint256" },
    { name: "account", type: "address" },
    { name: "recipient", type: "address" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

const PROBE = "0x000000000000000000000000000000000000dEaD" as Address;

function zeroFor(p: AbiParameter): unknown {
  const t = p.type;
  if (t.endsWith("]")) return [];
  if (t === "address") return "0x0000000000000000000000000000000000000001";
  if (t === "bool") return false;
  if (t.startsWith("uint") || t.startsWith("int")) return 1n;
  if (t === "bytes" || t === "string") return t === "bytes" ? "0x" : "";
  if (t.startsWith("bytes")) return `0x${"00".repeat(Number(t.slice(5)))}`;
  if (t === "tuple") return Object.fromEntries((p as unknown as { components: readonly AbiParameter[] }).components.map((c) => [c.name, zeroFor(c)]));
  return 0n;
}

async function reverts(chainId: number, to: Address, data: Hex, from: Address = PROBE): Promise<{ reverted: boolean; reason: string }> {
  try {
    await publicClient(chainId).call({ to, data, account: from });
    return { reverted: false, reason: "call succeeded" };
  } catch (e) {
    let data: Hex | undefined;
    (e as { walk?: (fn: (x: unknown) => boolean) => unknown }).walk?.((x) => {
      const d = (x as { data?: unknown })?.data;
      if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
        data = d as Hex;
        return true;
      }
      return false;
    });
    if (data) {
      try {
        return { reverted: true, reason: `reverted: ${decodeErrorResult({ abi: ERRORS, data }).errorName}` };
      } catch {
        return { reverted: true, reason: `reverted with ${data.slice(0, 10)}` };
      }
    }
    return { reverted: true, reason: clean((e as { shortMessage?: string }).shortMessage ?? String(e)) };
  }
}

/**
 * Verification before going live (POST /protocols/:id/deployments):
 *  1. the deployed guard's on-chain config hash matches the approved package
 *  2. every mapped entry point reverts without a valid intent (proves the modifier is wired in)
 *  3. the timelock owns every privileged role and its tier table matches the package; setup is closed
 */
export async function verifyDeployment(
  chainId: number,
  guard: Address,
  timelock: Address | null,
  m: PackageManifestForVerify,
): Promise<{ verified: boolean; checks: Check[]; timelock: Address | null; registry: Address | null; block: bigint }> {
  const c = publicClient(chainId);
  const checks: Check[] = [];
  const block = await c.getBlockNumber();

  const code = await c.getCode({ address: guard });
  if (!code || code === "0x") {
    return { verified: false, checks: [{ name: "contract exists", ok: false, detail: "no bytecode at guard address" }], timelock, registry: null, block };
  }

  let onchainHash: Hex | null = null;
  try {
    onchainHash = (await c.readContract({ address: guard, abi: kronosGuardAbi, functionName: "kronosConfigHash" })) as Hex;
  } catch {
    /* not a Kronos guard */
  }
  checks.push({
    name: "config hash matches approved package",
    ok: onchainHash?.toLowerCase() === m.configHash.toLowerCase(),
    detail: `on-chain ${onchainHash ?? "unavailable"} / package ${m.configHash}`,
  });

  const zeroIntent = zeroFor(INTENT_TUPLE);
  for (const f of m.guardedFunctions) {
    const abiItem: AbiFunction = {
      type: "function",
      name: f.name,
      stateMutability: "nonpayable",
      inputs: [INTENT_TUPLE, { name: "sig", type: "bytes" }],
      outputs: [],
    };
    const data = encodeFunctionData({ abi: [abiItem], functionName: f.name, args: [zeroIntent, "0x"] as never });
    const r = await reverts(chainId, guard, data);
    checks.push({ name: `${f.name}() reverts without a valid intent`, ok: r.reverted, detail: r.reason });
  }

  let tl = timelock;
  try {
    const owner = (await c.readContract({ address: guard, abi: kronosGuardAbi, functionName: "kronosTimelock" })) as Address;
    if (!tl) tl = owner;
    checks.push({ name: "guard is owned by the timelock", ok: owner.toLowerCase() === tl.toLowerCase(), detail: `kronosTimelock() = ${owner}` });
  } catch (e) {
    checks.push({ name: "guard is owned by the timelock", ok: false, detail: String(e).slice(0, 160) });
  }

  if (tl) {
    try {
      const fin = (await c.readContract({ address: tl, abi: guardTimelockAbi, functionName: "finalized", args: [guard] })) as boolean;
      checks.push({ name: "timelock setup closed", ok: fin, detail: fin ? "finalizeSetup() called" : "setup still open: call finalizeSetup(guard)" });
    } catch (e) {
      checks.push({ name: "timelock setup closed", ok: false, detail: String(e).slice(0, 160) });
    }
    for (const p of m.privileged) {
      let fn: AbiFunction;
      try {
        fn = parseAbiItem(`function ${p.signature}`) as AbiFunction;
      } catch {
        checks.push({ name: `${p.signature} tier`, ok: false, detail: "unparseable signature" });
        continue;
      }
      const sel = toFunctionSelector(fn);
      let tier: number | null = null;
      try {
        tier = Number(await c.readContract({ address: tl, abi: guardTimelockAbi, functionName: "tierOf", args: [guard, sel] }));
      } catch {
        /* unknown selector */
      }
      checks.push({
        name: `${fn.name} routed through timelock at tier ${p.tier}`,
        ok: tier === p.tier,
        detail: tier === null ? "selector not registered in timelock" : `tierOf = ${tier}`,
      });
      const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: fn.inputs.map(zeroFor) as never });
      const r = await reverts(chainId, guard, data);
      checks.push({ name: `${fn.name} rejects direct calls`, ok: r.reverted, detail: r.reason });
    }
  }

  let registry: Address | null = null;
  try {
    registry = (await c.readContract({ address: guard, abi: kronosGuardAbi, functionName: "registry" })) as Address;
  } catch {
    /* ignore */
  }
  return { verified: checks.every((x) => x.ok), checks, timelock: tl, registry, block };
}
