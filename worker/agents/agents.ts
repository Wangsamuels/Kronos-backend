import { llmJson, type LlmResult } from "../../lib/llm.js";
import { allFunctions, concreteContracts, entryFunctions, type ContractModel, type FnModel, type ProtocolModel } from "../ast.js";
import {
  Classification,
  DrafterOutput,
  MapperOutput,
  RedTeamOutput,
  TierOutput,
  USER_KINDS,
  type InvariantDraft,
  type KeyState,
} from "./types.js";
import { TEMPLATES, ATTACK_LIBRARY } from "../templates/library.js";

/**
 * Specialist agents. Each one has an LLM implementation (through llm.ts) and a deterministic heuristic
 * implementation used by the `heuristic` provider and as a fallback. Agents only *propose*: the
 * verifier (compiler, fork tests, attack replays) decides what is true, and humans approve.
 */

// ------------------------------------------------------------------ prompt context

export function modelSummary(model: ProtocolModel, maxBody = 400): string {
  const lines: string[] = [];
  for (const c of model.contracts) {
    if (c.kind === "interface") continue;
    lines.push(`${c.abstract ? "abstract " : ""}${c.kind} ${c.name}${c.bases.length ? ` is ${c.bases.join(", ")}` : ""}  // ${c.file}`);
    for (const v of c.stateVars.slice(0, 40)) lines.push(`  state ${v.type} ${v.visibility} ${v.name}`);
    for (const m of c.modifiers) lines.push(`  modifier ${m.name}`);
    for (const f of c.functions) {
      if (f.kind !== "function") continue;
      lines.push(
        `  fn ${f.signature} ${f.visibility} ${f.mutability}${f.virtual ? " virtual" : ""}${f.modifiers.length ? ` [${f.modifiers.join(",")}]` : ""}${
          f.accessControlled ? " ACCESS-CONTROLLED" : ""
        }`,
      );
      if (maxBody && f.body && (f.visibility === "external" || f.visibility === "public" || f.name.startsWith("_"))) {
        lines.push(`    body: ${f.body.replace(/\s+/g, " ").slice(0, maxBody)}`);
      }
    }
  }
  return lines.join("\n").slice(0, 60_000);
}

// ------------------------------------------------------------------ 1. classification

export function classifyHeuristic(model: ProtocolModel): Classification {
  const names = model.contracts.flatMap((c) => c.functions.map((f) => f.name.toLowerCase()));
  const has = (re: RegExp) => names.some((n) => re.test(n));
  const reasons: string[] = [];
  let score = 0;
  for (const [re, label] of [
    [/borrow/, "borrow"],
    [/repay/, "repay"],
    [/liquidat/, "liquidation"],
    [/collateral/, "collateral"],
    [/health|ltv/, "health factor / LTV"],
    [/deposit|supply|mint/, "deposit"],
    [/withdraw|redeem/, "withdraw"],
  ] as const) {
    if (has(re)) {
      score++;
      reasons.push(`has ${label} functions`);
    }
  }
  if (has(/borrow/) && has(/repay/) && score >= 4) return { type: "lending", confidence: Math.min(1, score / 7), reasons };
  if (has(/bridge|relay|lockandmint|outboundtransfer|sendmessage/)) return { type: "bridge", confidence: 0.7, reasons: ["bridge-like functions"] };
  if (has(/swap|addliquidity/)) return { type: "dex", confidence: 0.6, reasons: ["swap / liquidity functions"] };
  return { type: "other", confidence: 0.4, reasons: reasons.length ? reasons : ["no lending signature found"] };
}

export async function classify(runId: string, model: ProtocolModel) {
  return llmJson({
    runId,
    agent: "classifier",
    system: "You classify smart-contract protocols. Lending = users post collateral and borrow against it, with liquidations.",
    prompt: `Classify this protocol.\n\n${modelSummary(model, 0)}`,
    schema: Classification,
    heuristic: () => classifyHeuristic(model),
  });
}

// ------------------------------------------------------------------ 2. mapper

