// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAttestationRegistry} from "./interfaces/IAttestationRegistry.sol";

/// @notice Optional Groth16 verifier (stretch goal: SP1 -> Groth16). Unset in the MVP.
interface IProofVerifier {
    function verify(bytes calldata publicValues, bytes calldata proof) external view returns (bool);
}

/// @title AttestationRegistry
/// @notice Stores the latest oracle + solvency attestation per protocol. The attestor service computes the
///         heavy checks off-chain once per block and posts one result; user transactions only read it.
///         MVP: ECDSA signature from the attestor key. Stretch: a Groth16 proof checked by `proofVerifier`.
contract AttestationRegistry is IAttestationRegistry {
    error NotOwner();
    error BadSignature();
    error StaleAttestation(uint64 got, uint64 latestBlock);
    error LengthMismatch();
    error ProofRejected();

    event AttestorChanged(address indexed attestor);
    event VerifierChanged(address indexed verifier);
    event AttestationPosted(
        address indexed protocol, uint64 blockNumber, bool oracleOk, bool solvencyOk, bytes32 proofRef
    );

    address public owner; // should be a GuardTimelock (Tier 3) in production
    address public attestor;
    IProofVerifier public proofVerifier;

    mapping(address => Attestation) internal _latest;
    mapping(address => mapping(address => uint256)) internal _twap;

    constructor(address owner_, address attestor_) {
        owner = owner_;
        attestor = attestor_;
        emit AttestorChanged(attestor_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setAttestor(address a) external onlyOwner {
        attestor = a;
        emit AttestorChanged(a);
    }

    function setProofVerifier(address v) external onlyOwner {
        proofVerifier = IProofVerifier(v);
        emit VerifierChanged(v);
    }

    function transferOwnership(address o) external onlyOwner {
        owner = o;
    }

    /// @notice Digest the attestor signs (EIP-191 personal_sign over this hash).
    function payloadHash(
        address protocol,
        uint64 blockNumber,
        bool oracleOk,
        bool solvencyOk,
        address[] calldata assets,
        uint256[] calldata twaps
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(this), protocol, blockNumber, oracleOk, solvencyOk, assets, twaps)
        );
    }

    /// @notice MVP path: post a signed attestation.
    function post(
        address protocol,
        uint64 blockNumber,
        bool oracleOk,
        bool solvencyOk,
        address[] calldata assets,
        uint256[] calldata twaps,
        bytes calldata signature
    ) external {
        if (assets.length != twaps.length) revert LengthMismatch();
        bytes32 h = payloadHash(protocol, blockNumber, oracleOk, solvencyOk, assets, twaps);
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
        if (_recover(ethHash, signature) != attestor) revert BadSignature();
        _store(protocol, blockNumber, oracleOk, solvencyOk, assets, twaps, h);
    }

    /// @notice Stretch path: post with a Groth16 proof whose public values commit to the same payload.
    function postWithProof(
        address protocol,
        uint64 blockNumber,
        bool oracleOk,
        bool solvencyOk,
        address[] calldata assets,
        uint256[] calldata twaps,
        bytes calldata proof
    ) external {
        if (assets.length != twaps.length) revert LengthMismatch();
        bytes32 h = payloadHash(protocol, blockNumber, oracleOk, solvencyOk, assets, twaps);
        if (address(proofVerifier) == address(0) || !proofVerifier.verify(abi.encode(h), proof)) {
            revert ProofRejected();
        }
        _store(protocol, blockNumber, oracleOk, solvencyOk, assets, twaps, h);
    }

    function _store(
        address protocol,
        uint64 blockNumber,
        bool oracleOk,
        bool solvencyOk,
        address[] calldata assets,
        uint256[] calldata twaps,
        bytes32 ref
    ) internal {
        Attestation storage cur = _latest[protocol];
        if (blockNumber <= cur.blockNumber || blockNumber > block.number) {
            revert StaleAttestation(blockNumber, cur.blockNumber);
        }
        cur.blockNumber = blockNumber;
        cur.timestamp = uint64(block.timestamp);
        cur.oracleOk = oracleOk;
        cur.solvencyOk = solvencyOk;
        cur.proofRef = ref;
        for (uint256 i = 0; i < assets.length; i++) {
            _twap[protocol][assets[i]] = twaps[i];
        }
        emit AttestationPosted(protocol, blockNumber, oracleOk, solvencyOk, ref);
    }

    function latest(address protocol) external view returns (Attestation memory) {
        return _latest[protocol];
    }

    function twapOf(address protocol, address asset) external view returns (uint256) {
        return _twap[protocol][asset];
    }

    function isFresh(address protocol, uint256 maxAgeBlocks) external view returns (bool) {
        Attestation storage a = _latest[protocol];
        if (a.blockNumber == 0) return false;
        return block.number - a.blockNumber <= maxAgeBlocks && a.oracleOk && a.solvencyOk;
    }

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
