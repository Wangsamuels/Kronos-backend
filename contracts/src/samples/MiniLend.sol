// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MiniLendCore} from "./MiniLendCore.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeTransfer} from "../SafeTransfer.sol";

/// @title MiniLend (unguarded)
/// @notice The demo protocol exactly as a team would submit it to Kronos: plain entry points, owner admin.
///         All three demo attacks (oracle pump, share inflation, fake collateral) succeed against it.
contract MiniLend is MiniLendCore {
    using SafeTransfer for IERC20;

    address public owner;

    constructor(address base_, uint8 baseDecimals_, address owner_) MiniLendCore(base_, baseDecimals_) {
        owner = owner_;
    }

    function deposit(address asset, uint256 amount) external {
        _deposit(msg.sender, asset, amount);
    }

    function withdraw(address asset, uint256 amount) external {
        _withdraw(msg.sender, msg.sender, asset, amount);
    }

    function borrow(uint256 amount) external {
        _borrow(msg.sender, msg.sender, amount);
    }

    function repay(uint256 amount) external {
        _repay(msg.sender, msg.sender, amount);
    }

    function liquidate(address borrower, address asset, uint256 repayAmount) external {
        _liquidate(msg.sender, msg.sender, borrower, asset, repayAmount);
    }

    function _checkAdmin() internal view override {
        if (msg.sender != owner) revert NotAdmin();
    }

    function _payout(address asset, address to, uint256 amount) internal override {
        IERC20(asset).safeTransfer(to, amount);
    }

    function _onInflow(address, uint256) internal override {}

    function _pendingBase() internal pure override returns (uint256) {
        return 0;
    }
}
