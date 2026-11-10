import { encodeAbiParameters, keccak256, toFunctionSelector } from "viem";
import type { ContractModel, FnModel, ProtocolModel } from "../ast.js";
import type { KeyState } from "../agents/types.js";

/**
 * Package generator for the compound-v2-style adapter: renders GuardConfig.<Name>.sol (protocol getters
 * wired into the LendingInvariants templates) and Guarded<Name>.sol (every user entry point takes a signed
 * intent and carries `guarded(...)`; privileged setters are owned by the GuardTimelock).
 * The compiler and the attack library decide whether the result is correct.
 */

export interface GuardParams {
  protocolMinHealthBps: number;
  maxSharePriceDeltaBps: number;
  maxOracleDeviationBps: number;
  attestationMaxAgeBlocks: number;
  probationSeconds: number;
  adminMaxUnderwaterIncrease: number;
}

export interface InvariantDecision {
  template: string;
  params: Record<string, unknown>;
  status: "proposed" | "approved" | "rejected";
}

export const PARAM_ORDER: (keyof GuardParams)[] = [
  "protocolMinHealthBps",
  "maxSharePriceDeltaBps",
  "maxOracleDeviationBps",
  "attestationMaxAgeBlocks",
  "probationSeconds",
  "adminMaxUnderwaterIncrease",
];

const DISABLED = 2n ** 128n; // effectively "no limit" when an invariant is rejected

export function guardParamsFrom(invs: InvariantDecision[]): { params: GuardParams; disabled: Set<string> } {
  const on = (t: string) => invs.find((i) => i.template === t && i.status !== "rejected");
  const n = (t: string, k: string, d: number) => Number((on(t)?.params as Record<string, unknown> | undefined)?.[k] ?? d);
  const disabled = new Set(invs.filter((i) => i.status === "rejected").map((i) => i.template));
  return {
    params: {
      protocolMinHealthBps: on("account_health") ? n("account_health", "protocolMinHealthBps", 10_000) : 0,
      maxSharePriceDeltaBps: on("share_price") ? n("share_price", "maxSharePriceDeltaBps", 100) : Number(DISABLED),
      maxOracleDeviationBps: on("oracle_sanity") ? n("oracle_sanity", "maxOracleDeviationBps", 500) : Number(DISABLED),
      attestationMaxAgeBlocks: n("oracle_sanity", "attestationMaxAgeBlocks", 1800),
      probationSeconds: on("collateral_cap") ? n("collateral_cap", "probationSeconds", 7 * 86400) : 0,
      adminMaxUnderwaterIncrease: on("admin_underwater") ? n("admin_underwater", "adminMaxUnderwaterIncrease", 0) : Number(DISABLED),
    },
    disabled,
  };
}

/** Same as KronosGuard.kronosConfigHash(): keccak256(abi.encode(GuardParams)). */
export function configHash(p: GuardParams): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "tuple", components: PARAM_ORDER.map((k) => ({ name: k, type: "uint256" })) }],
      [Object.fromEntries(PARAM_ORDER.map((k) => [k, BigInt(p[k])])) as never],
    ),
  );
}

export interface GenInput {
  name: string; // protocol contract name, e.g. MiniLend
  core: ContractModel; // abstract base with internal logic
  coreImport: string; // import path of the core, relative to the generated directory
  model: ProtocolModel;
  keyState: KeyState;
  userEntrypoints: { fn: FnModel; kind: string }[];
  disabled: Set<string>;
}

export interface GenOutput {
  guardConfig: string;
  guarded: string;
  unresolved: string[];
  guardedFunctions: { name: string; kind: string }[];
  coreCtor: { name: string; type: string }[];
}

const LIB = "./lib";

function hookBody(f: FnModel, baseExpr: string): string | null {
  const ps = f.params.map((p) => p.type);
  const n = f.name.toLowerCase();
  if (/admin|owner|auth|governance/.test(n) && ps.length === 0) return "if (msg.sender != timelock) revert NotTimelock();";
  if (ps.join(",") === "address,address,uint256" && f.returns.length === 0) return `_breakerPayout(${f.params.map((p) => p.name).join(", ")});`;
  if (ps.join(",") === "address,uint256" && f.returns.length === 0 && /inflow|received|credit/.test(n)) return `_breakerInflow(${f.params.map((p) => p.name).join(", ")});`;
  if (/pending/.test(n) && f.returns.length === 1 && ps.length === 0) return `return pendingOutflow[${baseExpr}];`;
  return null;
}