const KIND_RULES: [RegExp, MapperOutput["entrypoints"][number]["kind"]][] = [
  [/^(lower|decrease|reduce)(collateralfactor|ltv|cf)/i, "lowerCollateralFactor"],
  [/^(lower|decrease|reduce).*cap/i, "lowerCap"],
  [/^(set|update)(collateralfactor|ltv|cf)/i, "setCollateralFactor"],
  [/^(set|update|raise).*cap/i, "setCap"],
  [/oracle|pricefeed/i, "setOracle"],
  [/^(list|add|support|init)(asset|market|reserve|collateral)/i, "listAsset"],
  [/^unpause|^resume/i, "unpause"],
  [/^pause|^halt/i, "pause"],
  [/^unfreeze/i, "unfreeze"],
  [/^freeze/i, "freeze"],
  [/upgrade|implementation/i, "upgrade"],
  [/role|owner|admin|guardian|signer/i, "setRole"],
  [/rate|interest|fee|reservefactor/i, "setRate"],
  [/flash/i, "flashloan"],
  [/liquidat/i, "liquidate"],
  [/^repay/i, "repay"],
  [/^borrow/i, "borrow"],
  [/^(withdraw|redeem)/i, "withdraw"],
  [/^(deposit|supply|mint)/i, "deposit"],
];

function kindOf(f: FnModel): MapperOutput["entrypoints"][number]["kind"] {
  for (const [re, k] of KIND_RULES) if (re.test(f.name)) return k;
  return "other";
}

function findFn(fns: FnModel[], re: RegExp, opts: { view?: boolean } = {}): FnModel | undefined {
  return fns.find((f) => re.test(f.name) && (!opts.view || f.mutability === "view" || f.mutability === "pure"));
}

function keyStateHeuristic(model: ProtocolModel, c: ContractModel): KeyState {
  const fns = allFunctions(model, c);
  const vars = [c, ...c.bases.map((b) => model.contracts.find((x) => x.name === b)!)].filter(Boolean).flatMap((x) => x.stateVars);
  const varNamed = (re: RegExp) => vars.find((v) => re.test(v.name));
  const ks: KeyState = {};
  const base = vars.find((v) => /^(base|underlying|asset|baseToken)$/i.test(v.name));
  if (base) ks.baseAsset = `address(${base.name})`;
  const accrue = findFn(fns, /^accrue(interest)?$/i);
  if (accrue) ks.accrue = accrue.name;
  const health = findFn(fns, /health/i, { view: true });
  if (health) ks.health = health.name;
  const ltv = findFn(fns, /^ltv/i, { view: true });
  if (ltv) ks.ltv = ltv.name;
  const cash = findFn(fns, /^(cash|getcash)$/i, { view: true });
  const borrows = findFn(fns, /^totalborrows$/i, { view: true }) ?? (varNamed(/^totalBorrows$/) ? ({ name: "totalBorrows" } as FnModel) : undefined);
  if (cash && borrows) ks.totalAssets = `${cash.name}() + ${borrows.name}()`;
  const liab = varNamed(/^(totalDeposits|totalSupplyAssets|totalLiabilities)$/);
  if (liab) ks.totalLiabilities = liab.name;
  const rate = findFn(fns, /^(exchangerate|shareprice|pricepershare)/i, { view: true });
  if (rate) ks.sharePrice = `${rate.name}()`;
  const bad = varNamed(/^badDebt$/i);
  ks.badDebt = bad ? bad.name : "0";
  const price = findFn(fns, /^(priceof|getprice|getassetprice)$/i, { view: true });
  if (price) ks.spotPrice = price.name;
  const against = findFn(fns, /borrowedagainst|debtbycollateral/i, { view: true });
  if (against) ks.borrowedAgainst = against.name;
  const markets = vars.find((v) => /^(markets|reserves|assets)$/.test(v.name) && v.type.startsWith("mapping"));
  if (markets) {
    ks.collateralCap = `${markets.name}[asset].cap`;
    ks.listedAt = `${markets.name}[asset].listedAt`;
    ks.frozen = `${markets.name}[asset].frozen`;
  }
  const list = vars.find((v) => /^(marketList|assetList|reservesList|allMarkets)$/.test(v.name) && v.type.endsWith("[]"));
  if (list) ks.listedAssets = list.name;
  const uw = findFn(fns, /underwater/i, { view: true });
  if (uw) ks.underwaterDebt = `${uw.name}()`;
  const accts = vars.find((v) => /^accounts$/.test(v.name) && v.type.startsWith("mapping"));
  if (accts) {
    ks.accountCollateral = `${accts.name}[a].collateralAsset`;
    ks.accountDebt = `${accts.name}[a].debtNorm`;
  }
  return ks;
}

