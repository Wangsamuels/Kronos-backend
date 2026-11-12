#!/usr/bin/env bash
# Deploys the Kronos registry to NEAR testnet and gives the monitor agent a tighten-only key.
# Requires near-cli-rs (`cargo install near-cli-rs`) and cargo-near (`cargo install cargo-near`).
set -euo pipefail
REGISTRY=${REGISTRY:-kronos.testnet}      # contract account
OWNER=${OWNER:-$REGISTRY}                 # registry owner
MONITOR=${MONITOR:-kronos-monitor.testnet} # the monitoring agent's account

cargo near build non-reproducible-wasm
near contract deploy "$REGISTRY" use-file target/near/kronos_registry.wasm \
  with-init-call new json-args "{\"owner\":\"$OWNER\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send

near contract call-function as-transaction "$REGISTRY" add_monitor json-args "{\"account_id\":\"$MONITOR\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config testnet sign-with-keychain send

# Function-call access key: receiver = the registry, methods = ["tighten"], no deposit allowed.
# Put the printed private key in NEAR_FUNCTION_CALL_KEY and $MONITOR in NEAR_ACCOUNT_ID on Heroku.
near account add-key "$MONITOR" grant-function-call-access --allowance '0.25 NEAR' \
  --contract-account-id "$REGISTRY" --function-names 'tighten' autogenerate-new-keypair \
  print-to-terminal network-config testnet sign-with-keychain send

# Chain Signatures: the registry signs EVM tightens through NEAR's MPC signer (default v1.signer-prod.testnet).
# The protocol's EVM monitor address is printed by: npx tsx scripts/kronos-cli.ts chainsig-address <protocol uuid>
