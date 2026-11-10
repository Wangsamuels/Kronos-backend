//! SP1 guest: proves one per-block attestation. Public output = AttestationRegistry.payloadHash(...).
#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_primitives::{keccak256, Address, U256};
use alloy_sol_types::SolValue;
use kronos_attest_core::{attest, AssetInput, Input, Sample};

pub fn main() {
    let chain_id: u64 = sp1_zkvm::io::read();
    let registry: [u8; 20] = sp1_zkvm::io::read();
    let protocol: [u8; 20] = sp1_zkvm::io::read();
    let block: u64 = sp1_zkvm::io::read();
    let assets: Vec<[u8; 20]> = sp1_zkvm::io::read();
    // per asset: per source: (ts, price) samples, then the spot
    let samples: Vec<Vec<Vec<(u64, u128)>>> = sp1_zkvm::io::read();
    let spots: Vec<u128> = sp1_zkvm::io::read();
    let (total_assets, total_liabilities, max_dev): (u128, u128, u128) = sp1_zkvm::io::read();

    let input = Input {
        assets: samples
            .into_iter()
            .zip(spots)
            .map(|(srcs, spot)| AssetInput {
                sources: srcs.into_iter().map(|s| s.into_iter().map(|(ts, price)| Sample { ts, price }).collect()).collect(),
                spot,
            })
            .collect(),
        total_assets,
        total_liabilities,
        max_deviation_bps: max_dev,
        min_sources: 2,
    };
    let out = attest(&input);
    let assets: Vec<Address> = assets.into_iter().map(Address::from).collect();
    let twaps: Vec<U256> = out.twaps.iter().map(|t| U256::from(*t)).collect();
    let encoded = (
        U256::from(chain_id),
        Address::from(registry),
        Address::from(protocol),
        U256::from(block),
        out.oracle_ok,
        out.solvency_ok,
        assets,
        twaps,
    )
        .abi_encode_params();
    sp1_zkvm::io::commit_slice(keccak256(encoded).as_slice());
}