export function mapHeuristic(model: ProtocolModel): MapperOutput {
  const concretes = concreteContracts(model);
  // main protocol contract: the one with the most user-facing lending entry points
  const scored = concretes
    .map((c) => ({ c, n: entryFunctions(model, c).filter((f) => USER_KINDS.has(kindOf(f))).length }))
    .sort((a, b) => b.n - a.n);
  const main = scored[0]?.c ?? model.contracts[0];
  const entrypoints = entryFunctions(model, main)
    .filter((f) => f.name !== "accrue")
    .map((f) => {
      const kind = kindOf(f);
      const role: "user" | "privileged" = f.accessControlled ? "privileged" : USER_KINDS.has(kind) ? "user" : f.accessControlled ? "privileged" : "user";
      return {
        contract: f.contract,
        signature: f.signature,
        kind,
        role,
        notes: f.delegate ? `delegates to ${f.delegate.callee}(${f.delegate.args.map((a) => a.text).join(", ")})` : undefined,
      };
    });
  // core: the abstract base that implements the internal logic the entry points delegate to
  const delegated = new Set(
    entryFunctions(model, main)
      .map((f) => f.delegate?.callee)
      .filter(Boolean) as string[],
  );
  const core =
    main.bases
      .map((b) => model.contracts.find((c) => c.name === b))
      .find((c) => c && c.functions.some((f) => delegated.has(f.name) && f.visibility === "internal"))?.name ?? null;
  const keyState = keyStateHeuristic(model, main);
  const required: (keyof KeyState)[] = ["health", "totalAssets", "totalLiabilities", "sharePrice", "spotPrice", "borrowedAgainst", "collateralCap", "listedAt", "accountCollateral"];
  const userKinds = new Set(entrypoints.filter((e) => e.role === "user").map((e) => e.kind));
  const adapter =
    core && required.every((k) => keyState[k]) && ["deposit", "withdraw", "borrow", "repay"].every((k) => userKinds.has(k as never))
      ? "compound-v2-style"
      : "generic";
  return { protocolContract: main.name, coreContract: core, adapter, entrypoints, keyState };
}

export async function mapProtocol(runId: string, model: ProtocolModel): Promise<LlmResult<MapperOutput>> {
  const h = mapHeuristic(model);
  const res = await llmJson({
    runId,
    agent: "mapper",
    system:
      "You map lending protocols for a security guard. List every external state-changing entry point of the main protocol contract, label it user or privileged, give its kind, and locate key state (Solidity expressions valid inside a contract that inherits the protocol core).",
    prompt: `Protocol model:\n${modelSummary(model)}\n\nA deterministic pre-pass produced:\n${JSON.stringify(h)}\nCorrect it where wrong and fill gaps. Keep signatures exactly as in the model.`,
    schema: MapperOutput,
    heuristic: () => h,
  });
  // Hard rule: anything the AST shows as access-controlled is privileged, whatever the model said.
  const acl = new Set(model.contracts.flatMap((c) => c.functions.filter((f) => f.accessControlled).map((f) => f.signature)));
  res.data.entrypoints = res.data.entrypoints.map((e) => (acl.has(e.signature) ? { ...e, role: "privileged" as const } : e));
  return res;
}

// ------------------------------------------------------------------ 3. intent schemas

const FIELDS = [
  { name: "asset", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "maxLtvBps", type: "uint256" },
  { name: "minHealthBps", type: "uint256" },
  { name: "account", type: "address" },
  { name: "recipient", type: "address" },
  { name: "deadline", type: "uint256" },
  { name: "nonce", type: "uint256" },
];

export function intentTypeName(kind: string) {
  return `${kind[0].toUpperCase()}${kind.slice(1)}Intent`;
}

