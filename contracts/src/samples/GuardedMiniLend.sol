// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GuardConfigMiniLend} from "./GuardConfig.MiniLend.sol";

/// @title GuardedMiniLend
/// @notice MiniLend after the Kronos integration PR: every user entry point takes a signed EIP-712 intent
///         and carries `guarded(kind, intent, sig)`; every privileged setter is owned by the GuardTimelock.
///         The function bodies only use values from the signed intent, so a hacked frontend or relayer can
///         push values within the intent's limits but can't redirect funds.
contract GuardedMiniLend is GuardConfigMiniLend {
    constructor(
        address base_,
        uint8 baseDecimals_,
        address timelock_,
        address registry_,
        address guardian_,
        address monitor_,
        GuardParams memory p
    ) GuardConfigMiniLend(base_, baseDecimals_, timelock_, registry_, guardian_, monitor_, p) {}

    function deposit(Intent calldata intent, bytes calldata sig) external guarded(Kind.Deposit, intent, sig) {
        _deposit(_kronosSigner(), intent.asset, intent.amount);
    }

    function withdraw(Intent calldata intent, bytes calldata sig) external guarded(Kind.Withdraw, intent, sig) {
        _withdraw(_kronosSigner(), _kronosRecipient(intent), intent.asset, intent.amount);
    }

    function borrow(Intent calldata intent, bytes calldata sig) external guarded(Kind.Borrow, intent, sig) {
        if (intent.asset != address(base)) revert NotListed(intent.asset);
        _borrow(_kronosSigner(), _kronosRecipient(intent), intent.amount);
    }

    function repay(Intent calldata intent, bytes calldata sig) external guarded(Kind.Repay, intent, sig) {
        _repay(_kronosSigner(), intent.account, intent.amount);
    }

    /// @dev intent.account = borrower, intent.asset = collateral to seize, intent.amount = base to repay.
    function liquidate(Intent calldata intent, bytes calldata sig) external guarded(Kind.Liquidate, intent, sig) {
        _liquidate(_kronosSigner(), _kronosRecipient(intent), intent.account, intent.asset, intent.amount);
    }
}
