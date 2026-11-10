# Kronos prover (stretch goal)

The MVP attestor posts **signed** attestations (`worker/attestor.ts` → `AttestationRegistry.post`).
The stretch goal replaces the signature with a proof: the same checks run inside SP1, the proof is wrapped
in Groth16, and `AttestationRegistry.postWithProof` verifies it on-chain through `IProofVerifier`.

- `attest-core/` — the attestation logic as a plain Rust library (TWAP, spot/TWAP agreement across ≥2
  sources, aggregate solvency). It is what the SP1 program commits to, and it is unit-tested here
  (`cargo test`), mirroring `decide()` in `worker/attestor.ts`.
- `program/` — the SP1 guest program (`sp1_zkvm::entrypoint!`). It reads the per-block inputs, calls
  `attest-core`, and commits `keccak256(abi.encode(chainid, registry, protocol, block, oracleOk,
  solvencyOk, assets, twaps))` — exactly `AttestationRegistry.payloadHash`, so the on-chain check is the
  same for signed and proven attestations.

Build the guest with the SP1 toolchain (`curl -L https://sp1up.succinct.xyz | bash && sp1up`, then
`cd program && cargo prove build`) and generate a Groth16 proof with the SP1 SDK or the Succinct prover
network. Not part of the hackathon MVP; nothing in the README claims it runs.
