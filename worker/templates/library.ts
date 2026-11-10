/**
 * The vetted template library. Agents map protocols onto these instead of writing security rules from
 * scratch. Each invariant template corresponds to a check in contracts/src/LendingInvariants.sol.
 */
export interface InvariantTemplate {
  title: string;
  defaults: Record<string, number>;
  plain: (p: Record<string, unknown>) => string;
  solidity: (p: Record<string, unknown>) => string;
  stops: string;
}

const pct = (bps: unknown) => `${Number(bps) / 100}%`;

export const TEMPLATES: Record<string, InvariantTemplate> = {
  account_health: {
    title: "Account health",
    defaults: { protocolMinHealthBps: 10_000 },
    plain: (p) =>
      `After every action the signer's health factor stays at or above the intent's minimum and the protocol minimum (${Number(p.protocolMinHealthBps ?? 10_000) / 10_000}).`,
    solidity: () => "LendingInvariants.checkHealth(signer, _kronosHealthBps(signer), intent.minHealthBps, params.protocolMinHealthBps);",
    stops: "Over-borrowing, flawed collateral logic",
  },
  solvency: {
    title: "Solvency",
    defaults: {},
    plain: () => "Total protocol assets stay at or above total liabilities after every action and every admin change.",
    solidity: () => "LendingInvariants.checkSolvency(_kronosTotalAssets(), _kronosTotalLiabilities());",
    stops: "Accounting bugs, minting from nothing",
  },
  share_price: {
    title: "Share price",
    defaults: { maxSharePriceDeltaBps: 100 },
    plain: (p) => `The supply exchange rate can't move more than ${pct(p.maxSharePriceDeltaBps ?? 100)} in one transaction, except when bad debt is recorded.`,
    solidity: () => "LendingInvariants.checkSharePrice(priceBefore, _kronosSharePrice(), params.maxSharePriceDeltaBps, _kronosBadDebt() > badDebtBefore);",
    stops: "Donation and inflation attacks, rounding exploits",
  },
  oracle_sanity: {
    title: "Oracle sanity",
    defaults: { maxOracleDeviationBps: 500, twapWindowSeconds: 1800, minSources: 2, attestationMaxAgeBlocks: 1800 },
    plain: (p) =>
      `Every collateral price an action relies on stays within ${pct(p.maxOracleDeviationBps ?? 500)} of the attested ${Number(p.twapWindowSeconds ?? 1800) / 60}-minute TWAP across ${p.minSources ?? 2}+ sources.`,
    solidity: () => "LendingInvariants.checkOracle(asset, _kronosSpotPrice(asset), registry.twapOf(address(this), asset), params.maxOracleDeviationBps);",
    stops: "Price manipulation of thin collateral (Tectonic, Moonwell)",
  },
  collateral_cap: {
    title: "Collateral cap",
    defaults: { probationSeconds: 7 * 86400 },
    plain: (p) =>
      `Borrows against an asset stay within its liquidity-based cap. A newly listed asset or changed oracle ramps its cap up over ${Number(p.probationSeconds ?? 604800) / 86400} days.`,
    solidity: () =>
      "LendingInvariants.checkCap(asset, _kronosBorrowedAgainst(asset), LendingInvariants.rampedCap(_kronosCollateralCap(asset), _kronosListedAt(asset), params.probationSeconds, block.timestamp));",
    stops: "Pumping an illiquid token to borrow against it; fake collateral listings (Drift)",
  },
  admin_underwater: {
    title: "Admin changes can't sink accounts",
    defaults: { adminMaxUnderwaterIncrease: 0 },
    plain: (p) =>
      `A queued privileged change is executed and re-checked in the same transaction: it reverts if the protocol becomes insolvent or underwater debt rises by more than ${p.adminMaxUnderwaterIncrease ?? 0}.`,
    solidity: () => "LendingInvariants.checkAdminUnderwater(underwaterBefore, _kronosUnderwaterDebt(), params.adminMaxUnderwaterIncrease);",
    stops: "Hijacked governance votes and stolen admin keys (BonkDAO pattern)",
  },
  custom: {
    title: "Protocol-specific",
    defaults: {},
    plain: () => "Protocol-specific check proposed by the drafters.",
    solidity: () => "",
    stops: "Protocol-specific",
  },
};

/** Attack library for the compound-v2-style adapter, backed by Foundry tests in contracts/test. */
export const ATTACK_LIBRARY = [
  {
    id: "oracle_pump",
    name: "Oracle pump on thin collateral",
    targetInvariant: "oracle_sanity",
    guardedTests: ["test_OraclePump_RevertsAtCheckOracle"],
    baselineTests: ["test_OraclePump_DrainsUnguarded"],
  },
  {
    id: "share_inflation",
    name: "Donation / share-inflation attack",
    targetInvariant: "share_price",
    guardedTests: ["test_ShareInflation_VictimDepositReverts"],
    baselineTests: ["test_ShareInflation_StealsFromVictimUnguarded"],
  },
  {
    id: "fake_collateral",
    name: "Fake collateral listed with its own oracle",
    targetInvariant: "collateral_cap",
    guardedTests: ["test_FakeCollateral_QueuedSevenDaysAndGuardianCancels", "test_FakeCollateral_EvenIfListed_ProbationBlocksBorrow"],
    baselineTests: ["test_FakeCollateral_DrainsUnguarded"],
  },
  {
    id: "split_drain",
    name: "Drain split into 25 small withdrawals",
    targetInvariant: "outflow_window",
    guardedTests: ["test_Breaker_SplitWithdrawalsCountTheSame", "test_Breaker_StaleAttestationQueuesLargeOutflows"],
    baselineTests: [],
  },
  {
    id: "admin_oracle_swap",
    name: "Hijacked vote swaps an oracle",
    targetInvariant: "admin_underwater",
    guardedTests: ["test_AdminChangeThatPutsAccountsUnderwater_Reverts", "test_Tier3_NeedsIndependentCosign"],
    baselineTests: [],
  },
  {
    id: "intent_tamper",
    name: "Hacked frontend / relayer tampers with the intent",
    targetInvariant: "intent",
    guardedTests: [
      "test_HackedFrontend_CantRedirectFunds",
      "test_ReplayedIntent_Reverts",
      "test_ExpiredIntent_Reverts",
      "test_NoValidIntent_Reverts",
      "test_SignedForOneActionCantBeUsedForAnother",
      "test_MaxLtvBound_Enforced",
    ],
    baselineTests: [],
  },
] as const;

export const NORMAL_TESTS = ["test_NormalFlows_Pass", "test_InterestAccrual_DoesNotTripSharePrice", "test_ExplicitRecipient_Allowed", "test_Tier0_PauseIsInstant_UnpauseTakes48h"];
