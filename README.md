# Kronos

Kronos is a security layer for DeFi lending protocols. It blocks any transaction that would break the
protocol's core rules (health factor, LTV, solvency, share price, oracle sanity, collateral caps), whether a
user, an attacker or the protocol's own admins sent it. Risky admin changes wait in a public timelock, and an
emergency monitor can only make limits stricter, never looser.

**The problem.** Most lending exploits are a single transaction that leaves the protocol in a state its own
rules forbid: a pumped oracle lets a borrower drain the pool, a share-price inflation steals deposits, a stolen
admin key lists fake collateral. Audits check code before launch; nothing checks each transaction's outcome
afterwards. Kronos adds that check in the same transaction, using rules drafted by AI, tested with forge and
approved by the protocol team.

Built for **NEAR HACKATHON** (1–14 Nov 2026). Status: **testnet only** (Aurora testnet, Base Sepolia, NEAR testnet).

| | |
|---|---|
| Backend (this repo) | https://github.com/Wangsamuels/Kronos-backend |
| Frontend | https://github.com/Wangsamuels/Kronos-front |
| Hosted app | https://kronos-five-zeta.vercel.app/ |
| Hosted API | https://kronos-9fbcca7bfc9b.herokuapp.com (`/healthz`, `/v1/meta`, `/openapi.json`) |
| Tracks | AI Security & Defense (`security`), Unstoppable DeFi (`defi`), Privacy & Private AI (`privacy`) |
| Other project by the same author (rule Q-015) | **BuilderOS**: https://github.com/Wangsamuels/BuilderOS. Independent project, separate codebase, separate submission. |

## What NEAR does in Kronos

