// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAttestationRegistry} from "./interfaces/IAttestationRegistry.sol";

/// @title OutflowBreaker
/// @notice Rolling 24h net-outflow window per asset (in the spirit of ERC-7265). It limits the *total*
///         net outflow over the window, not the size of each transaction, so 25 small withdrawals count the
///         same as one big one. Outflow above the threshold is queued, never reverted. A queued payout clears
///         after `releaseDelay`, sooner with a fresh solvency attestation, or by guardian approval.
abstract contract OutflowBreaker {
    uint256 internal constant BUCKETS = 24;
    uint256 internal constant BUCKET_SECONDS = 1 hours;

    struct Bucket {
        uint64 index; // hour index (timestamp / 1h)
        int192 net; // outflow minus inflow during that hour
    }

    struct Claim {
        address asset;
        address to;
        uint128 amount;
        uint64 queuedAt;
        uint64 releaseAt;
        bool guardianApproved;
        bool done;
    }

    error ClaimNotReleasable(uint256 id);
    error ClaimDone(uint256 id);
    error NotGuardian();
    error NotMonitorOrGuardian();
    error NotTighter(uint256 current, uint256 proposed);

    event OutflowQueued(uint256 indexed id, address indexed asset, address indexed to, uint256 amount, uint256 releaseAt);
    event OutflowReleased(uint256 indexed id, address indexed asset, address indexed to, uint256 amount, uint8 reason);
    event OutflowApproved(uint256 indexed id, address indexed guardian);
    event ThresholdTightened(address indexed asset, uint256 oldThreshold, uint256 newThreshold, address by);
    event ThresholdSet(address indexed asset, uint256 threshold, uint256 staleLimit);

    mapping(address => Bucket[BUCKETS]) internal _buckets;
    /// Max net outflow per asset over 24h before payouts queue. 0 = unlimited (not configured).
    mapping(address => uint256) public outflowThreshold;
    /// When the attestation is stale or flags a problem, single payouts above this queue.
    mapping(address => uint256) public staleOutflowLimit;
    /// Tokens owed to queued claims; the protocol must exclude these from its cash.
    mapping(address => uint256) public pendingOutflow;

    Claim[] public claims;
    uint256 public releaseDelay = 6 hours;

    // ---- hooks supplied by KronosGuard ----
    function _breakerRegistry() internal view virtual returns (IAttestationRegistry);
    function _attestationMaxAge() internal view virtual returns (uint256);
    function _isGuardian(address a) internal view virtual returns (bool);
    function _isMonitor(address a) internal view virtual returns (bool);
    function _transferOut(address asset, address to, uint256 amount) internal virtual;

    // ---- window accounting ----
    function netOutflow(address asset) public view returns (int256 total) {
        uint64 cur = uint64(block.timestamp / BUCKET_SECONDS);
        Bucket[BUCKETS] storage b = _buckets[asset];
        for (uint256 i = 0; i < BUCKETS; i++) {
            if (b[i].index + BUCKETS > cur) total += b[i].net;
        }
    }

    function _record(address asset, int256 delta) internal {
        uint64 cur = uint64(block.timestamp / BUCKET_SECONDS);
        Bucket storage slot = _buckets[asset][cur % BUCKETS];
        if (slot.index != cur) {
            slot.index = cur;
            slot.net = 0;
        }
        slot.net += int192(delta);
    }

    /// @dev Record an inflow (deposit, repay). Inflows free up room in the window.
    function _breakerInflow(address asset, uint256 amount) internal {
        _record(asset, -int256(amount));
    }

    /// @dev Pay out through the breaker. Returns claim id + 1 if queued, 0 if paid immediately.
    function _breakerPayout(address asset, address to, uint256 amount) internal returns (uint256) {
        bool queue;
        uint256 threshold = outflowThreshold[asset];
        if (threshold != 0) {
            int256 projected = netOutflow(asset) + int256(amount);
            if (projected > int256(threshold)) queue = true;
        }
        if (!queue) {
            uint256 staleLimit = staleOutflowLimit[asset];
            if (staleLimit != 0 && amount > staleLimit) {
                if (!_breakerRegistry().isFresh(address(this), _attestationMaxAge())) queue = true;
            }
        }
        _record(asset, int256(amount));
        if (!queue) {
            _transferOut(asset, to, amount);
            return 0;
        }
        uint256 id = claims.length;
        uint64 releaseAt = uint64(block.timestamp + releaseDelay);
        claims.push(Claim(asset, to, uint128(amount), uint64(block.timestamp), releaseAt, false, false));
        pendingOutflow[asset] += amount;
        emit OutflowQueued(id, asset, to, amount, releaseAt);
        return id + 1;
    }

    /// @notice Release a queued payout. Anyone can call once one release condition holds:
    ///         0 = delay elapsed, 1 = fresh solvency attestation posted after queueing, 2 = guardian approved.
    function releaseOutflow(uint256 id) external {
        Claim storage c = claims[id];
        if (c.done) revert ClaimDone(id);
        uint8 reason;
        if (block.timestamp >= c.releaseAt) {
            reason = 0;
        } else if (_freshSolvencySince(c.queuedAt)) {
            reason = 1;
        } else if (c.guardianApproved) {
            reason = 2;
        } else {
            revert ClaimNotReleasable(id);
        }
        c.done = true;
        pendingOutflow[c.asset] -= c.amount;
        _transferOut(c.asset, c.to, c.amount);
        emit OutflowReleased(id, c.asset, c.to, c.amount, reason);
    }

    function approveOutflow(uint256 id) external {
        if (!_isGuardian(msg.sender)) revert NotGuardian();
        claims[id].guardianApproved = true;
        emit OutflowApproved(id, msg.sender);
    }

    /// @notice Monitoring tightens the window on anomaly flags. Tighten-only: can never raise a threshold.
    function tightenOutflow(address asset, uint256 newThreshold) external {
        if (!_isMonitor(msg.sender) && !_isGuardian(msg.sender)) revert NotMonitorOrGuardian();
        uint256 cur = outflowThreshold[asset];
        if (newThreshold == 0 || (cur != 0 && newThreshold >= cur)) revert NotTighter(cur, newThreshold);
        outflowThreshold[asset] = newThreshold;
        emit ThresholdTightened(asset, cur, newThreshold, msg.sender);
    }

    function _setOutflowThreshold(address asset, uint256 threshold, uint256 staleLimit) internal {
        outflowThreshold[asset] = threshold;
        staleOutflowLimit[asset] = staleLimit;
        emit ThresholdSet(asset, threshold, staleLimit);
    }

    function claimsCount() external view returns (uint256) {
        return claims.length;
    }

    function _freshSolvencySince(uint64 ts) internal view returns (bool) {
        IAttestationRegistry r = _breakerRegistry();
        IAttestationRegistry.Attestation memory a = r.latest(address(this));
        return a.timestamp > ts && a.solvencyOk && r.isFresh(address(this), _attestationMaxAge());
    }
}
