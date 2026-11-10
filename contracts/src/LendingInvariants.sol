// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LendingInvariants
/// @notice Vetted template library for lending post-checks. The generated GuardConfig calls these with
///         protocol-specific getters. Every check reverts with a named error so a blocked attack says
///         exactly which rule stopped it (e.g. `CheckOracleFailed`).
library LendingInvariants {
    uint256 internal constant BPS = 10_000;

    error CheckHealthFailed(address account, uint256 healthBps, uint256 requiredBps);
    error CheckLtvFailed(address account, uint256 ltvBps, uint256 maxLtvBps);
    error CheckSolvencyFailed(uint256 totalAssets, uint256 totalLiabilities);
    error CheckSharePriceFailed(uint256 priceBefore, uint256 priceAfter, uint256 maxDeltaBps);
    error CheckOracleFailed(address asset, uint256 spot, uint256 twap, uint256 maxDeviationBps);
    error CheckOracleNoTwap(address asset);
    error CheckCapFailed(address asset, uint256 borrowedAgainst, uint256 effectiveCap);
    error CheckAdminUnderwaterFailed(uint256 underwaterBefore, uint256 underwaterAfter, uint256 maxIncrease);

    /// Account health: health factor stays at or above both the intent's minimum and the protocol minimum.
    function checkHealth(address account, uint256 healthBps, uint256 intentMinBps, uint256 protocolMinBps)
        internal
        pure
    {
        uint256 required = intentMinBps > protocolMinBps ? intentMinBps : protocolMinBps;
        if (healthBps < required) revert CheckHealthFailed(account, healthBps, required);
    }

    /// Intent bound: loan-to-value after the action stays within the signed max LTV.
    function checkLtv(address account, uint256 ltvBps, uint256 maxLtvBps) internal pure {
        if (maxLtvBps != 0 && ltvBps > maxLtvBps) revert CheckLtvFailed(account, ltvBps, maxLtvBps);
    }

    /// Solvency: total assets stay at or above total liabilities.
    function checkSolvency(uint256 totalAssets, uint256 totalLiabilities) internal pure {
        if (totalAssets < totalLiabilities) revert CheckSolvencyFailed(totalAssets, totalLiabilities);
    }

    /// Share price: the exchange rate can't move more than maxDeltaBps in one transaction,
    /// unless bad debt was recorded in that same transaction.
    function checkSharePrice(uint256 before, uint256 afterPrice, uint256 maxDeltaBps, bool badDebtRecorded)
        internal
        pure
    {
        if (badDebtRecorded || before == 0 || afterPrice == 0) return;
        uint256 diff = afterPrice > before ? afterPrice - before : before - afterPrice;
        if (diff * BPS > before * maxDeltaBps) revert CheckSharePriceFailed(before, afterPrice, maxDeltaBps);
    }

    /// Oracle sanity: the spot price stays within maxDeviationBps of the attested TWAP.
    function checkOracle(address asset, uint256 spot, uint256 twap, uint256 maxDeviationBps) internal pure {
        if (twap == 0) revert CheckOracleNoTwap(asset);
        uint256 diff = spot > twap ? spot - twap : twap - spot;
        if (diff * BPS > twap * maxDeviationBps) revert CheckOracleFailed(asset, spot, twap, maxDeviationBps);
    }

    /// Collateral cap: borrows against an asset stay within its (probation-ramped) liquidity-based cap.
    function checkCap(address asset, uint256 borrowedAgainst, uint256 effectiveCap) internal pure {
        if (borrowedAgainst > effectiveCap) revert CheckCapFailed(asset, borrowedAgainst, effectiveCap);
    }

    /// Admin post-check: a privileged change may not push healthy accounts underwater beyond a threshold.
    function checkAdminUnderwater(uint256 before, uint256 afterDebt, uint256 maxIncrease) internal pure {
        if (afterDebt > before + maxIncrease) revert CheckAdminUnderwaterFailed(before, afterDebt, maxIncrease);
    }

    /// Probation ramp: a newly listed asset's cap grows linearly from 0 to `cap` over `duration`.
    function rampedCap(uint256 cap, uint256 listedAt, uint256 duration, uint256 nowTs)
        internal
        pure
        returns (uint256)
    {
        if (duration == 0 || nowTs >= listedAt + duration) return cap;
        return (cap * (nowTs - listedAt)) / duration;
    }
}
