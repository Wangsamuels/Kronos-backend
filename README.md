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
3. Auth: the access JWT comes back in the body (keep it in memory); the refresh token is an httpOnly cookie
   on `/v1/auth` (`POST /v1/auth/refresh`). Cross-site it is `SameSite=None; Secure`; with a shared parent
   domain set `COOKIE_SAMESITE=lax` and `COOKIE_DOMAIN`. GitHub OAuth redirects to
   `FRONTEND_URL/auth/callback#access_token=…`.
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
| Monitor | `NEAR_ACCOUNT_ID` + `NEAR_FUNCTION_CALL_KEY` (tighten-only on NEAR) and optionally `MONITOR_PRIVATE_KEY` (the guard's EVM `monitor` role, contract-enforced tighten-only). |

## MVP vs stretch (nothing unfinished is faked)

Working now: guard contracts + attack tests, the full API and pipeline, package + PR builder, deployment
verification, signed per-block attestations, the monitor, the NEAR registry and its tighten-only key.

Stretch goals, not running in this MVP: SP1 → Groth16 proofs (`prover/`), a Chain Signatures guardian so
the NEAR account signs Tier 0 actions on the EVM chains directly (today the NEAR `tighten` is recorded
on-chain and the EVM side is tightened with the monitor's EVM key), NEAR Intents for cross-chain repay,
and analysis adapters beyond the compound-v2 shape. The attestor's TWAP is a median of on-chain samples
from the protocol's own oracle; multi-source agreement (Chainlink + Pyth + DEX) is in `prover/attest-core`
but not yet wired to live feeds.

What Kronos can't stop: users signing a malicious intent (phishing), stolen exchange keys, bugs in a chain's
own software, bugs in these invariants, and immutable protocols that can't host the hook (there, only users
going through the intent gateway are protected).
