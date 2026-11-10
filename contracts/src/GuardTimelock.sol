// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IKronosGuarded} from "./interfaces/IKronosGuarded.sol";

/// @title GuardTimelock
/// @notice "Safer instantly, riskier slowly." Tiered queue for privileged calls; the timelock lives in the
///         guard, not in governance, so a malicious proposal can't skip the delay (Term Finance pattern).
///           Tier 0 Tighten   : instant, guardian multisig only (pause, lower caps/LTV, freeze)
///           Tier 1 Routine   : 48h, admin or governance (rate curves, fees)
///           Tier 2 Risk-add  : 7d, admin or governance (new collateral, oracle change, higher caps/LTV)
///           Tier 3 Guard/keys: 14d + independent co-sign (guard rules, upgrades, signer sets)
///         Guardians are cancel-only during the delay: they can cancel but never execute a queued action.
///         After every executed change the guard re-checks solvency and underwater debt; failure reverts.
contract GuardTimelock {
    uint8 public constant TIER_TIGHTEN = 0;
    uint8 public constant TIER_ROUTINE = 1;
    uint8 public constant TIER_RISK = 2;
    uint8 public constant TIER_GUARD = 3;

    struct Action {
        address target;
        bytes data;
        uint8 tier;
        uint64 eta;
        uint64 queuedAt;
        address proposer;
        uint16 cosigns;
        bool executed;
        bool cancelled;
    }

    error Unauthorized();
    error UnknownSelector(address target, bytes4 selector);
    error WrongTier(uint8 tier);
    error NotReady(uint64 eta);
    error AlreadyFinal();
    error NeedCosigns(uint16 have, uint16 need);
    error AlreadyCosigned();
    error CallFailed(bytes returndata);
    error OnlySelf();

    event ActionQueued(uint256 indexed id, address indexed target, bytes4 selector, uint8 tier, uint64 eta, address proposer);
    event ActionCosigned(uint256 indexed id, address indexed cosigner, uint16 total);
    event ActionCancelled(uint256 indexed id, address indexed by);
    event ActionExecuted(uint256 indexed id, address indexed target, bytes4 selector, uint8 tier);
    event TightenExecuted(address indexed target, bytes4 selector, address indexed guardian);
    event TierSet(address indexed target, bytes4 indexed selector, uint8 tier);
    event RoleSet(bytes32 indexed role, address indexed account, bool enabled);

    uint64[4] public delays = [uint64(0), 48 hours, 7 days, 14 days];

    mapping(address => bool) public isAdmin; // protocol admin multisig
    mapping(address => bool) public isGovernance; // DAO executor
    mapping(address => bool) public isGuardian; // mixed protocol + independent signers
    mapping(address => bool) public isCosigner; // independent co-signers for Tier 3
    uint16 public cosignThreshold;

    /// @dev Tier per (target, selector). Selector not registered => UnknownSelector. Stored as tier+1.
    mapping(address => mapping(bytes4 => uint8)) internal _tierPlusOne;

    Action[] internal _actions;
    mapping(uint256 => mapping(address => bool)) public hasCosigned;

    constructor(
        address[] memory admins,
        address[] memory governance,
        address[] memory guardians,
        address[] memory cosigners,
        uint16 cosignThreshold_
    ) {
        for (uint256 i; i < admins.length; i++) _setRole("admin", admins[i], true);
        for (uint256 i; i < governance.length; i++) _setRole("governance", governance[i], true);
        for (uint256 i; i < guardians.length; i++) _setRole("guardian", guardians[i], true);
        for (uint256 i; i < cosigners.length; i++) _setRole("cosigner", cosigners[i], true);
        cosignThreshold = cosignThreshold_;
        // Hard rule: everything that touches the timelock itself (tiers, roles, delays) is Tier 3.
        _setTier(address(this), GuardTimelock.setTier.selector, TIER_GUARD);
        _setTier(address(this), GuardTimelock.setRole.selector, TIER_GUARD);
        _setTier(address(this), GuardTimelock.setCosignThreshold.selector, TIER_GUARD);
    }

    // ------------------------------------------------------------------ setup (one-time, then Tier 3)

    /// @dev Per protocol: setup is open until finalized, then tiers only change through a Tier 3 action.
    mapping(address => bool) public finalized;

    event SetupFinalized(address indexed target);

    /// @notice One-time tier table install by an admin at deployment (from the approved package).
    function setupTiers(address target, bytes4[] calldata selectors, uint8[] calldata tiers) external {
        _onlySetup(target);
        for (uint256 i; i < selectors.length; i++) _setTier(target, selectors[i], tiers[i]);
    }

    /// @notice Deployment-time bootstrap (initial listings and thresholds from the approved package).
    ///         Disabled forever for `target` by `finalizeSetup`; deployment verification checks it.
    function setupCall(address target, bytes calldata data) external returns (bytes memory) {
        _onlySetup(target);
        return _call(target, data);
    }

    function finalizeSetup(address target) external {
        _onlySetup(target);
        finalized[target] = true;
        emit SetupFinalized(target);
    }

    function _onlySetup(address target) internal view {
        if (finalized[target] || target == address(this) || !isAdmin[msg.sender]) revert Unauthorized();
    }

    // ------------------------------------------------------------------ Tier 0: instant tighten

    function tighten(address target, bytes calldata data) external returns (bytes memory ret) {
        if (!isGuardian[msg.sender]) revert Unauthorized();
        bytes4 sel = bytes4(data[:4]);
        if (tierOf(target, sel) != TIER_TIGHTEN) revert WrongTier(tierOf(target, sel));
        ret = _call(target, data);
        emit TightenExecuted(target, sel, msg.sender);
    }

    // ------------------------------------------------------------------ Tiers 1-3: queue / cosign / execute

    function queue(address target, bytes calldata data) external returns (uint256 id) {
        if (!isAdmin[msg.sender] && !isGovernance[msg.sender]) revert Unauthorized();
        bytes4 sel = bytes4(data[:4]);
        uint8 tier = tierOf(target, sel);
        if (tier == TIER_TIGHTEN) revert WrongTier(tier); // use tighten()
        uint64 eta = uint64(block.timestamp) + delays[tier];
        id = _actions.length;
        _actions.push(Action(target, data, tier, eta, uint64(block.timestamp), msg.sender, 0, false, false));
        emit ActionQueued(id, target, sel, tier, eta, msg.sender);
    }

    function cosign(uint256 id) external {
        if (!isCosigner[msg.sender]) revert Unauthorized();
        Action storage a = _actions[id];
        if (a.executed || a.cancelled) revert AlreadyFinal();
        if (hasCosigned[id][msg.sender]) revert AlreadyCosigned();
        hasCosigned[id][msg.sender] = true;
        a.cosigns++;
        emit ActionCosigned(id, msg.sender, a.cosigns);
    }

    /// @notice Guardians (and admins) may cancel during the delay. Guardians can never execute.
    function cancel(uint256 id) external {
        if (!isGuardian[msg.sender] && !isAdmin[msg.sender] && !isGovernance[msg.sender]) revert Unauthorized();
        Action storage a = _actions[id];
        if (a.executed || a.cancelled) revert AlreadyFinal();
        a.cancelled = true;
        emit ActionCancelled(id, msg.sender);
    }

    /// @notice Execute after the delay, then simulate-then-check: the guard re-validates the protocol in the
    ///         same transaction and the whole change reverts if it broke an invariant.
    function execute(uint256 id) external returns (bytes memory ret) {
        if (!isAdmin[msg.sender] && !isGovernance[msg.sender]) revert Unauthorized();
        Action storage a = _actions[id];
        if (a.executed || a.cancelled) revert AlreadyFinal();
        if (block.timestamp < a.eta) revert NotReady(a.eta);
        if (a.tier == TIER_GUARD && a.cosigns < cosignThreshold) revert NeedCosigns(a.cosigns, cosignThreshold);
        a.executed = true;

        bool guardedTarget = a.target != address(this) && _isGuarded(a.target);
        uint256 underwaterBefore = guardedTarget ? IKronosGuarded(a.target).kronosAdminSnapshot() : 0;
        ret = _call(a.target, a.data);
        if (guardedTarget) IKronosGuarded(a.target).kronosCheckAdmin(underwaterBefore);
        emit ActionExecuted(id, a.target, bytes4(a.data), a.tier);
    }

    // ------------------------------------------------------------------ Tier 3 self-calls

    function setTier(address target, bytes4 selector, uint8 tier) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _setTier(target, selector, tier);
    }

    function setRole(bytes32 role, address account, bool enabled) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _setRole(role, account, enabled);
    }

    function setCosignThreshold(uint16 t) external {
        if (msg.sender != address(this)) revert OnlySelf();
        cosignThreshold = t;
    }

    // ------------------------------------------------------------------ views

    function tierOf(address target, bytes4 selector) public view returns (uint8) {
        uint8 t = _tierPlusOne[target][selector];
        if (t == 0) revert UnknownSelector(target, selector);
        return t - 1;
    }

    function getAction(uint256 id) external view returns (Action memory) {
        return _actions[id];
    }

    function actionsCount() external view returns (uint256) {
        return _actions.length;
    }

    // ------------------------------------------------------------------ internals

    function _setTier(address target, bytes4 selector, uint8 tier) internal {
        if (tier > TIER_GUARD) revert WrongTier(tier);
        // Hard rules: anything targeting the timelock itself is always Tier 3.
        if (target == address(this) && tier != TIER_GUARD) revert WrongTier(tier);
        _tierPlusOne[target][selector] = tier + 1;
        emit TierSet(target, selector, tier);
    }

    function _setRole(bytes32 role, address account, bool enabled) internal {
        if (role == "admin") isAdmin[account] = enabled;
        else if (role == "governance") isGovernance[account] = enabled;
        else if (role == "guardian") isGuardian[account] = enabled;
        else if (role == "cosigner") isCosigner[account] = enabled;
        else revert Unauthorized();
        emit RoleSet(role, account, enabled);
    }

    function _call(address target, bytes memory data) internal returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            // bubble up the original revert reason (e.g. CheckSolvencyFailed)
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    function _isGuarded(address target) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            target.staticcall(abi.encodeWithSelector(IKronosGuarded.kronosTimelock.selector));
        return ok && ret.length == 32 && abi.decode(ret, (address)) == address(this);
    }
}
