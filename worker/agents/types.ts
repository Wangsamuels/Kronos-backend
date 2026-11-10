import { z } from "zod";

export const KINDS = [
  "deposit",
  "withdraw",
  "borrow",
  "repay",
  "liquidate",
  "flashloan",
  "setOracle",
  "listAsset",
  "setCap",
  "lowerCap",
  "setCollateralFactor",
  "lowerCollateralFactor",
  "setRate",
  "pause",
  "unpause",
  "freeze",
  "unfreeze",
  "upgrade",
  "setRole",
  "other",
] as const;
export const USER_KINDS = new Set(["deposit", "withdraw", "borrow", "repay", "liquidate", "flashloan"]);

export const Classification = z.object({
  type: z.enum(["lending", "bridge", "dex", "vault", "other"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type Classification = z.infer<typeof Classification>;

export const MappedEntrypoint = z.object({
  contract: z.string(),
  signature: z.string(),
  kind: z.enum(KINDS),
  role: z.enum(["user", "privileged"]),
  notes: z.string().optional(),
});

export const KeyState = z.object({
  baseAsset: z.string().optional().describe("Solidity expr for the borrowable base asset, e.g. address(base)"),
  accrue: z.string().optional().describe("function to call before snapshots, e.g. accrue"),
  health: z.string().optional().describe("getter returning health in bps for an account, e.g. healthBps"),
  ltv: z.string().optional(),
  totalAssets: z.string().optional().describe("Solidity expr, e.g. cash() + totalBorrows()"),
  totalLiabilities: z.string().optional(),
  sharePrice: z.string().optional(),
  badDebt: z.string().optional(),
  spotPrice: z.string().optional().describe("getter (asset) -> price, e.g. priceOf"),
  borrowedAgainst: z.string().optional(),
  collateralCap: z.string().optional().describe("expr using `asset`, e.g. markets[asset].cap"),
  listedAt: z.string().optional(),
  frozen: z.string().optional(),
  underwaterDebt: z.string().optional(),
  listedAssets: z.string().optional().describe("expr returning address[] of listed collateral, e.g. marketList"),
  accountCollateral: z.string().optional().describe("expr using `a` returning the account's collateral asset"),
  accountDebt: z.string().optional(),
});
export type KeyState = z.infer<typeof KeyState>;

export const MapperOutput = z.object({
  protocolContract: z.string(),
  coreContract: z.string().nullable(),
  adapter: z.enum(["compound-v2-style", "generic"]),
  entrypoints: z.array(MappedEntrypoint),
  keyState: KeyState,
});
export type MapperOutput = z.infer<typeof MapperOutput>;

export const InvariantDraft = z.object({
  template: z.enum(["account_health", "solvency", "share_price", "oracle_sanity", "collateral_cap", "admin_underwater", "custom"]),
  title: z.string(),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])),
  rationale: z.string(),
  customSolidity: z.string().optional(),
});
export const DrafterOutput = z.object({ invariants: z.array(InvariantDraft) });
export type InvariantDraft = z.infer<typeof InvariantDraft>;

export const TierDecision = z.object({
  signature: z.string(),
  tier: z.number().int().min(0).max(3),
  rationale: z.string(),
});
export const TierOutput = z.object({ tiers: z.array(TierDecision) });

export const RedTeamOutput = z.object({
  attacks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      applies: z.boolean(),
      reason: z.string(),
      targetInvariant: z.string(),
    }),
  ),
});
export type RedTeamOutput = z.infer<typeof RedTeamOutput>;

export const SchemaPlain = z.object({ items: z.array(z.object({ signature: z.string(), plainText: z.string() })) });
