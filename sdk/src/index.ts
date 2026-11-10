import {
  type Address,
  type Hex,
  type WalletClient,
  type PublicClient,
  type Account,
  encodeFunctionData,
  maxUint256,
} from "viem";

/**
 * @kronos/sdk — build, sign and submit Kronos intents.
 *
 * Users sign a narrow, typed outcome (EIP-712) in their wallet. The wallet, not the frontend, is the source
 * of truth: a hacked frontend or relayer can only push values within the intent's limits — it can't
 * redirect funds. Approvals are for exact amounts only.
 *
 *   const kronos = new Kronos({ chainId, guard: GUARD_ADDRESS })
 *   const intent = await kronos.borrow({ asset: USDC, amount: 10_000n * 10n ** 6n, maxLtv: 0.7, minHealth: 1.2 })
 *   await kronos.submit(intent, walletClient)
 */

export type IntentKind = "deposit" | "withdraw" | "borrow" | "repay" | "liquidate";
const KIND_INDEX: Record<IntentKind, number> = { deposit: 0, withdraw: 1, borrow: 2, repay: 3, liquidate: 4 };
const TYPE_NAME: Record<IntentKind, string> = {
  deposit: "DepositIntent",
  withdraw: "WithdrawIntent",
  borrow: "BorrowIntent",
  repay: "RepayIntent",
  liquidate: "LiquidateIntent",
};

export const INTENT_FIELDS = [
  { name: "asset", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "maxLtvBps", type: "uint256" },
  { name: "minHealthBps", type: "uint256" },
  { name: "account", type: "address" },
  { name: "recipient", type: "address" },
  { name: "deadline", type: "uint256" },
  { name: "nonce", type: "uint256" },
] as const;

export interface IntentMessage {
  asset: Address;
  amount: bigint;
  maxLtvBps: bigint;
  minHealthBps: bigint;
  account: Address;
  recipient: Address;
  deadline: bigint;
  nonce: bigint;
}

export interface UnsignedIntent {
  kind: IntentKind;
  message: IntentMessage;
  /** Plain-language summary to show next to the wallet prompt. */
  summary: string;
}

export interface SignedIntent extends UnsignedIntent {
  signature: Hex;
  signer: Address;
}

export interface KronosConfig {
  chainId: number;
  guard: Address;
  /** seconds an intent stays valid (default 30 min) */
  ttlSeconds?: number;
  /** function name overrides when the protocol's entry points use other names (e.g. supply) */
  functionNames?: Partial<Record<IntentKind, string>>;
}

export const ZERO: Address = "0x0000000000000000000000000000000000000000";

const INTENT_TUPLE = {
  type: "tuple",
  name: "intent",
  components: INTENT_FIELDS.map((f) => ({ name: f.name, type: f.type })),
} as const;

function entryAbi(name: string) {
  return [
    {
      type: "function",
      name,
      stateMutability: "nonpayable",
      inputs: [INTENT_TUPLE, { name: "sig", type: "bytes" }],
      outputs: [],
    },
  ] as const;
}

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const bps = (ratio: number) => BigInt(Math.round(ratio * 10_000));

/** Unordered single-use nonce: 128 random bits. */
export function randomNonce(): bigint {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return BigInt(`0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`);
}

export class Kronos {
  readonly chainId: number;
  readonly guard: Address;
  readonly ttl: number;
  private names: Record<IntentKind, string>;

  constructor(cfg: KronosConfig) {
    this.chainId = cfg.chainId;
    this.guard = cfg.guard;
    this.ttl = cfg.ttlSeconds ?? 1800;
    this.names = { deposit: "deposit", withdraw: "withdraw", borrow: "borrow", repay: "repay", liquidate: "liquidate", ...cfg.functionNames };
  }

  /** EIP-712 typed data for wallets (`signTypedData`). */
  typedData(intent: UnsignedIntent) {
    return {
      domain: { name: "Kronos", version: "1", chainId: this.chainId, verifyingContract: this.guard },
      primaryType: TYPE_NAME[intent.kind],
      types: { [TYPE_NAME[intent.kind]]: INTENT_FIELDS },
      message: intent.message,
    } as const;
  }

