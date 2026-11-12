# Kronos backend

Kronos is a security layer that plugs into an existing DeFi lending protocol. It blocks any action that
would break the protocol's core rules, whether a user, an attacker or the protocol's own admins started it,
and the user experience stays as fast as a normal lending call.

This repo is the **backend**: REST API + live log stream, the AI-assisted analysis pipeline, the guard
contracts, the NEAR registry and the monitoring/attestation agents. It deploys to **Heroku**; the frontend
(Next.js on Vercel) is built separately against the OpenAPI contract in [`contracts/openapi.json`](contracts/openapi.json).

```
users / admins ──► KronosGuard (same tx) ──► pre-checks ─► action ─► invariants ─► outflow window
                         ▲                                                            ▲
             attestor: one result per block                         monitor: anomaly flags tighten
```

Design principles: judge state, not size · no proof generation in the user's path · no one is exempt ·
admins change settings, never move funds · slow down abnormal activity instead of blocking it ·
AI drafts, tests prove, humans sign.

## What's in the box

| Path | What |
|---|---|
| `contracts/` | Foundry project. `KronosGuard` (the `guarded(kind, intent, sig)` modifier), `LendingInvariants` (template library), `GuardTimelock` (tiers 0–3, cancel-only guardians, simulate-then-check), `OutflowBreaker` (rolling 24h net-outflow window, queue-don't-fail), `AttestationRegistry`, the `MiniLend` sample (deliberately vulnerable) and `GuardedMiniLend`. 28 tests, including the three demo attacks against both versions. |
| `api/` | Fastify + Zod + OpenAPI 3.1, JWT auth (GitHub OAuth, SIWE, NEAR NEP-413), SSE live logs. |
| `worker/` | BullMQ stages `ingest → analyze → verify → package`, plus the always-on **monitor** and the scheduled **attestor**. |
| `worker/agents/` | Specialist agents (mapper, schema, drafters A + B, tier classifier, red team), each with an LLM and a deterministic implementation. |
| `worker/templates/` | The vetted invariant + attack library and the package generator. |
| `lib/llm.ts` | The single LLM gateway: provider choice (NEAR AI Cloud TEE / OpenAI-compatible / heuristic), JSON-schema output validated by Zod, retries, a token budget per run, TEE attestation evidence. |
| `sdk/` | `@kronos/sdk`: build, sign (EIP-712) and submit intents; exact-amount approvals only. |
| `near-registry/` | Rust `near-sdk` contract for `kronos.testnet`: protocol registry + **tighten-only** monitor actions. |
| `prover/` | Stretch goal: SP1 → Groth16 attestation program and its tested core logic. |
| `db/` | Drizzle schema and migrations (Postgres). |

## Quick start (local, ~5 minutes)

Requirements: Node 20+, [Foundry](https://getfoundry.sh), Docker (or local Postgres + Redis).

```bash
npm ci
cp .env.example .env              # works as-is for local runs
docker compose up -d              # postgres, redis, anvil
npm run migrate
npm run dev:api                   # http://localhost:8080  (docs: /openapi.json, health: /healthz)
npm run dev:worker                # in a second terminal
npm run demo                      # in a third terminal: the full end-to-end demo
```

`npm run demo` does exactly what the 2-minute video shows, against the local chain:

1. signs in, submits the MiniLend sample and streams the live analysis (mapping, intents, drafters A/B,
   tiers, red team, forge verification: **6/6 attacks blocked, 4/4 normal flows pass**);
2. decides the invariant the drafters disagreed on, approves, builds the package;
3. deploys the guarded protocol with the approved parameters and registers it — on-chain verification
   checks the config hash, that every entry point reverts without a valid intent, and that the timelock
   owns every privileged role (30/30 checks) — the protocol goes **live** and the attestor starts posting;
4. runs the oracle pump: the borrow **reverts at `CheckOracleFailed`** and the monitor records it as blocked;
5. a stolen admin key lists a fake collateral: direct call reverts, the timelock queues it for **7 days**,
   the guardian cancels;
6. the monitor's tighten-only key halves the outflow window; a loosen call with the same key is rejected.

No third-party keys are needed: without them the backend runs in clearly labelled local modes
(`GET /v1/meta` shows which): heuristic agents instead of an LLM, local disk instead of R2, zip download
instead of a GitHub PR, dry-run NEAR calls.

## Live testnet deployments

The MiniLend demo is deployed with the parameters of the approved Kronos package (config hash
`0x3be44e857e450e71827ee2ab7eab7f1f3b4dda31c978b67cd79cba250722ad24`) on **Aurora testnet (1313161555)**
and **Base Sepolia (84532)**. The same deployer and nonce sequence gave identical addresses on both chains.
Machine-readable copies: [`contracts/deployments/1313161555.json`](contracts/deployments/1313161555.json),
[`contracts/deployments/84532.json`](contracts/deployments/84532.json).

| Contract | Address | Aurora testnet | Base Sepolia |
|---|---|---|---|
| GuardedMiniLend (guarded protocol) | `0x2634d68199e59afFA02399f1e239d660F75E2e8c` | [explorer](https://explorer.testnet.aurora.dev/address/0x2634d68199e59afFA02399f1e239d660F75E2e8c) | [basescan](https://sepolia.basescan.org/address/0x2634d68199e59afFA02399f1e239d660F75E2e8c) |
| GuardTimelock | `0xD35A5E3eB8890e8820e5EB03614Be6fb02a0d405` | [explorer](https://explorer.testnet.aurora.dev/address/0xD35A5E3eB8890e8820e5EB03614Be6fb02a0d405) | [basescan](https://sepolia.basescan.org/address/0xD35A5E3eB8890e8820e5EB03614Be6fb02a0d405) |
| AttestationRegistry | `0x28d4dBdF3fAE4feADea564098797Cc1685aF1e0b` | [explorer](https://explorer.testnet.aurora.dev/address/0x28d4dBdF3fAE4feADea564098797Cc1685aF1e0b) | [basescan](https://sepolia.basescan.org/address/0x28d4dBdF3fAE4feADea564098797Cc1685aF1e0b) |
| MiniLend (unguarded, for side-by-side replays) | `0x3860c6A53F5b152C03E59E1b11b8B2F7d04ED2b8` | [explorer](https://explorer.testnet.aurora.dev/address/0x3860c6A53F5b152C03E59E1b11b8B2F7d04ED2b8) | [basescan](https://sepolia.basescan.org/address/0x3860c6A53F5b152C03E59E1b11b8B2F7d04ED2b8) |
| kUSDC (mock) | `0x8326F1Ef7456ed27FF6d7BA6635231f873cf1a8E` | [explorer](https://explorer.testnet.aurora.dev/address/0x8326F1Ef7456ed27FF6d7BA6635231f873cf1a8E) | [basescan](https://sepolia.basescan.org/address/0x8326F1Ef7456ed27FF6d7BA6635231f873cf1a8E) |
| kWETH (mock) | `0x2355Bd309F5435AbDA697d1E2c737422a28a988B` | [explorer](https://explorer.testnet.aurora.dev/address/0x2355Bd309F5435AbDA697d1E2c737422a28a988B) | [basescan](https://sepolia.basescan.org/address/0x2355Bd309F5435AbDA697d1E2c737422a28a988B) |
| THIN (thin-liquidity collateral) | `0xdCCECCD2955211AE82aB9a21A496d3da6320C7e2` | [explorer](https://explorer.testnet.aurora.dev/address/0xdCCECCD2955211AE82aB9a21A496d3da6320C7e2) | [basescan](https://sepolia.basescan.org/address/0xdCCECCD2955211AE82aB9a21A496d3da6320C7e2) |
| THIN/kUSDC pool (spot oracle) | `0x6638d5522A96713461f3B00F725d6d4c0325B96C` | [explorer](https://explorer.testnet.aurora.dev/address/0x6638d5522A96713461f3B00F725d6d4c0325B96C) | [basescan](https://sepolia.basescan.org/address/0x6638d5522A96713461f3B00F725d6d4c0325B96C) |
| Fixed price oracle (kWETH) | `0xeA551c0ca8DaAAb37ddeB974C1F37eE4974285B1` | [explorer](https://explorer.testnet.aurora.dev/address/0xeA551c0ca8DaAAb37ddeB974C1F37eE4974285B1) | [basescan](https://sepolia.basescan.org/address/0xeA551c0ca8DaAAb37ddeB974C1F37eE4974285B1) |

Check a deployment yourself (read-only checks on the live chain, then the attacks on a local fork of it;
nothing is broadcast and no gas is spent; needs Foundry):

```bash
npm run smoke -- 1313161555
npm run smoke -- 84532
```

It confirms the code and config hash, timelock ownership and attestation freshness, then on the fork: a
normal deposit + borrow succeeds, the oracle pump reverts at `CheckOracleFailed`, a stolen admin key can't
list a fake collateral (direct call reverts; the timelock queues it as Tier 2 for 7 days), and the monitor
key can tighten but not loosen the outflow window.

## Tests

```bash
npm run test:contracts            # forge: 28 tests (attacks vs unguarded + guarded, timelock, breaker, gas)
npm test                          # vitest: agents, merge, tiers, config hash, attestor, SDK, generator
RUN_API_TESTS=1 npm test          # + API contract tests (needs Postgres + Redis)
cd near-registry && cargo test    # NEAR registry: tighten-only rules
cd prover/attest-core && cargo test
```

## How the analysis works (template-first)

1. **Ingest** (deterministic): clone the repo (GitHub App token if installed), pull verified source for any
   addresses from the explorer, snapshot to R2, compile with forge to a solc AST, run Slither if present,
   classify. Non-lending stops with "Bridges and other types coming soon".
2. **Mapper agent**: every entry point labelled `user` / `privileged` with its kind; locates key state
   (health getter, exchange rate, oracle, caps, listings). Hard rule: anything the AST shows as
   access-controlled is privileged.
3. **Schema agent**: one EIP-712 intent type per user action (`BorrowIntent{asset, amount, maxLtvBps,
   minHealthBps, account, recipient, deadline, nonce}`).
4. **Invariant drafters A and B** fill the vetted templates independently; the merge keeps what both agree
   on and flags disagreements for human review (defaulting to the stricter value).
5. **Tier classifier**, with hard rules: an oracle change is always ≥ Tier 2, upgrades and signer changes
   are Tier 3, only explicit tighten functions may be Tier 0.
6. **Red team** picks attacks from the library; the **verifier** generates `GuardConfig.<Name>.sol` +
   `Guarded<Name>.sol`, compiles them and runs the attack library and normal traffic with forge (plus a
   fork replay of recent real transactions and history-based outflow thresholds when the protocol is
   deployed). An exploit that gets through sends the gap back to the drafters, up to 2 rounds.
7. **Human review** in the frontend; approval builds the package (contracts, config, tests, deploy script,
   SDK snippet, `INTEGRATION.md`, test report), uploads it and can open the integration PR.

Agents agreeing with each other proves nothing; the compiler and the fork tests decide what is true.

**Adapters.** The generator currently ships one vetted adapter, `compound-v2-style` (thin external
wrappers over internal logic, per-asset oracle, single collateral per account — the MiniLend shape). For
other protocols the pipeline still maps, drafts, tiers and packages the guard library + config + intent
schemas, and says plainly that GuardConfig wiring needs a manual or LLM-drafted adapter step.

## Deploying to Heroku

The full runbook (Heroku resources, every config var, EVM + NEAR contract deployment, GitHub App,
Vercel proxy) is in **[DEPLOY.md](DEPLOY.md)**. The short version:

```bash
heroku create kronos-api --stack container
heroku addons:create heroku-postgresql:essential-0
heroku addons:create heroku-redis:mini
heroku config:set JWT_SECRET=$(openssl rand -hex 32) NODE_ENV=production \
  CORS_ORIGINS=https://<project>.vercel.app FRONTEND_URL=https://<project>.vercel.app \
  PUBLIC_API_URL=https://kronos-api.herokuapp.com
git push heroku main               # heroku.yml: one Docker image (Node 20 + Foundry + Slither)
heroku ps:scale web=1:standard-1x worker=1:standard-2x
```

The release phase runs `node dist/db/migrate.js`. `GET /healthz` reports DB, Redis and queue status.
The worker needs ≥ 1 GB RAM for forge/anvil (Standard-2X). All settings are config vars — see
`.env.example`.

### Connecting the frontend

1. The frontend generates its typed client from `contracts/openapi.json` (`openapi-typescript`);
   regenerate with `npm run openapi` after API changes.
2. Set `NEXT_PUBLIC_API_URL=https://kronos-api.herokuapp.com` on Vercel, and `CORS_ORIGINS` +
   `FRONTEND_URL` here.
3. Auth: one modal for sign-in and sign-up (the first sign-in creates the account; responses carry
   `isNewUser`). `GET /v1/auth/providers` lists the options and the exact SIWE domain / NEAR recipient to
   sign. The access JWT comes back in the body (keep it in memory); the refresh token is an httpOnly cookie
   (`POST /v1/auth/refresh` on app load restores the session). GitHub: navigate to
   `/v1/auth/github?returnTo=/your/path`; it comes back to
   `FRONTEND_URL/auth/callback#access_token=…&new_user=0|1&return_to=/your/path` (or `#error=…`).
   Prefer proxying the API through Vercel so the cookie is first-party (see DEPLOY.md §6).
4. SSE: `GET /v1/analyses/:id/stream?token=…` (EventSource can't send headers). Events: `stage`, `log`,
   `entrypoint`, `invariant`, `done`, `error`, each with an `id`; reconnects resume via `Last-Event-ID` or
   `?lastEventId=`. A heartbeat goes out every 15 s (Heroku drops idle connections after 55 s). After
   approval, reopen the stream with the last id to follow packaging.
5. Every route is under `/v1`. Errors are always `{error: {code, message, details?}}`; lists paginate with
   `?cursor=&limit=`.

## Chains and keys

| What | Where |
|---|---|
| Guard contracts | Aurora testnet (1313161555) and Base Sepolia (84532): `cd contracts && forge script script/Deploy.s.sol --rpc-url aurora_testnet --broadcast --legacy` (set `KRONOS_CONFIG=deployments/kronos.config.json` to deploy an approved package's parameters). |
| NEAR registry | `cd near-registry && ./deploy.sh` deploys `kronos.testnet`, adds the monitor and creates its function-call key (receiver = registry, methods = `tighten`). |
| Attestor | `ATTESTOR_PRIVATE_KEY` — must be the registry's `attestor`. |
| Monitor | `NEAR_ACCOUNT_ID` + `NEAR_FUNCTION_CALL_KEY` (tighten-only on NEAR). On EVM chains the guard's `monitor` is the protocol's **NEAR Chain Signatures** address (`kronos-cli chainsig-address`), so no EVM key is needed; `MONITOR_PRIVATE_KEY` remains as a fallback for guards deployed with a plain EVM monitor. |

## NEAR Chain Signatures (one tighten-only NEAR key for every EVM chain)

The monitor agent holds no EVM key. Each protocol gets an EVM address controlled by NEAR's MPC network
(`v1.signer-prod.testnet`, predecessor = the registry contract, path `kronos/<protocol id>`). The guard is
deployed with that address as its `monitor`, the only role allowed to call `tightenOutflow`, which the
contract only lets go down.

```
anomaly ─▶ worker ──tighten(…, evm)──▶ NEAR registry ──sign(payload)──▶ MPC signer
          (function-call key:          builds the EIP-1559 tx itself:      returns (r, s, v)
           method `tighten` only)      to = registered guard, value 0,
                                       data = tightenOutflow(asset, lower), bounded gas/fees
worker ◀── signature ── registry ;  worker checks the bytes match, recovers the signer, broadcasts
```

Three independent limits: NEAR rejects any other method for the key; the registry only signs transactions
it built itself, for outflow tightens, to the registered guard, recorded per chain and never higher than
before; the guard reverts anything that isn't tighter (`NotTighter`). The worker uses this path wherever
`guard.monitor()` equals the derived address and falls back to `MONITOR_PRIVATE_KEY` elsewhere
(`NEAR_CHAIN_SIGNATURES=off` disables it). `GET /v1/protocols/{id}/monitor` shows the address, its gas
balance and which chains use it. Demo: `npx tsx scripts/kronos-cli.ts chainsig-demo <chainId>`.

## MVP vs stretch (nothing unfinished is faked)

Working now: guard contracts + attack tests, the full API and pipeline, package + PR builder, deployment
verification, signed per-block attestations, the monitor, the NEAR registry and its tighten-only key.

Also working: **NEAR Chain Signatures for EVM tightens** (see below).

Stretch goals, not running in this MVP: SP1 → Groth16 proofs (`prover/`), NEAR Intents for cross-chain repay,
and analysis adapters beyond the compound-v2 shape. The attestor's TWAP is a median of on-chain samples
from the protocol's own oracle; multi-source agreement (Chainlink + Pyth + DEX) is in `prover/attest-core`
but not yet wired to live feeds.

What Kronos can't stop: users signing a malicious intent (phishing), stolen exchange keys, bugs in a chain's
own software, bugs in these invariants, and immutable protocols that can't host the hook (there, only users
going through the intent gateway are protected).
