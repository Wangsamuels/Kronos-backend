import { createPublicClient, createWalletClient, http, defineChain, type Chain, type PublicClient } from "viem";
import { baseSepolia, foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "./env.js";
import { badRequest } from "./errors.js";

/** Aurora testnet — NEAR's EVM. */
export const auroraTestnet = defineChain({
  id: 1313161555,
  name: "Aurora Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_AURORA_TESTNET] } },
  blockExplorers: { default: { name: "Aurora Explorer", url: "https://explorer.testnet.aurora.dev" } },
  testnet: true,
});

export interface ChainInfo {
  chain: Chain;
  rpc: string;
  explorerApi?: { kind: "etherscan-v2" | "blockscout"; url: string };
}

export const CHAINS: Record<number, ChainInfo> = {
  [auroraTestnet.id]: {
    chain: auroraTestnet,
    rpc: env.RPC_AURORA_TESTNET,
    explorerApi: { kind: "blockscout", url: "https://explorer.testnet.aurora.dev/api" },
  },
  [baseSepolia.id]: {
    chain: baseSepolia,
    rpc: env.RPC_BASE_SEPOLIA,
    explorerApi: { kind: "etherscan-v2", url: "https://api.etherscan.io/v2/api" },
  },
};
// Local anvil (demo / judges): set RPC_LOCAL=http://127.0.0.1:8545
if (env.RPC_LOCAL) CHAINS[foundry.id] = { chain: foundry, rpc: env.RPC_LOCAL };

export const SUPPORTED_CHAIN_IDS = Object.keys(CHAINS).map(Number);

export function chainInfo(chainId: number): ChainInfo {
  const c = CHAINS[chainId];
  if (!c) throw badRequest(`Unsupported chain ${chainId}. Supported: ${SUPPORTED_CHAIN_IDS.join(", ")}`);
  return c;
}

const clients = new Map<number, PublicClient>();
export function publicClient(chainId: number): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    const info = chainInfo(chainId);
    c = createPublicClient({ chain: info.chain, transport: http(info.rpc, { retryCount: 3, timeout: 20_000 }) }) as PublicClient;
    clients.set(chainId, c);
  }
  return c;
}

export function attestorWallet(chainId: number) {
  if (!env.ATTESTOR_PRIVATE_KEY) return null;
  const info = chainInfo(chainId);
  const account = privateKeyToAccount(env.ATTESTOR_PRIVATE_KEY as `0x${string}`);
  return createWalletClient({ account, chain: info.chain, transport: http(info.rpc) });
}