export function schemaFor(kind: string, chainId: number, cfBps?: number) {
  const primaryType = intentTypeName(kind === "flashloan" ? "flashLoan" : kind);
  const eip712 = {
    domain: { name: "Kronos", version: "1", chainId, verifyingContract: "<guard address>" },
    primaryType,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      [primaryType]: FIELDS,
    },
  };
  const maxLtv = kind === "borrow" ? Math.max(1000, (cfBps ?? 8000) - 1000) : 0;
  const bounds = {
    amount: "user-chosen; the action can never exceed it",
    maxLtvBps: maxLtv,
    minHealthBps: kind === "borrow" || kind === "withdraw" ? 11_000 : 0,
    recipient: "signer unless named explicitly",
    account: kind === "liquidate" ? "the borrower being liquidated" : "must equal the signer",
    deadlineSeconds: 1800,
    nonce: "unordered, single use",
  };
  const plain: Record<string, string> = {
    deposit: "Deposit exactly {amount} {asset} into your own position.",
    withdraw: "Withdraw up to {amount} {asset} to you; your health factor stays at or above {minHealth}.",
    borrow: "Borrow {amount} {asset} to you; your LTV stays at or below {maxLtv} and health at or above {minHealth}.",
    repay: "Repay up to {amount} {asset} of your own debt.",
    liquidate: "Repay {amount} of {account}'s debt and receive their {asset} collateral at the liquidation bonus.",
    flashloan: "Flash-borrow {amount} {asset}; it must be repaid in the same transaction.",
  };
  return { eip712, bounds, plainText: `${plain[kind] ?? "Perform this action"} Valid for 30 minutes, single use.` };
}

// ------------------------------------------------------------------ 4. invariant drafters A and B

export function draftHeuristic(slot: "A" | "B", map: MapperOutput, chainId: number, gap?: string[]): InvariantDraft[] {
  const blockTime = chainId === 84532 ? 2 : 1; // Base ~2s, Aurora ~1s
  const tightened = new Set(gap ?? []);
  const out: InvariantDraft[] = [];
  const ks = map.keyState;
  if (ks.health) out.push({ template: "account_health", title: TEMPLATES.account_health.title, params: { protocolMinHealthBps: 10_000 }, rationale: `health getter ${ks.health}` });
  if (ks.totalAssets && ks.totalLiabilities)
    out.push({ template: "solvency", title: TEMPLATES.solvency.title, params: {}, rationale: `assets = ${ks.totalAssets}; liabilities = ${ks.totalLiabilities}` });
  if (ks.sharePrice)
    out.push({
      template: "share_price",
      title: TEMPLATES.share_price.title,
      params: { maxSharePriceDeltaBps: tightened.has("share_price") ? 50 : 100 },
      rationale: `exchange rate ${ks.sharePrice}; interest accrues before the snapshot so normal traffic moves it < 0.01%`,
    });
  if (ks.spotPrice) {
    // Drafter B is more conservative on oracle deviation because thin-liquidity collateral is listable.
    const dev = tightened.has("oracle_sanity") ? 200 : slot === "A" ? 500 : 300;
    out.push({
      template: "oracle_sanity",
      title: TEMPLATES.oracle_sanity.title,
      params: { maxOracleDeviationBps: dev, twapWindowSeconds: 1800, minSources: 2, attestationMaxAgeBlocks: Math.round(1800 / blockTime) },
      rationale:
        slot === "A"
          ? "template default: 5% band around the attested 30-min TWAP"
          : "per-asset oracles are admin-settable and may be thin AMM pools; a 3% band leaves less room for a pump",
    });
  }
  if (ks.borrowedAgainst && ks.collateralCap)
    out.push({
      template: "collateral_cap",
      title: TEMPLATES.collateral_cap.title,
      params: { probationSeconds: slot === "A" ? 7 * 86400 : 7 * 86400 },
      rationale: `borrowed-against ${ks.borrowedAgainst}, cap ${ks.collateralCap}, probation ramp from ${ks.listedAt ?? "listing time"}`,
    });
  if (ks.underwaterDebt)
    out.push({ template: "admin_underwater", title: TEMPLATES.admin_underwater.title, params: { adminMaxUnderwaterIncrease: 0 }, rationale: "privileged changes may not push any healthy account underwater" });
  return out;
}

