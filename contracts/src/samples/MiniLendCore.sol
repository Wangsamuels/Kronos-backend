// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";
import {SafeTransfer} from "../SafeTransfer.sol";

interface IPriceOracle {
    /// @return price of one whole `asset` token in whole base tokens, scaled 1e18 ($2.00 => 2e18)
    function price(address asset) external view returns (uint256);
}

/// @title MiniLendCore
/// @notice Compound-style demo lending protocol used by Kronos for demos and analysis. Suppliers deposit the
///         base asset (USDC) for shares; borrowers post ONE collateral asset per account and borrow base.
///         It is deliberately vulnerable in the classic ways:
///           - exchange rate uses the raw token balance (donation / share-inflation attack)
///           - prices come straight from a per-asset oracle that may be a thin AMM pool (oracle pump)
///           - the admin can list any asset with any oracle instantly (fake-collateral listing)
///         `MiniLend` exposes it unguarded; `GuardedMiniLend` is what the Kronos integration PR produces.
abstract contract MiniLendCore {
    using SafeTransfer for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 public constant LIQUIDATION_BONUS_BPS = 500;
    uint256 public constant MAX_ACCOUNTS = 500;

    struct Market {
        bool listed;
        bool frozen;
        IPriceOracle oracle;
        uint8 decimals;
        uint256 collateralFactorBps;
        uint256 cap; // max base borrowed against this collateral
        uint256 listedAt;
        uint256 totalCollateral;
        uint256 debtNorm; // sum of normalized debt of accounts using this collateral
    }

    struct Account {
        address collateralAsset;
        uint256 collateral;
        uint256 debtNorm;
    }

    error Paused();
    error NotListed(address asset);
    error MarketFrozen(address asset);
    error WrongCollateral(address expected, address got);
    error InsufficientCollateral();
    error InsufficientShares();
    error InsufficientCash();
    error Healthy();
    error NotAdmin();
    error NotLower();
    error TooManyAccounts();
    error ZeroAmount();

    event Supplied(address indexed account, uint256 amount, uint256 shares);
    event Redeemed(address indexed account, address indexed to, uint256 amount, uint256 shares);
    event CollateralDeposited(address indexed account, address indexed asset, uint256 amount);
    event CollateralWithdrawn(address indexed account, address indexed to, address indexed asset, uint256 amount);
    event Borrowed(address indexed account, address indexed to, uint256 amount);
    event Repaid(address indexed account, uint256 amount);
    event Liquidated(address indexed borrower, address indexed liquidator, uint256 repaid, uint256 seized, uint256 badDebt);
    event MarketListed(address indexed asset, address oracle, uint256 collateralFactorBps, uint256 cap);
    event OracleSet(address indexed asset, address oracle);
    event CollateralFactorSet(address indexed asset, uint256 bps);
    event CapSet(address indexed asset, uint256 cap);
    event FrozenSet(address indexed asset, bool frozen);
    event PausedSet(bool paused);
    event BorrowRateSet(uint256 ratePerSecond);

    IERC20 public immutable base;
    uint8 public immutable baseDecimals;

    bool public paused;
    uint256 public borrowRatePerSecond; // WAD
    uint256 public borrowIndex = WAD;
    uint256 public lastAccrual;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    uint256 public totalDeposits; // supplier liabilities ledger (principal + accrued interest)
    uint256 public totalDebtNorm;
    uint256 public badDebt;

    mapping(address => Market) public markets;
    address[] public marketList;
    mapping(address => Account) public accounts;
    address[] public accountList;
    mapping(address => bool) internal _known;

    constructor(address base_, uint8 baseDecimals_) {
        base = IERC20(base_);
        baseDecimals = baseDecimals_;
        lastAccrual = block.timestamp;
    }

    // ------------------------------------------------------------------ hooks

    function _checkAdmin() internal view virtual;
    function _payout(address asset, address to, uint256 amount) internal virtual;
    function _onInflow(address asset, uint256 amount) internal virtual;
    function _pendingBase() internal view virtual returns (uint256);

    modifier onlyAdmin() {
        _checkAdmin();
        _;
    }

    // ------------------------------------------------------------------ views

    function cash() public view returns (uint256) {
        return base.balanceOf(address(this)) - _pendingBase();
    }

    function totalBorrows() public view returns (uint256) {
        return (totalDebtNorm * borrowIndex) / WAD;
    }

    /// @notice WAD-scaled base per share. Uses the raw balance (vulnerable to donations by design).
    function exchangeRate() public view returns (uint256) {
        if (totalShares == 0) return 0;
        return ((cash() + totalBorrows()) * WAD) / totalShares;
    }

    function debtOf(address a) public view returns (uint256) {
        return (accounts[a].debtNorm * borrowIndex) / WAD;
    }

    function priceOf(address asset) public view returns (uint256) {
        return markets[asset].oracle.price(asset);
    }

    function collateralValue(address a) public view returns (uint256) {
        Account storage acc = accounts[a];
        if (acc.collateral == 0) return 0;
        Market storage m = markets[acc.collateralAsset];
        return (acc.collateral * m.oracle.price(acc.collateralAsset) * (10 ** baseDecimals))
            / (WAD * (10 ** m.decimals));
    }

    /// @return health factor in bps (10_000 = 1.0); max uint when there is no debt
    function healthBps(address a) public view returns (uint256) {
        uint256 d = debtOf(a);
        if (d == 0) return type(uint256).max;
        uint256 cf = markets[accounts[a].collateralAsset].collateralFactorBps;
        return (collateralValue(a) * cf) / d;
    }

    function ltvBps(address a) public view returns (uint256) {
        uint256 d = debtOf(a);
        if (d == 0) return 0;
        uint256 v = collateralValue(a);
        if (v == 0) return type(uint256).max;
        return (d * BPS) / v;
    }

    function borrowedAgainst(address asset) public view returns (uint256) {
        return (markets[asset].debtNorm * borrowIndex) / WAD;
    }

    function underwaterDebt() public view returns (uint256 total) {
        for (uint256 i; i < accountList.length; i++) {
            address a = accountList[i];
            if (accounts[a].debtNorm != 0 && healthBps(a) < BPS) total += debtOf(a);
        }
    }

    function marketsCount() external view returns (uint256) {
        return marketList.length;
    }

    // ------------------------------------------------------------------ interest

    function accrue() public {
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0) return;
        lastAccrual = block.timestamp;
        if (totalDebtNorm == 0 || borrowRatePerSecond == 0) return;
        uint256 before = totalBorrows();
        borrowIndex += (borrowIndex * borrowRatePerSecond * dt) / WAD;
        totalDeposits += totalBorrows() - before;
    }

    // ------------------------------------------------------------------ core logic

    function _touch(address a) internal {
        if (!_known[a]) {
            if (accountList.length >= MAX_ACCOUNTS) revert TooManyAccounts();
            _known[a] = true;
            accountList.push(a);
        }
    }

    function _deposit(address from, address asset, uint256 amount) internal {
        if (paused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        accrue();
        _touch(from);
        if (asset == address(base)) {
            uint256 rate = exchangeRate();
            uint256 shares = rate == 0 ? amount : (amount * WAD) / rate;
            base.safeTransferFrom(from, address(this), amount);
            totalShares += shares;
            sharesOf[from] += shares;
            totalDeposits += amount;
            _onInflow(asset, amount);
            emit Supplied(from, amount, shares);
        } else {
            Market storage m = markets[asset];
            if (!m.listed) revert NotListed(asset);
            if (m.frozen) revert MarketFrozen(asset);
            Account storage acc = accounts[from];
            if (acc.collateralAsset == address(0)) acc.collateralAsset = asset;
            else if (acc.collateralAsset != asset) revert WrongCollateral(acc.collateralAsset, asset);
            IERC20(asset).safeTransferFrom(from, address(this), amount);
            acc.collateral += amount;
            m.totalCollateral += amount;
            _onInflow(asset, amount);
            emit CollateralDeposited(from, asset, amount);
        }
    }

    function _withdraw(address account, address to, address asset, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        accrue();
        if (asset == address(base)) {
            uint256 rate = exchangeRate();
            uint256 shares = (amount * WAD + rate - 1) / rate; // round up against the redeemer
            if (sharesOf[account] < shares) revert InsufficientShares();
            if (cash() < amount) revert InsufficientCash();
            sharesOf[account] -= shares;
            totalShares -= shares;
            totalDeposits -= amount > totalDeposits ? totalDeposits : amount;
            emit Redeemed(account, to, amount, shares);
            _payout(asset, to, amount);
        } else {
            Account storage acc = accounts[account];
            if (acc.collateralAsset != asset || acc.collateral < amount) revert InsufficientCollateral();
            acc.collateral -= amount;
            markets[asset].totalCollateral -= amount;
            // protocol's own check, using its own (possibly manipulated) oracle
            if (healthBps(account) < BPS) revert InsufficientCollateral();
            if (acc.collateral == 0 && acc.debtNorm == 0) acc.collateralAsset = address(0);
            emit CollateralWithdrawn(account, to, asset, amount);
            _payout(asset, to, amount);
        }
    }

    function _borrow(address account, address to, uint256 amount) internal {
        if (paused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        accrue();
        Account storage acc = accounts[account];
        if (acc.collateralAsset == address(0)) revert InsufficientCollateral();
        Market storage m = markets[acc.collateralAsset];
        if (m.frozen) revert MarketFrozen(acc.collateralAsset);
        if (cash() < amount) revert InsufficientCash();
        uint256 norm = (amount * WAD + borrowIndex - 1) / borrowIndex;
        acc.debtNorm += norm;
        m.debtNorm += norm;
        totalDebtNorm += norm;
        // protocol's own check, using its own (possibly manipulated) oracle
        if (healthBps(account) < BPS) revert InsufficientCollateral();
        emit Borrowed(account, to, amount);
        _payout(address(base), to, amount);
    }

    function _repay(address payer, address account, uint256 amount) internal returns (uint256 paid) {
        accrue();
        uint256 debt = debtOf(account);
        paid = amount > debt ? debt : amount;
        if (paid == 0) revert ZeroAmount();
        base.safeTransferFrom(payer, address(this), paid);
        _reduceDebt(account, paid, debt);
        _onInflow(address(base), paid);
        emit Repaid(account, paid);
    }

    function _reduceDebt(address account, uint256 paid, uint256 debt) internal {
        Account storage acc = accounts[account];
        uint256 norm = paid == debt ? acc.debtNorm : (paid * WAD) / borrowIndex;
        acc.debtNorm -= norm;
        markets[acc.collateralAsset].debtNorm -= norm;
        totalDebtNorm -= norm;
    }

    function _liquidate(address liquidator, address to, address borrower, address asset, uint256 repayAmount)
        internal
    {
        accrue();
        if (healthBps(borrower) >= BPS) revert Healthy();
        Account storage acc = accounts[borrower];
        if (acc.collateralAsset != asset) revert WrongCollateral(acc.collateralAsset, asset);
        uint256 debt = debtOf(borrower);
        uint256 paid = repayAmount > debt ? debt : repayAmount;
        Market storage m = markets[asset];
        uint256 seize = (paid * (BPS + LIQUIDATION_BONUS_BPS) * WAD * (10 ** m.decimals))
            / (BPS * m.oracle.price(asset) * (10 ** baseDecimals));
        if (seize > acc.collateral) seize = acc.collateral;
        base.safeTransferFrom(liquidator, address(this), paid);
        _reduceDebt(borrower, paid, debt);
        _onInflow(address(base), paid);
        acc.collateral -= seize;
        m.totalCollateral -= seize;
        uint256 written;
        if (acc.collateral == 0 && acc.debtNorm != 0) {
            // write off remaining bad debt; suppliers absorb it
            written = debtOf(borrower);
            _reduceDebt(borrower, written, written);
            badDebt += written;
            totalDeposits -= written > totalDeposits ? totalDeposits : written;
        }
        emit Liquidated(borrower, liquidator, paid, seize, written);
        _payout(asset, to, seize);
    }

    // ------------------------------------------------------------------ privileged settings
    // In GuardedMiniLend every one of these is owned by the GuardTimelock and tiered.

    function listAsset(address asset, address oracle, uint8 decimals, uint256 cfBps, uint256 cap) external onlyAdmin {
        Market storage m = markets[asset];
        if (!m.listed) marketList.push(asset);
        m.listed = true;
        m.oracle = IPriceOracle(oracle);
        m.decimals = decimals;
        m.collateralFactorBps = cfBps;
        m.cap = cap;
        m.listedAt = block.timestamp;
        emit MarketListed(asset, oracle, cfBps, cap);
    }

    function setOracle(address asset, address oracle) external onlyAdmin {
        if (!markets[asset].listed) revert NotListed(asset);
        markets[asset].oracle = IPriceOracle(oracle);
        markets[asset].listedAt = block.timestamp; // a changed oracle restarts probation
        emit OracleSet(asset, oracle);
    }

    function setCollateralFactor(address asset, uint256 bps) external onlyAdmin {
        markets[asset].collateralFactorBps = bps;
        emit CollateralFactorSet(asset, bps);
    }

    function lowerCollateralFactor(address asset, uint256 bps) external onlyAdmin {
        if (bps >= markets[asset].collateralFactorBps) revert NotLower();
        markets[asset].collateralFactorBps = bps;
        emit CollateralFactorSet(asset, bps);
    }

    function setCap(address asset, uint256 cap) external onlyAdmin {
        markets[asset].cap = cap;
        emit CapSet(asset, cap);
    }

    function lowerCap(address asset, uint256 cap) external onlyAdmin {
        if (cap >= markets[asset].cap) revert NotLower();
        markets[asset].cap = cap;
        emit CapSet(asset, cap);
    }

    function freezeAsset(address asset) external onlyAdmin {
        markets[asset].frozen = true;
        emit FrozenSet(asset, true);
    }

    function unfreezeAsset(address asset) external onlyAdmin {
        markets[asset].frozen = false;
        emit FrozenSet(asset, false);
    }

    function pause() external onlyAdmin {
        paused = true;
        emit PausedSet(true);
    }

    function unpause() external onlyAdmin {
        paused = false;
        emit PausedSet(false);
    }

    function setBorrowRate(uint256 ratePerSecond) external onlyAdmin {
        accrue();
        borrowRatePerSecond = ratePerSecond;
        emit BorrowRateSet(ratePerSecond);
    }
}
