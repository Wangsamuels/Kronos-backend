import { base58 } from "@scure/base";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { env, integrations } from "./env.js";
import { logger } from "./logger.js";
import { publicClient } from "./chains.js";
import { kronosGuardAbi } from "./abi.generated.js";
import { nearTightenEvm, nearViewOn } from "./near.js";

/**
 * NEAR Chain Signatures for EVM tightens.
 *
 * The registry contract on NEAR derives one EVM address per protocol from NEAR's MPC network
 * (predecessor = registry, path = kronos/<protocol id>). That address holds the guard's `monitor` role, which
 * can only lower outflow thresholds (`tightenOutflow`, contract-enforced). The monitor agent never holds an
 * EVM key: it asks the registry (with its tighten-only NEAR function-call key) to tighten, the registry
 * builds the exact EVM transaction and has the MPC network sign it, and the agent only broadcasts.
 */

export const mpcSigner = () => env.NEAR_MPC_SIGNER ?? (env.NEAR_NETWORK === "mainnet" ? "v1.signer" : "v1.signer-prod.testnet");
export const mpcPath = (protocolId: string) => `kronos/${protocolId}`;

const derived = new Map<string, Address>();

/** The EVM address NEAR's MPC network controls for this protocol (same address on every EVM chain). */
export async function derivedEvmAddress(protocolId: string): Promise<Address | null> {
  const hit = derived.get(protocolId);
  if (hit) return hit;
  const pk = await nearViewOn<string>(mpcSigner(), "derived_public_key", {
    path: mpcPath(protocolId),
    predecessor: env.NEAR_REGISTRY_CONTRACT,
    domain_id: 0,
  });
  if (!pk?.startsWith("secp256k1:")) return null;
  const raw = base58.decode(pk.slice("secp256k1:".length)); // 64 bytes: x || y (uncompressed, no 0x04)
  if (raw.length !== 64) return null;
  const addr = getAddress(`0x${keccak256(raw).slice(-40)}`);
  derived.set(protocolId, addr);
  return addr;
}

/** True when this deployment's guard has the protocol's MPC-derived address as its monitor. */
export async function chainSigReady(chainId: number, guard: Address, protocolId: string): Promise<{ ready: boolean; address: Address | null; monitor: Address | null }> {
  if (!integrations.chainSignatures) return { ready: false, address: null, monitor: null };
  const address = await derivedEvmAddress(protocolId).catch(() => null);
  let monitor: Address | null = null;
  try {
    monitor = getAddress((await publicClient(chainId).readContract({ address: guard, abi: kronosGuardAbi, functionName: "monitor" })) as Address);
  } catch {
    /* guard without a monitor() view */
  }
  return { ready: Boolean(address && monitor && address === monitor), address, monitor };
}

export type ChainSigResult =
  | { ok: true; via: "chain-signatures"; signer: Address; nearTx: string; evmTx: Hex }
  | { ok: false; via: "chain-signatures"; signer: Address | null; nearTx?: string; error: string };

/** Lowers `asset`'s outflow threshold on `guard` through the registry + MPC signer, then broadcasts. */
export async function chainSigTightenOutflow(args: {
  chainId: number;
  guard: Address;
  protocolId: string;
  asset: Address;
  newThreshold: bigint;
  reason: string;
}): Promise<ChainSigResult> {
  const { chainId, guard, protocolId, asset, newThreshold, reason } = args;
  const fail = (error: string, signer: Address | null = null, nearTx?: string): ChainSigResult => ({ ok: false, via: "chain-signatures", signer, nearTx, error });
  const from = await derivedEvmAddress(protocolId);
  if (!from) return fail("could not derive the MPC address (signer view failed)");
  const c = publicClient(chainId);
  const data = encodeFunctionData({ abi: kronosGuardAbi, functionName: "tightenOutflow", args: [asset, newThreshold] });

  // Simulate first: a NotTighter / NotMonitor revert must stop us before anything is signed.
  let gas: bigint;
  try {
    gas = ((await c.estimateGas({ account: from, to: guard, data })) * 13n) / 10n;
  } catch (e) {
    return fail(`simulation reverted: ${String((e as Error).message).split("\n")[0].slice(0, 200)}`, from);
  }
  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  try {
    const f = await c.estimateFeesPerGas();
    maxFeePerGas = f.maxFeePerGas;
    maxPriorityFeePerGas = f.maxPriorityFeePerGas;
  } catch {
    maxFeePerGas = ((await c.getGasPrice()) * 12n) / 10n;
    maxPriorityFeePerGas = maxFeePerGas;
  }
  if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
  const balance = await c.getBalance({ address: from });
  if (balance < gas * maxFeePerGas) return fail(`derived address ${from} needs gas: has ${balance} wei, needs ${gas * maxFeePerGas}`, from);
  const nonce = await c.getTransactionCount({ address: from, blockTag: "pending" });

  const tx: TransactionSerializableEIP1559 = {
    type: "eip1559",
    chainId,
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gas,
    to: guard,
    value: 0n,
    data,
    accessList: [],
  };
  const unsigned = serializeTransaction(tx);

  const near = await nearTightenEvm(
    protocolId,
    { LowerOutflowThreshold: { asset: asset.toLowerCase(), new_threshold: newThreshold.toString() } },
    reason,
    {
      chain_id: String(chainId),
      nonce: String(nonce),
      max_priority_fee_per_gas: maxPriorityFeePerGas.toString(),
      max_fee_per_gas: maxFeePerGas.toString(),
      gas_limit: gas.toString(),
    },
  );
  if (!near.ok) return fail(near.error, from, near.tx);
  // The registry built the transaction itself; ours must be byte-identical or the signature is for something else.
  if (near.unsignedTx && `0x${near.unsignedTx}` !== unsigned.toLowerCase()) {
    return fail(`registry built a different transaction than expected (${near.unsignedTx.slice(0, 24)}… vs ${unsigned.slice(2, 26)}…)`, from, near.tx);
  }

  const ap = near.signature.big_r.affine_point;
  const signed = serializeTransaction(tx, {
    r: `0x${ap.slice(-64)}`,
    s: `0x${near.signature.s.scalar.padStart(64, "0")}`,
    yParity: near.signature.recovery_id,
  });
  const recovered = await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` });
  if (recovered !== from) return fail(`MPC signature recovers to ${recovered}, expected ${from}`, from, near.tx);

  try {
    const hash = await c.sendRawTransaction({ serializedTransaction: signed });
    const rcpt = await c.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (rcpt.status !== "success") return fail(`EVM transaction ${hash} reverted`, from, near.tx);
    logger.info({ chainId, guard, asset, newThreshold: newThreshold.toString(), nearTx: near.tx, evmTx: hash }, "Chain Signatures tighten executed");
    return { ok: true, via: "chain-signatures", signer: from, nearTx: near.tx, evmTx: hash };
  } catch (e) {
    return fail(`broadcast failed: ${String((e as Error).message).split("\n")[0].slice(0, 200)}`, from, near.tx);
  }
}