export async function draftInvariants(runId: string, slot: "A" | "B", model: ProtocolModel, map: MapperOutput, chainId: number, gap?: string[]) {
  const lib = Object.entries(TEMPLATES)
    .map(([k, t]) => `- ${k}: ${t.title}. params: ${JSON.stringify(t.defaults)}`)
    .join("\n");
  return llmJson({
    runId,
    agent: `drafter-${slot}`,
    slot,
    system:
      slot === "A"
        ? "You are invariant drafter A. Fill the vetted template slots for this lending protocol. Prefer template defaults unless the code gives a reason."
        : "You are invariant drafter B, an independent and skeptical reviewer. Fill the vetted template slots, calibrating parameters conservatively from the code (oracle sources, listing powers, rounding).",
    prompt: `Template library:\n${lib}\n\nMapping:\n${JSON.stringify(map)}\n\nProtocol:\n${modelSummary(model, 250)}${
      gap?.length ? `\n\nRED TEAM FOUND GAPS in: ${gap.join(", ")}. Tighten those invariants.` : ""
    }`,
    schema: DrafterOutput,
    heuristic: () => ({ invariants: draftHeuristic(slot, map, chainId, gap) }),
  });
}

export interface MergedInvariant extends InvariantDraft {
  drafters: string[];
  needsReview: boolean;
  disagreement?: { A?: unknown; B?: unknown };
}

const STRICTER_LOWER = new Set(["maxSharePriceDeltaBps", "maxOracleDeviationBps", "adminMaxUnderwaterIncrease", "attestationMaxAgeBlocks"]);

/** Keep everything both drafters agree on; flag disagreements (defaulting to the stricter value). */
export function mergeDrafts(a: InvariantDraft[], b: InvariantDraft[]): MergedInvariant[] {
  const out: MergedInvariant[] = [];
  const byB = new Map(b.map((d) => [d.template, d]));
  for (const da of a) {
    const db = byB.get(da.template);
    byB.delete(da.template);
    if (!db) {
      out.push({ ...da, drafters: ["A"], needsReview: true, disagreement: { A: da.params, B: "not proposed" } });
      continue;
    }
    const params: Record<string, number | string | boolean> = { ...db.params, ...da.params };
    let differs = false;
    for (const k of new Set([...Object.keys(da.params), ...Object.keys(db.params)])) {
      const va = da.params[k];
      const vb = db.params[k];
      if (va !== undefined && vb !== undefined && va !== vb) {
        differs = true;
        if (typeof va === "number" && typeof vb === "number") params[k] = STRICTER_LOWER.has(k) ? Math.min(va, vb) : Math.max(va, vb);
      }
    }
    out.push({
      ...da,
      params,
      rationale: differs ? `A: ${da.rationale} | B: ${db.rationale}` : da.rationale,
      drafters: ["A", "B"],
      needsReview: differs,
      disagreement: differs ? { A: da.params, B: db.params } : undefined,
    });
  }
  for (const db of byB.values()) out.push({ ...db, drafters: ["B"], needsReview: true, disagreement: { A: "not proposed", B: db.params } });
  return out;
}

// ------------------------------------------------------------------ 5. tier classifier

export const TIER_DELAYS = [0, 48 * 3600, 7 * 86400, 14 * 86400];

export function tierHeuristic(kind: string, name: string): { tier: number; rationale: string } {
  if (["pause", "freeze", "lowerCap", "lowerCollateralFactor"].includes(kind)) return { tier: 0, rationale: "tighten-only: instant via guardian" };
  if (["setRate", "unpause", "unfreeze"].includes(kind)) return { tier: 1, rationale: "routine parameter change" };
  if (["listAsset", "setOracle", "setCap", "setCollateralFactor"].includes(kind)) return { tier: 2, rationale: "adds risk: new collateral, oracle or looser limits" };
  if (["upgrade", "setRole"].includes(kind)) return { tier: 3, rationale: "guard, upgrade or signer change" };
  if (/threshold|delay|guard|registry|monitor/i.test(name)) return { tier: 3, rationale: "changes guard configuration" };
  return { tier: 2, rationale: "unknown privileged function: defaults to risk-adding" };
}