function sig(f: FnModel, override = true): string {
  const params = f.params.map((p) => `${p.type}${/^(string|bytes)$|\[\]$/.test(p.type) ? " memory" : ""} ${p.name}`).join(", ");
  const rets = f.returns.length ? ` returns (${f.returns.map((r) => r.type).join(", ")})` : "";
  const mut = f.mutability === "nonpayable" ? "" : ` ${f.mutability}`;
  return `function ${f.name}(${params}) internal${mut}${override ? " override" : ""}${rets}`;
}

/** Maps the original external function's delegate call args onto intent fields. */
function mapArgs(fn: FnModel, kind: string): { args: string[]; extra: string[]; unresolved?: string } {
  if (!fn.delegate) return { args: [], extra: [], unresolved: `${fn.signature}: body is not a single internal call` };
  let senders = 0;
  const extra: string[] = [];
  const args = fn.delegate.args.map((a) => {
    if (a.text === "msg.sender") {
      senders++;
      if (senders === 1) return "_kronosSigner()";
      if (kind === "repay") return "intent.account";
      return "_kronosRecipient(intent)";
    }
    if (a.kind === "identifier") {
      const p = fn.params.find((x) => x.name === a.text);
      const nm = a.text.toLowerCase();
      if (p?.type === "address" && /borrower|account|user|onbehalf|owner/.test(nm)) return "intent.account";
      if (p?.type === "address" && /^(to|receiver|recipient)$/.test(nm)) return "_kronosRecipient(intent)";
      if (p?.type === "address") return "intent.asset";
      if (p && /^uint/.test(p.type)) return "intent.amount";
    }
    if (a.kind === "literal") return a.text;
    return `/* UNRESOLVED ${a.text} */`;
  });
  const hasAsset = fn.params.some((p) => p.type === "address" && !/borrower|account|user|onbehalf|owner|^(to|receiver|recipient)$/i.test(p.name));
  if (!hasAsset) extra.push("asset");
  const bad = args.find((x) => x.includes("UNRESOLVED"));
  return { args, extra, unresolved: bad ? `${fn.signature}: could not map ${bad}` : undefined };
}

export function generate(g: GenInput): GenOutput {
  const ks = g.keyState;
  const base = ks.baseAsset ?? "address(0)";
  const unresolved: string[] = [];
  const coreCtorFn = g.core.functions.find((f) => f.kind === "constructor");
  const coreCtor = coreCtorFn?.params ?? [];
  const ctorParams = coreCtor.map((p) => `${p.type} ${p.name}`);
  const ctorArgs = coreCtor.map((p) => p.name);

  const hooks = g.core.functions.filter((f) => f.kind === "function" && f.virtual && !f.implemented);
  const hookImpls = hooks.map((h) => {
    const body = hookBody(h, base);
    if (!body) unresolved.push(`hook ${h.signature} has no adapter rule`);
    return `    ${sig(h)} {\n        ${body ?? "revert(\"KRONOS: unresolved hook\");"}\n    }`;
  });

  const noOracle = g.disabled.has("oracle_sanity") && g.disabled.has("collateral_cap");
  const pricedBody =
    noOracle || !ks.accountCollateral
      ? "return new address[](0);"
      : `address c = ${ks.accountCollateral};
        if (c == address(0) || ${ks.accountDebt ?? "1"} == 0) return new address[](0);
        out = new address[](1);
        out[0] = c;`;

  const guardConfig = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KronosGuard} from "${LIB}/KronosGuard.sol";
import {IKronosERC20} from "${LIB}/interfaces/IKronosERC20.sol";
import {KronosSafeTransfer} from "${LIB}/KronosSafeTransfer.sol";
import {${g.core.name}} from "${g.coreImport}";