| Layer | NEAR piece | What it does |
|---|---|---|
| 1. Analyze | **NEAR AI Cloud** (TEE) | Two independent models (`z-ai/glm-5.3`, `Qwen/Qwen3.6-35B-A3B-FP8`) draft the invariants inside a hardware enclave. Where they disagree, a human decides. Humans approve every rule. |
| 2. Enforce | **Aurora** (NEAR's EVM) | The guard contracts run on Aurora testnet (and Base Sepolia), checking every guarded call. |
| 3. Respond | **Function-call key + NEAR registry** | The monitor's NEAR key may call one method, `tighten`, on the registry contract. The registry refuses anything looser than the current value. |
| 3. Respond | **Chain Signatures** (MPC) | The registry builds the EVM `tightenOutflow` transaction itself and NEAR's MPC signer signs it. The guard's `monitor` on each EVM chain is that MPC-derived address, so Kronos holds no EVM monitor key. |

Chain Signatures currently covers outflow tightens only. Pausing and cap changes are recorded on NEAR but not
yet signed onto EVM chains. NEAR Intents and zero-knowledge proofs are roadmap (see "MVP vs stretch").

## Try it

### 1. Verify the live testnet deployment (read-only, ~2 minutes)

Needs Node 20+ and [Foundry](https://getfoundry.sh). Nothing is broadcast and no keys or gas are needed.

```bash
git clone https://github.com/Wangsamuels/Kronos-backend.git
cd Kronos-backend
npm ci
npm run smoke -- 1313161555     # Aurora testnet
npm run smoke -- 84532          # Base Sepolia
```

You should see: the guard's code and config hash match the approved package, the timelock owns every
privileged role, the attestation is fresh, and then, on a local fork of the live chain: a normal deposit and
borrow succeed, the oracle pump **reverts at `CheckOracleFailed`**, a stolen admin key cannot list fake
collateral (direct call reverts; the timelock queues it as Tier 2 for 7 days), and the monitor can tighten the
outflow window but a loosen reverts with **`NotTighter`**.

Check that the guard's emergency monitor is the NEAR Chain Signatures address:

```bash
cast call 0xFcB08436D47B4552be70B56917CAdf423508FC26 "monitor()(address)" --rpc-url https://testnet.aurora.dev
cast call 0x427C6b1873465fcdC80760AB509d4bDa6dd85226 "monitor()(address)" --rpc-url https://sepolia.base.org
```

Both print `0xEbBCE871786Aa2B45b437D90Ec7D1fA7853AEC9f`. The tighten transactions it has signed are visible on
the NEAR registry's account page: https://testnet.nearblocks.io/address/kronos-registry-wang.testnet

### 2. Use the hosted app

1. Open https://kronos-five-zeta.vercel.app/ and sign in with GitHub, an EVM wallet or a NEAR wallet (one modal
   for sign-in and sign-up).
2. Choose **Protect a protocol** and use the **MiniLend** sample (or paste a public lending repo).
3. Watch the live log: mapping, intent schemas, drafters A and B on NEAR AI, tier classification, red team,
   forge verification. You should see **6/6 attacks blocked, 4/4 normal flows pass** for MiniLend.
4. Review: decide any rule the two models disagreed on, approve, and download the package (contracts, config,
   tests, deploy script, SDK snippet, `INTEGRATION.md`).

The analysis worker is a shared testnet instance; a run takes a few minutes.

### 3. Run the whole system locally (~5 minutes)

Needs Node 20+, Foundry and Docker. No third-party keys: without them the backend runs in labelled local modes
(heuristic agents instead of an LLM, local disk instead of R2, zip download instead of a GitHub PR, dry-run
NEAR calls). `GET /v1/meta` shows which mode each integration is in.

```bash
npm ci
cp .env.example .env              # works as-is for local runs
docker compose up -d              # postgres, redis, anvil
npm run migrate
npm run dev:api                   # terminal 1: http://localhost:8080 (/healthz, /openapi.json)
npm run dev:worker                # terminal 2
npm run demo                      # terminal 3: end-to-end demo, ends with 30/30 checks passed
```

`npm run demo` does, against the local chain:

1. signs in, submits the MiniLend sample and streams the analysis; forge verification reports 6/6 attacks
   blocked, 4/4 normal flows pass;
2. decides the invariant the drafters disagreed on, approves, builds the package;
3. deploys the guarded protocol with the approved parameters and registers it; on-chain verification checks
   the config hash, that every entry point reverts without a valid intent, and that the timelock owns every
   privileged role (30/30 checks); the protocol goes live and the attestor starts posting;
4. runs the oracle pump: the borrow reverts at `CheckOracleFailed` and the monitor records it as blocked;
5. a stolen admin key lists fake collateral: the direct call reverts, the timelock queues it for 7 days, the
   guardian cancels;
6. the monitor's tighten-only key halves the outflow window; a loosen with the same key is rejected.

To use NEAR AI Cloud locally, set `LLM_PROVIDER=near-ai` and `NEAR_AI_API_KEY` in `.env`, then
`npm run kronos -- llm-check` confirms both models answer.

### 4. Tests

```bash
npm run test:contracts            # forge: 28 tests (attacks vs unguarded + guarded, timelock, breaker, gas)
npm test                          # vitest: agents, merge, tiers, config hash, attestor, SDK, generator
RUN_API_TESTS=1 npm test          # + API contract tests (needs Postgres + Redis)
cd near-registry && cargo test    # NEAR registry: tighten-only rules
cd prover/attest-core && cargo test
```

## Live testnet deployments

Protocol `56d0ceaa-d715-441f-b654-93ccacb04477`, package `v1-c57e82`, config hash
`0xc57e8224b9db10a85030e05e6c3dc6110850c64ece0632511feb498683e0dc0d`. Both deployments pass 30/30 on-chain
checks. Machine-readable copies: [`contracts/deployments/1313161555.json`](contracts/deployments/1313161555.json),
[`contracts/deployments/84532.json`](contracts/deployments/84532.json).

| Contract | Aurora testnet (1313161555) | Base Sepolia (84532) |
|---|---|---|
| GuardedMiniLend (guard) | [`0xFcB08436D47B4552be70B56917CAdf423508FC26`](https://explorer.testnet.aurora.dev/address/0xFcB08436D47B4552be70B56917CAdf423508FC26) | [`0x427C6b1873465fcdC80760AB509d4bDa6dd85226`](https://sepolia.basescan.org/address/0x427C6b1873465fcdC80760AB509d4bDa6dd85226) |
| GuardTimelock | [`0xB8c6AD7c264043d6e3fa6b02518b95B72FCAB68A`](https://explorer.testnet.aurora.dev/address/0xB8c6AD7c264043d6e3fa6b02518b95B72FCAB68A) | [`0x30cF058605d1709F5Ee00b36749CbFCf35E17986`](https://sepolia.basescan.org/address/0x30cF058605d1709F5Ee00b36749CbFCf35E17986) |
| AttestationRegistry | [`0x427C6b1873465fcdC80760AB509d4bDa6dd85226`](https://explorer.testnet.aurora.dev/address/0x427C6b1873465fcdC80760AB509d4bDa6dd85226) | [`0xB8c6AD7c264043d6e3fa6b02518b95B72FCAB68A`](https://sepolia.basescan.org/address/0xB8c6AD7c264043d6e3fa6b02518b95B72FCAB68A) |
| Guard monitor (Chain Signatures address) | `0xEbBCE871786Aa2B45b437D90Ec7D1fA7853AEC9f` | `0xEbBCE871786Aa2B45b437D90Ec7D1fA7853AEC9f` |
| MiniLend (unguarded, for side-by-side replays) | `0xad8d6120bda8247bf65c21b64ef137d03d2c7353` | `0xFcB08436D47B4552be70B56917CAdf423508FC26` |
| kUSDC (mock) | `0x3afa5F034Aa297a019C61F03Bb62CDE0D5a9fbeb` | `0x6E3DbDE590D3a92b87842aD96266e363Ae2213d2` |
| kWETH (mock) | `0x3ee5a255de8958ec1008d242abf18a04ab47a436` | `0x3afa5F034Aa297a019C61F03Bb62CDE0D5a9fbeb` |
| THIN (thin-liquidity collateral) | `0x30d40C7898c4ba730d39cf459056fbc9D40Af979` | `0x3ee5A255dE8958eC1008d242ABf18a04Ab47A436` |
| THIN/kUSDC pool (spot oracle) | `0x5b6034d45bb4f8e9c393ff20d772ab1e7eb39303` | `0xaA73F07C832beF1a52ceea024Eb4FDF3761D2084` |
| Fixed price oracle (kWETH) | `0x201103aee38fe9144a078ac5f013382da5078348` | `0x30d40C7898c4ba730d39cf459056fbc9D40Af979` |

The same address appears in different roles on the two chains because of deployer nonces; it is not an error.

| NEAR (testnet) | |
|---|---|
| Registry contract (also the protocol's owner on NEAR) | [`kronos-registry-wang.testnet`](https://testnet.nearblocks.io/address/kronos-registry-wang.testnet) |
| Monitor account (function-call key limited to `tighten`) | [`kronos-monitor-wang.testnet`](https://testnet.nearblocks.io/address/kronos-monitor-wang.testnet) |
| MPC signer / derivation path | `v1.signer-prod.testnet` / `kronos/56d0ceaa-d715-441f-b654-93ccacb04477` |

A Chain Signatures tighten has executed on both chains (outflow threshold 200,000 → 100,000 kUSDC).
Earlier deployments (protocol `758e2853-…`, guards `0x2634…2e8c`) predate Chain Signatures and are superseded.

## How it works

### The guard

`KronosGuard` is one modifier, `guarded(kind, intent, sig)`, with two entry paths: users with a signed EIP-712
intent, and admins through the timelock. Every call passes intent check → pre-checks → the action →
post-checks (health, LTV, solvency, share price, oracle vs attested TWAP, collateral caps with probation) →
outflow window. `OutflowBreaker` queues (rather than fails) withdrawals that push 24h net outflow over the
threshold.

`GuardTimelock` routes admin calls by tier: Tier 0 tighten is instant, Tier 1 waits 48h, Tier 2 (new
collateral, oracle changes) 7 days, Tier 3 (upgrades, signer changes) 14 days plus co-sign. Guardians can
cancel queued actions, never execute them.

### The analysis pipeline (template-first)

1. **Ingest**: clone the repo, pull verified source for any addresses, compile with forge, run Slither if
   present, classify. Non-lending protocols stop with "coming soon".
2. **Mapper**: labels every entry point `user` or `privileged`; anything the AST shows as access-controlled is
   privileged.
3. **Schema**: one EIP-712 intent type per user action.
4. **Drafters A and B** (two different models) fill vetted invariant templates independently; values are
   clamped to safe bounds; disagreements go to human review, defaulting to the stricter value.
5. **Tier classifier** with hard rules (oracle change ≥ Tier 2, upgrades Tier 3, only explicit tighten
   functions Tier 0).
6. **Red team + verifier**: generates `GuardConfig` + the guarded contract, compiles them and runs the attack
   library and normal traffic with forge. An exploit that gets through goes back to the drafters (up to 2 rounds).
7. **Human review** and approval build the package and can open an integration PR.

Agents agreeing with each other proves nothing; the compiler and the fork tests decide.

### NEAR Chain Signatures path

```
anomaly ─▶ worker ──tighten(…, evm)──▶ NEAR registry ──sign(payload)──▶ MPC signer
          (function-call key:          builds the EIP-1559 tx itself:      returns (r, s, v)
           method `tighten` only)      to = registered guard, value 0,
                                       data = tightenOutflow(asset, lower)
worker ◀── signature ── registry ;  worker checks the bytes, recovers the signer, broadcasts
```

Three independent limits: NEAR rejects any other method for the key; the registry only signs transactions it
built, for outflow tightens, to the registered guard, never higher than before; the guard reverts anything not
stricter (`NotTighter`). Where a guard's `monitor()` is not the derived address, the worker falls back to an
EVM monitor key (`MONITOR_PRIVATE_KEY`).

Owner-only demo (needs the monitor's NEAR key):
`npm run kronos -- chainsig-demo 1313161555` prints the NEAR transaction and the EVM transaction.

## Repository layout

| Path | What |
|---|---|
| `contracts/` | Foundry project: `KronosGuard`, `LendingInvariants`, `GuardTimelock`, `OutflowBreaker`, `AttestationRegistry`, the deliberately vulnerable `MiniLend` sample and `GuardedMiniLend`. 28 tests. |
| `api/` | Fastify 5 + Zod + OpenAPI 3.1 (`/openapi.json`); JWT auth via GitHub, SIWE and NEAR NEP-413; SSE live logs. |
| `worker/` | BullMQ stages `ingest → analyze → verify → review → package`, plus the monitor and the attestor. |
| `worker/agents/`, `lib/llm.ts` | AI agents and the single LLM gateway (NEAR AI Cloud / OpenAI-compatible / heuristic fallback). |
| `near-registry/` | Rust `near-sdk` registry contract: protocol registry + tighten-only actions + Chain Signatures signing. |
| `sdk/` | `@kronos/sdk`: build, sign and submit intents. |
| `prover/` | Roadmap: SP1 attestation program skeleton and its tested core logic. Not running. |
| `scripts/` | `demo`, `smoke`, and the `kronos` CLI (`register`, `near-demo`, `llm-check`, `chainsig-address`, `chainsig-demo`, `transfer`). |
| `db/` | Drizzle schema and migrations (Postgres). |

Deployment runbook (Heroku, config vars, EVM and NEAR contract deployment): [DEPLOY.md](DEPLOY.md).

## Hackathon window and pre-existing code (rules Q-001 to Q-004)

All code in this repository and in [Kronos-front](https://github.com/Wangsamuels/Kronos-front) was written
during the hackathon window (work counts from 19 Oct 2026). The first commit in this repo is dated
10 Nov 2026; there is no pre-hackathon baseline and no earlier product live on another chain. The full
history is the diff: https://github.com/Wangsamuels/Kronos-backend/commits/main. The submitted state is tagged
`hackathon-submission`.

Design notes written before coding used the working name "Intent ZK"; no code from that period exists.

## Libraries, templates and AI tools (rule Q-005)

- **AI coding assistance:** Claude (Anthropic) was used to write and review large parts of the backend,
  contracts, NEAR registry and this README. The frontend was built with Claude Fable 5.2. All of it was
  reviewed and run by the author.
- **AI at runtime:** NEAR AI Cloud models `z-ai/glm-5.3` and `Qwen/Qwen3.6-35B-A3B-FP8`.
- **Backend:** Node 22, TypeScript, Fastify, Zod, Drizzle ORM, pg, BullMQ, ioredis, viem, near-api-js, jose,
  @noble/curves, @noble/hashes, Octokit, archiver, AWS SDK (S3 client for Cloudflare R2), pino, vitest, tsx.
- **Contracts:** Solidity, Foundry, forge-std; Slither (optional, for analysis).
- **NEAR:** near-sdk 5.30, cargo-near; NEAR AI Cloud; NEAR MPC signer `v1.signer-prod.testnet`.
- **Prover (roadmap):** SP1 (`sp1-zkvm`).
- **Frontend** (separate repo): Next.js, React, Tailwind, Radix UI, wagmi, viem, WalletConnect,
  @near-wallet-selector, TanStack Query, openapi-fetch, openapi-typescript.
- **Hosting:** Heroku (API + worker), Vercel (frontend), Cloudflare R2 (packages).
- No third-party templates or boilerplate were used beyond the libraries' standard project scaffolds.

## MVP vs stretch (nothing unfinished is claimed as working)

Working now: guard contracts and attack tests, the API and analysis pipeline on NEAR AI Cloud, package and PR
builder, deployment verification on Aurora testnet and Base Sepolia, signed attestations, the monitor, the NEAR
registry with its tighten-only key, and NEAR Chain Signatures for outflow tightens.

Not running yet: SP1 → Groth16 proofs (`prover/`; attestations today are signed, not proven), NEAR Intents
(e.g. cross-chain settlement of queued withdrawals), Chain Signatures for pause and cap actions, analysis
adapters beyond the compound-v2 shape, and multi-source price agreement (Chainlink + Pyth + DEX) wired to live
feeds. Protocol types other than lending (bridges, DEXs, perps, vaults) are on a waitlist.

What Kronos can't stop: users signing a malicious intent (phishing), stolen user or exchange keys, bugs in a
chain's own software, bugs in the invariants themselves, and immutable protocols that can't host the modifier.
Audits and fork tests are still needed.

## License

MIT, see [LICENSE](LICENSE).
