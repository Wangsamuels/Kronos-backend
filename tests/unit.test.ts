import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { mergeDrafts, hardRule, tierHeuristic, classifyHeuristic } from "../worker/agents/agents.js";
import { configHash, guardParamsFrom } from "../worker/templates/generate.js";
import { decide } from "../worker/attestor.js";
import { percentile } from "../worker/history.js";
import { parseRepoUrl } from "../lib/github.js";
import { zodToJsonSchema } from "../lib/zodJson.js";
import { __test as nep } from "../api/walletAuth.js";
import type { InvariantDraft } from "../worker/agents/types.js";

describe("drafter merge", () => {
  const a: InvariantDraft[] = [
    { template: "solvency", title: "Solvency", params: {}, rationale: "a" },
    { template: "oracle_sanity", title: "Oracle", params: { maxOracleDeviationBps: 500 }, rationale: "a" },
    { template: "share_price", title: "Share", params: { maxSharePriceDeltaBps: 100 }, rationale: "a" },
  ];
  const b: InvariantDraft[] = [
    { template: "solvency", title: "Solvency", params: {}, rationale: "b" },
    { template: "oracle_sanity", title: "Oracle", params: { maxOracleDeviationBps: 300 }, rationale: "b" },
    { template: "collateral_cap", title: "Cap", params: { probationSeconds: 1 }, rationale: "b" },
  ];
  const m = mergeDrafts(a, b);
  it("keeps agreement without review", () => {
    expect(m.find((x) => x.template === "solvency")).toMatchObject({ drafters: ["A", "B"], needsReview: false });
  });
  it("flags disagreement and proposes the stricter value", () => {
    const o = m.find((x) => x.template === "oracle_sanity")!;
    expect(o.needsReview).toBe(true);
    expect(o.params.maxOracleDeviationBps).toBe(300);
  });
  it("flags invariants only one drafter proposed", () => {
    expect(m.find((x) => x.template === "share_price")).toMatchObject({ drafters: ["A"], needsReview: true });
    expect(m.find((x) => x.template === "collateral_cap")).toMatchObject({ drafters: ["B"], needsReview: true });
  });
});

describe("tier hard rules", () => {
  it("oracle changes are at least Tier 2, upgrades and signers Tier 3", () => {
    expect(hardRule("setOracle", "setOracle")?.min).toBe(2);
    expect(hardRule("upgrade", "upgradeTo")?.min).toBe(3);
    expect(hardRule("setRole", "addSigner")?.min).toBe(3);
  });
  it("only explicit tighten functions may be Tier 0", () => {
    expect(hardRule("setCap", "setCap")?.min).toBe(1);
    expect(hardRule("pause", "pause")).toBeNull();
    expect(tierHeuristic("lowerCap", "lowerCap").tier).toBe(0);
    expect(tierHeuristic("listAsset", "listAsset").tier).toBe(2);
  });
});

describe("config hash", () => {
  it("matches KronosGuard.kronosConfigHash() for the demo defaults", () => {
    // value printed by contracts/script/Deploy.s.sol for (10000, 100, 500, 600, 7 days, 0)
    const { params } = guardParamsFrom([
      { template: "account_health", params: { protocolMinHealthBps: 10000 }, status: "approved" },
      { template: "share_price", params: { maxSharePriceDeltaBps: 100 }, status: "approved" },
      { template: "oracle_sanity", params: { maxOracleDeviationBps: 500, attestationMaxAgeBlocks: 600 }, status: "approved" },
      { template: "collateral_cap", params: { probationSeconds: 604800 }, status: "approved" },
      { template: "admin_underwater", params: { adminMaxUnderwaterIncrease: 0 }, status: "approved" },
    ]);
    expect(configHash(params)).toBe("0xa53d3185b19261b763c86ed4dd477124324b29c8e831d3bf62ab6a6996d52375");
  });
  it("a rejected invariant disables its check", () => {
    const { params, disabled } = guardParamsFrom([{ template: "share_price", params: { maxSharePriceDeltaBps: 100 }, status: "rejected" }]);
    expect(params.maxSharePriceDeltaBps).toBe(2 ** 128);
    expect(disabled.has("share_price")).toBe(true);
  });
});

describe("attestor decision", () => {
  const base = { assets: ["0x1" as `0x${string}`], totalAssets: 10n, totalLiabilities: 9n, maxDeviationBps: 300n };
  it("passes when spot agrees with the TWAP", () => {
    expect(decide({ ...base, spots: [100n], twaps: [101n], samples: [5] })).toEqual({ oracleOk: true, solvencyOk: true });
  });
  it("fails oracle on a pump and solvency on a shortfall", () => {
    expect(decide({ ...base, spots: [12100n], twaps: [100n], samples: [5], totalLiabilities: 11n })).toEqual({ oracleOk: false, solvencyOk: false });
  });
});

describe("helpers", () => {
  it("percentile", () => {
    expect(percentile([1n, 2n, 3n, 4n, 100n], 99.9)).toBe(100n);
    expect(percentile([5n, 1n, 3n], 50)).toBe(3n);
  });
  it("parses GitHub URLs", () => {
    expect(parseRepoUrl("https://github.com/acme/lend")).toEqual({ owner: "acme", repo: "lend", ref: undefined, subdir: undefined });
    expect(parseRepoUrl("https://github.com/acme/lend/tree/main/contracts")).toEqual({ owner: "acme", repo: "lend", ref: "main", subdir: "contracts" });
    expect(parseRepoUrl("https://gitlab.com/x/y")).toBeNull();
  });
  it("converts zod to JSON schema for LLM output", () => {
    const s = zodToJsonSchema(z.object({ a: z.string(), b: z.array(z.number()).optional(), c: z.enum(["x", "y"]) }));
    expect(s).toMatchObject({ type: "object", required: ["a", "c"], properties: { c: { enum: ["x", "y"] } } });
  });
  it("classifies lending by function names", () => {
    const model = { astSource: "regex" as const, contracts: [{ name: "L", kind: "contract", abstract: false, file: "L.sol", bases: [], stateVars: [], modifiers: [], functions: ["deposit", "withdraw", "borrow", "repay", "liquidate", "healthFactor"].map((n) => ({ name: n })) }] };
    expect(classifyHeuristic(model as never).type).toBe("lending");
  });
});

describe("NEP-413 wallet sign-in payload", () => {
  it("round-trips an ed25519 signature over the borsh payload", () => {
    const sk = ed25519.utils.randomSecretKey();
    const pk = ed25519.getPublicKey(sk);
    const nonce = Buffer.alloc(32, 7);
    const payload = nep.borshNep413("Sign in to Kronos", nonce, "kronos.app");
    const sig = ed25519.sign(sha256(payload), sk);
    expect(ed25519.verify(sig, sha256(payload), pk)).toBe(true);
    // base58 decode of a known value
    expect(Buffer.from(nep.base58Decode("2g")).toString("hex")).toBe("61");
  });
});
