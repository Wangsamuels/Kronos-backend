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
          account_id: env.NEAR_REGISTRY_CONTRACT,
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
