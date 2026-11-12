import { connect, keyStores, KeyPair, type Account } from "near-api-js";
import { env, integrations } from "./env.js";
import { logger } from "./logger.js";

/**
 * NEAR registry client. The monitor agent's NEAR account holds a *function-call access key* scoped to the
 * registry contract and the single method `tighten` with zero deposit — it can pause a market or lower a
 * cap, and NEAR itself rejects anything else (loosen, unpause, transfers). That is the AI Security &
 * Defense showcase: the AI can only make things safer.
 */
export type TightenAction =
  | { Pause: { market: string | null } }
  | { LowerCap: { market: string; new_cap: string } }
  | { LowerOutflowThreshold: { asset: string; new_threshold: string } };

let account: Account | null = null;
const rpc = () => env.NEAR_RPC_URL ?? (env.NEAR_NETWORK === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org");

async function monitorAccount(): Promise<Account | null> {
  if (!integrations.nearMonitorKey) return null;
  if (account) return account;
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(env.NEAR_NETWORK, env.NEAR_ACCOUNT_ID!, KeyPair.fromString(env.NEAR_FUNCTION_CALL_KEY! as `ed25519:${string}`));
  const near = await connect({ networkId: env.NEAR_NETWORK, nodeUrl: rpc(), keyStore } as unknown as Parameters<typeof connect>[0]);
  account = await near.account(env.NEAR_ACCOUNT_ID!);
  return account;
}

/** Calls registry.tighten(protocol_id, action, reason) with the function-call key. */
export const nearRpcUrl = () => rpc();

export async function nearTighten(protocolId: string, action: TightenAction, reason: string): Promise<{ ok: boolean; tx?: string; error?: string; dryRun?: boolean }> {
  const acc = await monitorAccount();
  if (!acc) {
    logger.info({ protocolId, action, reason }, "NEAR monitor key not configured; would call registry.tighten");
    return { ok: true, dryRun: true };
  }
  try {
    const res = await acc.functionCall({
      contractId: env.NEAR_REGISTRY_CONTRACT,
      methodName: "tighten",
      args: { protocol_id: protocolId, action, reason: reason.slice(0, 200) },
      gas: 30_000_000_000_000n,
      attachedDeposit: 0n,
    });
    return { ok: true, tx: res.transaction_outcome.id };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

export type EvmTxArgs = { chain_id: string; nonce: string; max_priority_fee_per_gas: string; max_fee_per_gas: string; gas_limit: string };
export type MpcSignature = { scheme?: string; big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number };

/**
 * registry.tighten(..., evm) with the function-call key: the registry records the tighten, builds the EVM
 * `tightenOutflow` transaction itself and returns the MPC signer's signature over it (Chain Signatures).
 */
export async function nearTightenEvm(
  protocolId: string,
  action: Extract<TightenAction, { LowerOutflowThreshold: unknown }>,
  reason: string,
  evm: EvmTxArgs,
): Promise<{ ok: true; tx: string; signature: MpcSignature; payload: string | null; unsignedTx: string | null } | { ok: false; tx?: string; error: string }> {
  const acc = await monitorAccount();
  if (!acc) return { ok: false, error: "NEAR monitor key not configured" };
  let tx: string | undefined;
  try {
    const res = await acc.functionCall({
      contractId: env.NEAR_REGISTRY_CONTRACT,
      methodName: "tighten",
      args: { protocol_id: protocolId, action, reason: reason.slice(0, 200), evm },
      gas: 300_000_000_000_000n,
      attachedDeposit: 0n,
    });
    tx = res.transaction_outcome.id;
    const st = res.status as { SuccessValue?: string; Failure?: unknown };
    if (st.SuccessValue === undefined) return { ok: false, tx, error: `registry call failed: ${JSON.stringify(st.Failure ?? st).slice(0, 300)}` };
    const signature = JSON.parse(Buffer.from(st.SuccessValue, "base64").toString("utf8")) as MpcSignature;
    let payload: string | null = null;
    let unsignedTx: string | null = null;
    for (const r of res.receipts_outcome) {
      for (const l of r.outcome.logs) {
        if (!l.startsWith("EVENT_JSON:")) continue;
        const ev = JSON.parse(l.slice(11)) as { event: string; data: { payload: string; unsigned_tx: string }[] };
        if (ev.event === "evm_sign_request") ({ payload, unsigned_tx: unsignedTx } = ev.data[0]);
      }
    }
    if (!signature?.big_r?.affine_point) return { ok: false, tx, error: `unexpected signer response: ${st.SuccessValue.slice(0, 200)}` };
    return { ok: true, tx: tx!, signature, payload, unsignedTx };
  } catch (e) {
    return { ok: false, tx, error: String(e).slice(0, 400) };
  }
}

/** View call on any NEAR contract (the registry by default). */
export async function nearViewOn<T>(contract: string, method: string, args: Record<string, unknown>): Promise<T | null> {
  return nearViewImpl<T>(contract, method, args);
}

/** Demonstrates the key's limit: any non-tighten call is rejected by NEAR before execution. */
export async function nearTryLoosen(protocolId: string, market: string): Promise<{ rejected: boolean; error?: string }> {
  const acc = await monitorAccount();
  if (!acc) return { rejected: true, error: "no key configured (dry run)" };
  try {
    await acc.functionCall({
      contractId: env.NEAR_REGISTRY_CONTRACT,
      methodName: "unpause",
      args: { protocol_id: protocolId, market },
      gas: 30_000_000_000_000n,
      attachedDeposit: 0n,
    });
    return { rejected: false };
  } catch (e) {
    return { rejected: true, error: String(e).slice(0, 300) };
  }
}

export async function nearView<T>(method: string, args: Record<string, unknown>): Promise<T | null> {
  return nearViewImpl<T>(env.NEAR_REGISTRY_CONTRACT, method, args);
}

async function nearViewImpl<T>(contract: string, method: string, args: Record<string, unknown>): Promise<T | null> {
  try {
    const r = await fetch(rpc(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "kronos",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: contract,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
    });
    const body = (await r.json()) as { result?: { result: number[] } };
    if (!body.result) return null;
    return JSON.parse(Buffer.from(body.result.result).toString("utf8")) as T;
  } catch {
    return null;
  }
}
