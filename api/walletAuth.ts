import crypto from "node:crypto";
import { parseSiweMessage, verifySiweMessage } from "viem/siwe";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../lib/env.js";
import { badRequest, unauthorized } from "../lib/errors.js";
import { publicClient, SUPPORTED_CHAIN_IDS } from "../lib/chains.js";

export async function createNonce(): Promise<string> {
  const nonce = crypto.randomBytes(16).toString("hex");
  await db.insert(schema.authNonces).values({ nonce, expiresAt: new Date(Date.now() + 10 * 60_000) });
  return nonce;
}

async function consumeNonce(nonce: string) {
  const res = await db
    .update(schema.authNonces)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.authNonces.nonce, nonce), isNull(schema.authNonces.usedAt), gt(schema.authNonces.expiresAt, new Date())))
    .returning();
  if (res.length === 0) throw unauthorized("Nonce invalid, expired or already used");
}

/** Sign-In With Ethereum (EIP-4361). Supports EOAs and, via the chain's RPC, ERC-1271 smart accounts. */
export async function verifySiwe(message: string, signature: `0x${string}`): Promise<string> {
  const parsed = parseSiweMessage(message);
  if (!parsed.address || !parsed.nonce) throw badRequest("Malformed SIWE message");
  const frontendHost = new URL(env.FRONTEND_URL).host;
  if (parsed.domain && parsed.domain !== frontendHost && env.NODE_ENV === "production") {
    throw unauthorized(`SIWE domain must be ${frontendHost}`);
  }
  const chainId = parsed.chainId ?? 1;
  const client = SUPPORTED_CHAIN_IDS.includes(chainId)
    ? publicClient(chainId)
    : createPublicClient({ chain: mainnet, transport: http() });
  const ok = await verifySiweMessage(client, { message, signature, nonce: parsed.nonce });
  if (!ok) throw unauthorized("Bad SIWE signature");
  await consumeNonce(parsed.nonce);
  return parsed.address.toLowerCase();
}

/**
 * NEAR wallet sign-in (NEP-413 signMessage). Verifies the ed25519 signature over the borsh payload and
 * that the public key is a full-access key of the account (via NEAR RPC).
 */
export async function verifyNear(input: {
  accountId: string;
  publicKey: string; // "ed25519:<base58>"
  signature: string; // base64
  message: string;
  nonce: string; // the server nonce (hex, 32 bytes after padding) used as the NEP-413 nonce
  recipient: string;
  callbackUrl?: string;
}): Promise<string> {
  const nonceBytes = Buffer.alloc(32);
  Buffer.from(input.nonce, "hex").copy(nonceBytes);
  const payload = borshNep413(input.message, nonceBytes, input.recipient, input.callbackUrl);
  const hash = sha256(payload);
  if (!input.publicKey.startsWith("ed25519:")) throw badRequest("Only ed25519 keys are supported");
  const pk = base58Decode(input.publicKey.slice(8));
  const sig = Buffer.from(input.signature, "base64");
  if (!ed25519.verify(new Uint8Array(sig), hash, pk)) throw unauthorized("Bad NEAR signature");

  const rpc = env.NEAR_RPC_URL ?? (env.NEAR_NETWORK === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org");
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "kronos",
      method: "query",
      params: { request_type: "view_access_key", finality: "final", account_id: input.accountId, public_key: input.publicKey },
    }),
  });
  const body = (await r.json()) as { result?: { permission?: unknown }; error?: unknown };
  if (!body.result || body.result.permission !== "FullAccess") throw unauthorized("Key is not a full-access key of the account");
  await consumeNonce(input.nonce);
  return input.accountId;
}

function borshNep413(message: string, nonce: Buffer, recipient: string, callbackUrl?: string): Uint8Array {
  const parts: Buffer[] = [];
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  parts.push(tag);
  const str = (s: string) => {
    const b = Buffer.from(s, "utf8");
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    parts.push(l, b);
  };
  str(message);
  parts.push(nonce);
  str(recipient);
  if (callbackUrl) {
    parts.push(Buffer.from([1]));
    str(callbackUrl);
  } else parts.push(Buffer.from([0]));
  return new Uint8Array(Buffer.concat(parts));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw badRequest("bad base58");
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16).padStart(2, "0");
  const bytes = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  const zeros = s.match(/^1*/)![0].length;
  return new Uint8Array(Buffer.concat([Buffer.alloc(zeros), bytes]));
}

export const __test = { borshNep413, base58Decode };
