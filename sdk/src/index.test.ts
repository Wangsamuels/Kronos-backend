import { describe, expect, it } from "vitest";
import { createWalletClient, http, recoverTypedDataAddress, decodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { Kronos, ZERO, INTENT_FIELDS } from "./index.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const GUARD = "0x00000000000000000000000000000000000000aa";
const USDC = "0x00000000000000000000000000000000000000bb";

describe("@kronos/sdk", () => {
  const wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain: foundry, transport: http("http://127.0.0.1:1") });
  const k = new Kronos({ chainId: 31337, guard: GUARD });

  it("builds a bounded borrow intent", () => {
    const i = k.borrow({ asset: USDC, amount: 10_000n, maxLtv: 0.7, minHealth: 1.2 });
    expect(i.message.maxLtvBps).toBe(7000n);
    expect(i.message.minHealthBps).toBe(12000n);
    expect(i.message.recipient).toBe(ZERO);
    expect(i.message.deadline).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
  });

  it("signs EIP-712 typed data recoverable to the signer, with account = signer", async () => {
    const s = await k.sign(k.borrow({ asset: USDC, amount: 1n, maxLtv: 0.5 }), wallet);
    expect(s.message.account).toBe(wallet.account.address);
    const addr = await recoverTypedDataAddress({ ...(k.typedData(s) as never), signature: s.signature });
    expect(addr).toBe(wallet.account.address);
  });

  it("uses one struct layout with the action as the type name", () => {
    const td = k.typedData(k.repay({ asset: USDC, amount: 1n }));
    expect(td.primaryType).toBe("RepayIntent");
    expect(td.types.RepayIntent).toEqual(INTENT_FIELDS);
  });

  it("encodes relayer calldata for the guarded entry point", async () => {
    const s = await k.sign(k.deposit({ asset: USDC, amount: 5n }), wallet);
    const data = k.calldata(s);
    expect(data.startsWith("0x")).toBe(true);
    const abi = [
      {
        type: "function",
        name: "deposit",
        inputs: [{ type: "tuple", name: "intent", components: INTENT_FIELDS.map((f) => ({ ...f })) }, { type: "bytes", name: "sig" }],
        outputs: [],
        stateMutability: "nonpayable",
      },
    ] as const;
    const dec = decodeFunctionData({ abi, data });
    expect((dec.args![0] as { amount: bigint }).amount).toBe(5n);
  });
});