/// @title GuardConfig${g.name}
/// @notice GENERATED by Kronos (adapter: lending/compound-v2-style). Wires ${g.name}'s state getters into the
///         LendingInvariants templates. Approved parameters live in KronosGuard.params; kronosConfigHash()
///         must equal the approved package's config hash. Do not edit by hand: re-run the analysis instead.
abstract contract GuardConfig${g.name} is KronosGuard, ${g.core.name} {
    using KronosSafeTransfer for IKronosERC20;

    constructor(
        ${[...ctorParams, "address timelock_", "address registry_", "address guardian_", "address monitor_", "GuardParams memory p"].join(",\n        ")}
    ) KronosGuard(timelock_, registry_, guardian_, monitor_, p) ${g.core.name}(${ctorArgs.join(", ")}) {}

    // ---- protocol state -> invariant templates

    function _kronosBeforeAction() internal override {
        ${ks.accrue ? `${ks.accrue}();` : "// no interest accrual hook"}
    }

    function _kronosHealthBps(address a) internal view override returns (uint256) {
        return ${ks.health ? `${ks.health}(a)` : "type(uint256).max"};
    }

    function _kronosLtvBps(address a) internal view override returns (uint256) {
        ${ks.ltv ? `return ${ks.ltv}(a);` : "a;\n        return 0;"}
    }

    function _kronosTotalAssets() internal view override returns (uint256) {
        return ${ks.totalAssets ?? "type(uint256).max"};
    }

    function _kronosTotalLiabilities() internal view override returns (uint256) {
        return ${g.disabled.has("solvency") ? "0 /* solvency rejected in review */" : ks.totalLiabilities ?? "0"};
    }

    function _kronosSharePrice() internal view override returns (uint256) {
        return ${ks.sharePrice ?? "0"};
    }

    function _kronosBadDebt() internal view override returns (uint256) {
        return ${ks.badDebt ?? "0"};
    }

    function _kronosPricedAssets(address a) internal view override returns (address[] memory out) {
        ${pricedBody}
    }

    function _kronosSpotPrice(address asset) internal view override returns (uint256) {
        return ${ks.spotPrice ? `${ks.spotPrice}(asset)` : "0"};
    }

    function _kronosBorrowedAgainst(address asset) internal view override returns (uint256) {
        return ${ks.borrowedAgainst ? `${ks.borrowedAgainst}(asset)` : "0"};
    }

    function _kronosCollateralCap(address asset) internal view override returns (uint256) {
        return ${ks.collateralCap ?? "type(uint256).max"};
    }

    function _kronosListedAt(address asset) internal view override returns (uint256) {
        return ${ks.listedAt ?? "0"};
    }

    function _kronosAssetFrozen(address asset) internal view override returns (bool) {
        return ${ks.frozen ? `asset != ${base} && ${ks.frozen}` : "false"};
    }

    function _kronosUnderwaterDebt() internal view override returns (uint256) {
        return ${ks.underwaterDebt ?? "0"};
    }

    function _kronosListedAssets() internal view override returns (address[] memory) {
        return ${ks.listedAssets ?? "new address[](0)"};
    }

    // ---- protocol hooks routed through the guard (admin -> timelock, payouts -> OutflowBreaker)

${hookImpls.join("\n\n")}

    function _transferOut(address asset, address to, uint256 amount) internal override {
        IKronosERC20(asset).safeTransfer(to, amount);
    }
}
`;

  const KIND_ENUM: Record<string, string> = { deposit: "Deposit", withdraw: "Withdraw", borrow: "Borrow", repay: "Repay", liquidate: "Liquidate" };
  const guardedFunctions: { name: string; kind: string }[] = [];
  const fns = g.userEntrypoints
    .filter((e) => KIND_ENUM[e.kind])
    .map(({ fn, kind }) => {
      const m = mapArgs(fn, kind);
      if (m.unresolved) unresolved.push(m.unresolved);
      guardedFunctions.push({ name: fn.name, kind });
      const assetCheck = m.extra.includes("asset") && kind !== "repay" ? `        if (intent.asset != ${base}) revert KronosWrongAsset(intent.asset);\n` : "";
      return `    function ${fn.name}(Intent calldata intent, bytes calldata sig) external guarded(Kind.${KIND_ENUM[kind]}, intent, sig) {
${assetCheck}        ${fn.delegate?.callee ?? "/* unresolved */"}(${m.args.join(", ")});
    }`;
    });

  const guarded = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GuardConfig${g.name}} from "./GuardConfig.${g.name}.sol";

/// @title Guarded${g.name}
/// @notice GENERATED by Kronos. ${g.name} with every user entry point taking a signed EIP-712 intent and the
///         \`guarded(kind, intent, sig)\` modifier. Function bodies only use values from the signed intent, so a
///         hacked frontend or relayer can push values within the intent's limits but can't redirect funds.
///         Privileged setters inherited from ${g.core.name} are owned by the GuardTimelock.
contract Guarded${g.name} is GuardConfig${g.name} {
    error KronosWrongAsset(address asset);

    constructor(
        ${[...ctorParams, "address timelock_", "address registry_", "address guardian_", "address monitor_", "GuardParams memory p"].join(",\n        ")}
    ) GuardConfig${g.name}(${[...ctorArgs, "timelock_", "registry_", "guardian_", "monitor_", "p"].join(", ")}) {}

${fns.join("\n\n")}
}
`;
  return { guardConfig, guarded, unresolved, guardedFunctions, coreCtor };
}

