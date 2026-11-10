// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Surface every Kronos-guarded protocol exposes to the timelock and to deployment verification.
interface IKronosGuarded {
    /// @dev Snapshot the timelock takes before executing a privileged change.
    function kronosAdminSnapshot() external view returns (uint256 underwaterDebt);

    /// @dev Called by the timelock right after a privileged change. Reverts if the change broke an invariant.
    function kronosCheckAdmin(uint256 underwaterDebtBefore) external view;

    /// @dev keccak256(abi.encode(GuardParams)) — must match the approved package's config hash.
    function kronosConfigHash() external view returns (bytes32);

    /// @dev The timelock that owns every privileged role.
    function kronosTimelock() external view returns (address);
}
