// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read interface the guard uses on every guarded call (one storage read per lookup).
interface IAttestationRegistry {
    struct Attestation {
        uint64 blockNumber; // block the attestation was computed at
        uint64 timestamp; // time it was posted
        bool oracleOk; // TWAP / multi-source agreement held for every asset
        bool solvencyOk; // aggregate assets >= liabilities across all positions
        bytes32 proofRef; // MVP: hash of the signed payload. Stretch: Groth16 proof id
    }

    function latest(address protocol) external view returns (Attestation memory);
    function twapOf(address protocol, address asset) external view returns (uint256);
    function isFresh(address protocol, uint256 maxAgeBlocks) external view returns (bool);
}