/** Foundry deploy script for the package. */
export function deployScript(
  name: string,
  coreCtor: { name: string; type: string }[],
  params: GuardParams,
  tiers: { signature: string; tier: number }[],
  thresholds: { asset: string; threshold: string; staleLimit: string }[],
): string {
  const ctorReads = coreCtor.map((p) => {
    const env = `CTOR_${p.name.replace(/_$/, "").replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
    if (p.type === "address") return `vm.envAddress("${env}")`;
    if (p.type === "bool") return `vm.envBool("${env}")`;
    if (/^uint\d+$/.test(p.type) && p.type !== "uint256") return `${p.type}(vm.envUint("${env}"))`;
    return `vm.envUint("${env}")`;
  });
  const sels = tiers.map((t) => {
    let s = "0x00000000";
    try {
      s = toFunctionSelector(`function ${t.signature}`);
    } catch {
      /* ignore */
    }
    return { s, t: t.tier, sig: t.signature };
  });
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {KronosGuard} from "../src/kronos/lib/KronosGuard.sol";
import {GuardTimelock} from "../src/kronos/lib/GuardTimelock.sol";
import {AttestationRegistry} from "../src/kronos/lib/AttestationRegistry.sol";
import {Guarded${name}} from "../src/kronos/Guarded${name}.sol";

/// GENERATED by Kronos. Deploys GuardTimelock + AttestationRegistry + Guarded${name} with the approved
/// parameters, installs the approved tier table and outflow thresholds, then closes setup.
/// Env: DEPLOYER_PRIVATE_KEY, ATTESTOR_ADDRESS, GUARDIAN_ADDRESS, MONITOR_ADDRESS, COSIGNER_ADDRESS,
///      ${coreCtor.map((p) => `CTOR_${p.name.replace(/_$/, "").replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`).join(", ") || "(no constructor args)"}
contract DeployKronos is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);
        address[] memory admins = new address[](1);
        admins[0] = me;
        address[] memory guardians = new address[](1);
        guardians[0] = vm.envOr("GUARDIAN_ADDRESS", me);
        address[] memory cosigners = new address[](1);
        cosigners[0] = vm.envOr("COSIGNER_ADDRESS", me);
        GuardTimelock timelock = new GuardTimelock(admins, admins, guardians, cosigners, 1);
        AttestationRegistry registry = new AttestationRegistry(address(timelock), vm.envOr("ATTESTOR_ADDRESS", me));
        KronosGuard.GuardParams memory p = KronosGuard.GuardParams({
${PARAM_ORDER.map((k) => `            ${k}: ${BigInt(params[k]).toString()}`).join(",\n")}
        });
        Guarded${name} guard = new Guarded${name}(
            ${[...ctorReads, "address(timelock)", "address(registry)", "guardians[0]", 'vm.envOr("MONITOR_ADDRESS", me)', "p"].join(",\n            ")}
        );

        bytes4[] memory sels = new bytes4[](${sels.length});
        uint8[] memory tiers = new uint8[](${sels.length});
${sels.map((x, i) => `        sels[${i}] = ${x.s}; tiers[${i}] = ${x.t}; // ${x.sig}`).join("\n")}
        timelock.setupTiers(address(guard), sels, tiers);
${thresholds
  .map(
    (t) =>
      `        timelock.setupCall(address(guard), abi.encodeCall(KronosGuard.setOutflowThreshold, (${t.asset.startsWith("0x") ? t.asset : `vm.envAddress("${t.asset}")`}, ${t.threshold}, ${t.staleLimit})));`,
  )
  .join("\n")}
        // Add your initial market listings here with timelock.setupCall(...) before closing setup.
        timelock.finalizeSetup(address(guard));
        vm.stopBroadcast();

        console2.log("Guarded${name}", address(guard));
        console2.log("GuardTimelock", address(timelock));
        console2.log("AttestationRegistry", address(registry));
        console2.logBytes32(guard.kronosConfigHash());
    }
}
`;
}
