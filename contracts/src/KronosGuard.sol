// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OutflowBreaker} from "./OutflowBreaker.sol";
import {LendingInvariants as LI} from "./LendingInvariants.sol";
import {IAttestationRegistry} from "./interfaces/IAttestationRegistry.sol";
import {IKronosGuarded} from "./interfaces/IKronosGuarded.sol";

/// @title KronosGuard
/// @notice Abstract base providing the `guarded(kind, intent, sig)` modifier. One guard wraps every entry
///         point — user and privileged — in the same transaction:
///           pre-checks  : EIP-712 intent signature, nonce, deadline, bounds, recipient rule, frozen asset
///           action      : the protocol's own function body (it can only use values from the signed intent)
///           post-checks : health, LTV, solvency, share price, oracle sanity, collateral cap — any failure reverts
///           outflow     : payouts go through the rolling OutflowBreaker (under limit: paid, over: queued)
///         Privileged functions use `onlyTimelock`; the GuardTimelock runs `kronosCheckAdmin` after each change.
abstract contract KronosGuard is OutflowBreaker, IKronosGuarded {
    enum Kind {
        Deposit,
        Withdraw,
        Borrow,
        Repay,
        Liquidate
    }

    /// @dev One struct layout; the EIP-712 type *name* differs per action so wallets show e.g. "BorrowIntent".
    struct Intent {
        address asset;
        uint256 amount;
        uint256 maxLtvBps; // 0 = not bounded (non-borrow actions)
        uint256 minHealthBps; // signer's floor on health factor after the action, 10_000 = 1.0
        address account; // position acted on; must be the signer except for liquidations
        address recipient; // 0 = the signer. Any other address must be named explicitly in the signed intent
        uint256 deadline;
        uint256 nonce; // unordered nonce, single use
    }

    struct GuardParams {
        uint256 protocolMinHealthBps;
        uint256 maxSharePriceDeltaBps;
        uint256 maxOracleDeviationBps;
        uint256 attestationMaxAgeBlocks;
        uint256 probationSeconds;
        uint256 adminMaxUnderwaterIncrease;
    }

    error IntentExpired(uint256 deadline);
    error IntentReplayed(address signer, uint256 nonce);
    error BadIntentSignature();
    error AccountNotSigner(address account, address signer);
    error AssetFrozen(address asset);
    error ReentrantCall();
    error NotTimelock();
    error NoActiveIntent();

    event IntentExecuted(address indexed signer, uint8 indexed kind, address indexed asset, uint256 amount, uint256 nonce);
    event GuardianSet(address guardian);
    event MonitorSet(address monitor);
    event GuardParamsSet(bytes32 configHash);

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Kronos");
    bytes32 private constant VERSION_HASH = keccak256("1");
    string private constant FIELDS =
        "(address asset,uint256 amount,uint256 maxLtvBps,uint256 minHealthBps,address account,address recipient,uint256 deadline,uint256 nonce)";

    address public immutable timelock;
    IAttestationRegistry public registry;
    address public guardian;
    address public monitor;
    GuardParams public params;

    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    // Active intent signer; doubles as the reentrancy lock. Idle value is a non-zero sentinel so the
    // per-call writes are cheap nonzero->nonzero SSTOREs.
    address private constant IDLE = address(1);
    address private _activeSigner = IDLE;

    constructor(address timelock_, address registry_, address guardian_, address monitor_, GuardParams memory p) {
        timelock = timelock_;
        registry = IAttestationRegistry(registry_);
        guardian = guardian_;
        monitor = monitor_;
        params = p;
        emit GuardParamsSet(keccak256(abi.encode(p)));
    }

    // ------------------------------------------------------------------ modifiers

    modifier guarded(Kind kind, Intent calldata intent, bytes calldata sig) {
        if (_activeSigner != IDLE) revert ReentrantCall();
        address signer = _preChecks(kind, intent, sig);
        _activeSigner = signer;

        _kronosBeforeAction();
        uint256 priceBefore = _kronosSharePrice();
        uint256 badDebtBefore = _kronosBadDebt();

        _;

        _postChecks(kind, intent, signer, priceBefore, badDebtBefore);
        emit IntentExecuted(signer, uint8(kind), intent.asset, intent.amount, intent.nonce);
        _activeSigner = IDLE;
    }

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotTimelock();
        _;
    }

    // ------------------------------------------------------------------ intent helpers for function bodies

    function _kronosSigner() internal view returns (address s) {
        s = _activeSigner;
        if (s == IDLE) revert NoActiveIntent();
    }

    /// @dev Recipient rule: the signer, unless the signed intent names another address explicitly.
    function _kronosRecipient(Intent calldata intent) internal view returns (address) {
        return intent.recipient == address(0) ? _kronosSigner() : intent.recipient;
    }

    // ------------------------------------------------------------------ EIP-712

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    bytes32 private constant DEPOSIT_TYPEHASH = keccak256(abi.encodePacked("DepositIntent", FIELDS));
    bytes32 private constant WITHDRAW_TYPEHASH = keccak256(abi.encodePacked("WithdrawIntent", FIELDS));
    bytes32 private constant BORROW_TYPEHASH = keccak256(abi.encodePacked("BorrowIntent", FIELDS));
    bytes32 private constant REPAY_TYPEHASH = keccak256(abi.encodePacked("RepayIntent", FIELDS));
    bytes32 private constant LIQUIDATE_TYPEHASH = keccak256(abi.encodePacked("LiquidateIntent", FIELDS));

    function intentTypehash(Kind kind) public pure returns (bytes32) {
        if (kind == Kind.Deposit) return DEPOSIT_TYPEHASH;
        if (kind == Kind.Withdraw) return WITHDRAW_TYPEHASH;
        if (kind == Kind.Borrow) return BORROW_TYPEHASH;
        if (kind == Kind.Repay) return REPAY_TYPEHASH;
        return LIQUIDATE_TYPEHASH;
    }

    function intentDigest(Kind kind, Intent calldata i) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                intentTypehash(kind),
                i.asset,
                i.amount,
                i.maxLtvBps,
                i.minHealthBps,
                i.account,
                i.recipient,
                i.deadline,
                i.nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    // ------------------------------------------------------------------ checks

    function _preChecks(Kind kind, Intent calldata intent, bytes calldata sig) internal returns (address signer) {
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline);
        signer = _recover(intentDigest(kind, intent), sig);
        if (signer == address(0)) revert BadIntentSignature();
        if (nonceUsed[signer][intent.nonce]) revert IntentReplayed(signer, intent.nonce);
        nonceUsed[signer][intent.nonce] = true;
        if (kind != Kind.Liquidate && intent.account != signer) revert AccountNotSigner(intent.account, signer);
        if ((kind == Kind.Deposit || kind == Kind.Borrow) && _kronosAssetFrozen(intent.asset)) {
            revert AssetFrozen(intent.asset);
        }
    }

    function _postChecks(Kind kind, Intent calldata intent, address signer, uint256 priceBefore, uint256 badDebtBefore)
        internal
        view
    {
        GuardParams memory p = params;

        // 1. Account health (signer) and the signed LTV bound.
        LI.checkHealth(signer, _kronosHealthBps(signer), intent.minHealthBps, p.protocolMinHealthBps);
        if (kind == Kind.Borrow) LI.checkLtv(signer, _kronosLtvBps(signer), intent.maxLtvBps);

        // 2. Solvency.
        LI.checkSolvency(_kronosTotalAssets(), _kronosTotalLiabilities());

        // 3. Share price delta (skipped only if bad debt was recorded in this tx).
        LI.checkSharePrice(priceBefore, _kronosSharePrice(), p.maxSharePriceDeltaBps, _kronosBadDebt() > badDebtBefore);

        // 4/5. Oracle sanity + collateral cap for every price the action relied on.
        if (kind == Kind.Borrow || kind == Kind.Withdraw || kind == Kind.Liquidate) {
            address subject = kind == Kind.Liquidate ? intent.account : signer;
            address[] memory assets = _kronosPricedAssets(subject);
            for (uint256 i = 0; i < assets.length; i++) {
                address a = assets[i];
                LI.checkOracle(a, _kronosSpotPrice(a), registry.twapOf(address(this), a), p.maxOracleDeviationBps);
                if (kind == Kind.Borrow) {
                    uint256 cap =
                        LI.rampedCap(_kronosCollateralCap(a), _kronosListedAt(a), p.probationSeconds, block.timestamp);
                    LI.checkCap(a, _kronosBorrowedAgainst(a), cap);
                }
            }
        }
    }

    /// @inheritdoc IKronosGuarded
    function kronosAdminSnapshot() external view returns (uint256) {
        return _kronosUnderwaterDebt();
    }

    /// @inheritdoc IKronosGuarded
    function kronosCheckAdmin(uint256 underwaterBefore) external view {
        LI.checkSolvency(_kronosTotalAssets(), _kronosTotalLiabilities());
        LI.checkAdminUnderwater(underwaterBefore, _kronosUnderwaterDebt(), params.adminMaxUnderwaterIncrease);
    }

    /// @inheritdoc IKronosGuarded
    function kronosConfigHash() public view returns (bytes32) {
        return keccak256(abi.encode(params));
    }

    function kronosTimelock() external view returns (address) {
        return timelock;
    }

    // ------------------------------------------------------------------ views for the attestor and monitor

    /// @notice Aggregate solvency inputs the attestor proves off-chain each block.
    function kronosSolvency() external view returns (uint256 totalAssets, uint256 totalLiabilities) {
        return (_kronosTotalAssets(), _kronosTotalLiabilities());
    }

    /// @notice The protocol's own spot price for `asset` (what the oracle-sanity check compares to the TWAP).
    function kronosSpotPrice(address asset) external view returns (uint256) {
        return _kronosSpotPrice(asset);
    }

    /// @notice Every listed collateral asset (the attestor posts a TWAP for each).
    function kronosAssets() external view returns (address[] memory) {
        return _kronosListedAssets();
    }

    // ------------------------------------------------------------------ privileged settings (timelocked)

    function setGuardParams(GuardParams calldata p) external onlyTimelock {
        params = p;
        emit GuardParamsSet(keccak256(abi.encode(p)));
    }

    function setOutflowThreshold(address asset, uint256 threshold, uint256 staleLimit) external onlyTimelock {
        _setOutflowThreshold(asset, threshold, staleLimit);
    }

    function setReleaseDelay(uint256 d) external onlyTimelock {
        releaseDelay = d;
    }

    function setGuardian(address g) external onlyTimelock {
        guardian = g;
        emit GuardianSet(g);
    }

    function setMonitor(address m) external onlyTimelock {
        monitor = m;
        emit MonitorSet(m);
    }

    function setRegistry(address r) external onlyTimelock {
        registry = IAttestationRegistry(r);
    }

    // ------------------------------------------------------------------ OutflowBreaker hooks

    function _breakerRegistry() internal view override returns (IAttestationRegistry) {
        return registry;
    }

    function _attestationMaxAge() internal view override returns (uint256) {
        return params.attestationMaxAgeBlocks;
    }

    function _isGuardian(address a) internal view override returns (bool) {
        return a == guardian && a != address(0);
    }

    function _isMonitor(address a) internal view override returns (bool) {
        return a == monitor && a != address(0);
    }

    // ------------------------------------------------------------------ protocol getters (GuardConfig)

    function _kronosBeforeAction() internal virtual {}
    function _kronosHealthBps(address account) internal view virtual returns (uint256);
    function _kronosLtvBps(address account) internal view virtual returns (uint256);
    function _kronosTotalAssets() internal view virtual returns (uint256);
    function _kronosTotalLiabilities() internal view virtual returns (uint256);
    function _kronosSharePrice() internal view virtual returns (uint256);
    function _kronosBadDebt() internal view virtual returns (uint256);
    function _kronosPricedAssets(address account) internal view virtual returns (address[] memory);
    function _kronosSpotPrice(address asset) internal view virtual returns (uint256);
    function _kronosBorrowedAgainst(address asset) internal view virtual returns (uint256);
    function _kronosCollateralCap(address asset) internal view virtual returns (uint256);
    function _kronosListedAt(address asset) internal view virtual returns (uint256);
    function _kronosAssetFrozen(address asset) internal view virtual returns (bool);
    function _kronosUnderwaterDebt() internal view virtual returns (uint256);
    function _kronosListedAssets() internal view virtual returns (address[] memory);

    // ------------------------------------------------------------------ utils

    function _recover(bytes32 h, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(h, v, r, s);
    }
}