  private build(kind: IntentKind, p: { asset: Address; amount: bigint; account?: Address; recipient?: Address; maxLtv?: number; minHealth?: number }, summary: string): UnsignedIntent {
    return {
      kind,
      summary,
      message: {
        asset: p.asset,
        amount: p.amount,
        maxLtvBps: p.maxLtv !== undefined ? bps(p.maxLtv) : 0n,
        minHealthBps: p.minHealth !== undefined ? bps(p.minHealth) : 0n,
        account: p.account ?? ZERO, // filled with the signer in sign()
        recipient: p.recipient ?? ZERO, // 0 = the signer; any other address must be explicit
        deadline: BigInt(Math.floor(Date.now() / 1000) + this.ttl),
        nonce: randomNonce(),
      },
    };
  }

  deposit(p: { asset: Address; amount: bigint }) {
    return this.build("deposit", p, `Deposit exactly ${p.amount} of ${p.asset} into your own position.`);
  }
  withdraw(p: { asset: Address; amount: bigint; minHealth?: number; recipient?: Address }) {
    return this.build("withdraw", { minHealth: 1.1, ...p }, `Withdraw up to ${p.amount} of ${p.asset}${p.recipient ? ` to ${p.recipient}` : " to you"}.`);
  }
  borrow(p: { asset: Address; amount: bigint; maxLtv: number; minHealth?: number; recipient?: Address }) {
    return this.build(
      "borrow",
      { minHealth: 1.1, ...p },
      `Borrow ${p.amount} of ${p.asset}${p.recipient ? ` to ${p.recipient}` : " to you"}; LTV stays ≤ ${p.maxLtv * 100}% and health ≥ ${p.minHealth ?? 1.1}.`,
    );
  }
  repay(p: { asset: Address; amount: bigint }) {
    return this.build("repay", p, `Repay up to ${p.amount} of ${p.asset} of your own debt.`);
  }
  liquidate(p: { borrower: Address; collateral: Address; repayAmount: bigint; recipient?: Address }) {
    return this.build(
      "liquidate",
      { asset: p.collateral, amount: p.repayAmount, account: p.borrower, recipient: p.recipient },
      `Repay ${p.repayAmount} of ${p.borrower}'s debt and receive their ${p.collateral} collateral.`,
    );
  }

  /** Signs with the user's wallet. For non-liquidation intents `account` is always the signer. */
  async sign(intent: UnsignedIntent, wallet: WalletClient): Promise<SignedIntent> {
    const account = wallet.account as Account | undefined;
    if (!account) throw new Error("walletClient has no account");
    const message = { ...intent.message, account: intent.kind === "liquidate" ? intent.message.account : account.address };
    const signed = { ...intent, message };
    const signature = await wallet.signTypedData({ account, ...this.typedData(signed) } as never);
    return { ...signed, signature, signer: account.address };
  }

  /** Calldata for the guarded entry point (for relayers). */
  calldata(intent: SignedIntent): Hex {
    const name = this.names[intent.kind];
    return encodeFunctionData({ abi: entryAbi(name), functionName: name, args: [intent.message, intent.signature] as never });
  }

  /**
   * Exact-amount approval (never unlimited) for deposits / repays / liquidations, when needed.
   * Returns the approval tx hash or null if the allowance already covers the amount.
   */
  async approveExact(intent: UnsignedIntent | SignedIntent, wallet: WalletClient, publicClient: PublicClient, token?: Address): Promise<Hex | null> {
    if (!["deposit", "repay", "liquidate"].includes(intent.kind)) return null;
    const account = wallet.account as Account;
    const asset = token ?? intent.message.asset;
    const allowance = (await publicClient.readContract({ address: asset, abi: ERC20_ABI, functionName: "allowance", args: [account.address, this.guard] })) as bigint;
    if (allowance >= intent.message.amount) return null;
    if (intent.message.amount === maxUint256) throw new Error("unlimited approvals are not allowed");
    return wallet.writeContract({ account, chain: wallet.chain, address: asset, abi: ERC20_ABI, functionName: "approve", args: [this.guard, intent.message.amount] });
  }

  /**
   * Signs (if needed) and submits directly from the user's wallet. Pass a `relayer` to have a relayer pay gas:
   * it receives only the signed intent and can't change any of its values.
   */
  async submit(intent: UnsignedIntent | SignedIntent, wallet: WalletClient, opts: { relayer?: (to: Address, data: Hex) => Promise<Hex> } = {}): Promise<Hex> {
    const signed = "signature" in intent ? intent : await this.sign(intent, wallet);
    const data = this.calldata(signed);
    if (opts.relayer) return opts.relayer(this.guard, data);
    const account = wallet.account as Account;
    return wallet.sendTransaction({ account, chain: wallet.chain, to: this.guard, data } as never);
  }

  kindIndex(kind: IntentKind) {
    return KIND_INDEX[kind];
  }
}

export default Kronos;