/** Hard rules override the agent. Returns the enforced minimum tier, if any. */
export function hardRule(kind: string, name: string): { min: number; rationale: string } | null {
  if (kind === "upgrade" || /upgrade|implementation/i.test(name)) return { min: 3, rationale: "upgrades are always Tier 3" };
  if (kind === "setRole" || /signer|owner|admin|guardian|role/i.test(name)) return { min: 3, rationale: "signer / role changes are always Tier 3" };
  if (kind === "setOracle" || /oracle|pricefeed/i.test(name)) return { min: 2, rationale: "an oracle change is always at least Tier 2" };
  if (!/^(lower|decrease|reduce|pause|freeze|halt|disable)/i.test(name)) return { min: 1, rationale: "only explicit tighten functions may be Tier 0" };
  return null;
}

export async function classifyTiers(runId: string, privileged: { signature: string; kind: string }[]) {
  const res = await llmJson({
    runId,
    agent: "tier-classifier",
    system:
      "Assign each privileged function a timelock tier. 0 tighten (instant, guardian), 1 routine (48h), 2 risk-adding (7d), 3 guard/keys/upgrades (14d + co-sign). Safer instantly, riskier slowly.",
    prompt: JSON.stringify(privileged),
    schema: TierOutput,
    heuristic: () => ({ tiers: privileged.map((p) => ({ signature: p.signature, ...tierHeuristic(p.kind, p.signature) })) }),
  });
  return privileged.map((p) => {
    const agent = res.data.tiers.find((t) => t.signature === p.signature) ?? { signature: p.signature, ...tierHeuristic(p.kind, p.signature) };
    const rule = hardRule(p.kind, p.signature.split("(")[0]);
    if (rule && agent.tier < rule.min) return { signature: p.signature, tier: rule.min, rationale: rule.rationale, source: "rule" as const };
    return { signature: p.signature, tier: agent.tier, rationale: agent.rationale, source: "agent" as const };
  });
}

// ------------------------------------------------------------------ 6. red team

export function redTeamHeuristic(model: ProtocolModel, map: MapperOutput): RedTeamOutput {
  const all = model.contracts.flatMap((c) => c.functions);
  const rateBody = all.find((f) => /^(cash|exchangerate|totalassets)$/i.test(f.name))?.body ?? "";
  const kinds = new Set(map.entrypoints.map((e) => e.kind));
  return {
    attacks: ATTACK_LIBRARY.map((a) => {
      switch (a.id) {
        case "oracle_pump":
          return { ...a, applies: Boolean(map.keyState.spotPrice), reason: "collateral is valued with a per-asset spot oracle (can be a thin AMM pool)" };
        case "share_inflation":
          return { ...a, applies: /balanceOf\(/.test(rateBody), reason: "exchange rate reads the raw token balance: donations move it" };
        case "fake_collateral":
          return { ...a, applies: kinds.has("listAsset"), reason: "an admin can list a new collateral with its own oracle" };
        case "split_drain":
          return { ...a, applies: kinds.has("withdraw"), reason: "many small withdrawals can drain liquidity" };
        case "admin_oracle_swap":
          return { ...a, applies: kinds.has("setOracle"), reason: "a hijacked vote can swap an oracle and push accounts underwater" };
        default:
          return { ...a, applies: true, reason: "generic" };
      }
    }),
  };
}

export async function redTeam(runId: string, model: ProtocolModel, map: MapperOutput, invariants: MergedInvariant[]) {
  return llmJson({
    runId,
    agent: "red-team",
    system:
      "You are a red-team agent. Given the protocol and the drafted invariants, decide which attacks from the library apply and which invariant should stop each. You try to drain the protocol while every invariant still passes.",
    prompt: `Attack library: ${JSON.stringify(ATTACK_LIBRARY)}\nInvariants: ${JSON.stringify(invariants.map((i) => ({ template: i.template, params: i.params })))}\nMapping: ${JSON.stringify(map)}\nProtocol:\n${modelSummary(model, 300)}`,
    schema: RedTeamOutput,
    heuristic: () => redTeamHeuristic(model, map),
  });
}
