# Deploying Kronos

Order that works: **keys → contracts → NEAR registry → GitHub App → Heroku → frontend env**.
Testnets only (Aurora testnet + Base Sepolia + NEAR testnet).

---

## 1. Heroku resources

| Resource | Plan | Why |
|---|---|---|
| App on the **container** stack | `heroku stack:set container` | Foundry and Slither are system binaries; `heroku.yml` builds one Docker image for both processes |
| `web` dyno | Basic or Standard-1X (512 MB) | API + live log streams |
| `worker` dyno | **Standard-2X (1 GB) or larger** | forge/anvil need ≥ 1 GB; also runs the monitor and the attestor |
| Heroku Postgres | `heroku-postgresql:essential-0` | all data, plus packages/snapshots when R2 isn't set. Sets `DATABASE_URL` |
| Heroku Key-Value Store | `heroku-redis:mini` | BullMQ queues + live log pub/sub. Sets `REDIS_URL` |
| Log drain (optional) | Papertrail or any | searchable logs |

You don't need Heroku Scheduler: the attestor runs on a timer inside the worker. The release phase
(`node dist/db/migrate.js`) runs the database migrations on every deploy.

```bash
heroku stack:set container -a <app>
heroku addons:create heroku-postgresql:essential-0 -a <app>
heroku addons:create heroku-redis:mini -a <app>
heroku git:remote -a <app>
git push heroku main
heroku ps:type web=standard-1x worker=standard-2x -a <app>
heroku ps:scale web=1 worker=1 -a <app>
curl https://<app>.herokuapp.com/healthz      # {"ok":true,"db":"ok","redis":"PONG",...}
```

---

## 2. Config vars

### Set now (required)

| Var | Value |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `FRONTEND_URL` | `https://kronos-five-zeta.vercel.app` (no trailing slash) |
| `CORS_ORIGINS` | `https://kronos-five-zeta.vercel.app,https://kronos-*.vercel.app` (`*` covers preview deploys) |
| `PUBLIC_API_URL` | the URL the browser uses for the API. Direct: `https://<app>.herokuapp.com`. Proxied (recommended, §6): `https://kronos-five-zeta.vercel.app/api` |
| `COOKIE_SAMESITE` | `none` if the browser calls Heroku directly, `lax` if proxied |
| `PG_POOL_MAX` | `8` (Essential-0 allows 20 connections) |

`DATABASE_URL` and `REDIS_URL` are set by the add-ons. Don't set `PORT` either: Heroku sets it.

### Sign-in

| Var | Value |
|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | the **GitHub App's** client ID and a generated client secret (§5) |
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_SLUG` | the app's URL name, e.g. `kronos-guard` |
| `GITHUB_APP_PRIVATE_KEY` | the App's `.pem` contents: `heroku config:set GITHUB_APP_PRIVATE_KEY="$(cat kronos.private-key.pem)"` |
| `NEAR_SIGNIN_RECIPIENT` | optional; defaults to the frontend host (`kronos-five-zeta.vercel.app`). The frontend must use the same value |
| `ALLOW_DEV_LOGIN` | `false` in production. `true` only for judging/demo builds |

Ethereum (SIWE) and NEAR wallet sign-in need no keys.

### AI analysis

| Var | Value |
|---|---|
| `LLM_PROVIDER` | `near-ai` (unset = deterministic heuristic agents) |
| `NEAR_AI_API_KEY` | from the NEAR AI Cloud dashboard |
| `LLM_MODEL_A` / `LLM_MODEL_B` | default `zai-org/GLM-5.1-FP8`; set B to a different model to make the drafters truly independent |
| `LLM_TOKEN_BUDGET` | `400000` per run |

### Chains, attestor, monitor (after §3)

| Var | Value |
|---|---|
| `RPC_AURORA_TESTNET` | `https://testnet.aurora.dev` (or a provider URL) |
| `RPC_BASE_SEPOLIA` | `https://sepolia.base.org` (or a provider URL) |
| `ETHERSCAN_API_KEY` | Etherscan v2 key (Base Sepolia source fetch + fork replay) |
| `ATTESTOR_PRIVATE_KEY` | attestor key: must be the registry's `attestor`, funded on each chain |
| `ATTESTOR_INTERVAL_MS` | `60000`: how often the attestor checks. It only posts when an attestation passes half its allowed age or the verdict changes (see §3.2) |
| `MONITOR_PRIVATE_KEY` | monitor key: the guard's `monitor` role (contract-enforced tighten-only), funded |
| `NEAR_NETWORK` | `testnet` |
| `NEAR_REGISTRY_CONTRACT` | the registry account from §4 |
| `NEAR_ACCOUNT_ID` | the monitor's NEAR account |
| `NEAR_FUNCTION_CALL_KEY` | its function-call key, `ed25519:…` (methods = `tighten` only) |

### Storage (optional)

| Var | Value |
|---|---|
| `R2_ENDPOINT` / `R2_ACCESS_KEY` / `R2_SECRET_KEY` / `R2_BUCKET` | Cloudflare R2. Unset = stored in Postgres, which works on Heroku and is fine for the hackathon |

### Alerts (optional)

`ALERT_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

### Leave unset

`RPC_LOCAL` (local anvil only), `PORT`, `DATABASE_SSL` (auto), `WORKDIR`, `FORGE_BIN`, `ANVIL_BIN`,
`SLITHER_BIN`, `WORKER_ROLES`, `COOKIE_PATH` (default `/`), `COOKIE_DOMAIN` (only with a custom parent domain).

---

## 3. EVM contracts (Aurora testnet + Base Sepolia)

### 3.0 Tools (once, on your Mac)

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
cd ~/kronos/kronos-backend && npm ci
```

### 3.1 Wallets and what each key is for

| Wallet | Env var (where) | Role |
|---|---|---|
| deployer | `DEPLOYER_PRIVATE_KEY` (your Mac only, **never** Heroku) | deploys everything; admin + guardian + co-signer on testnet |
| attestor | `ATTESTOR_PRIVATE_KEY` (Heroku) · its address → `ATTESTOR_ADDRESS` at deploy | posts attestations to the registry |
| monitor | `MONITOR_PRIVATE_KEY` (Heroku) · its address → `MONITOR_ADDRESS` at deploy | the guard's tighten-only `monitor` role |

The attestor and monitor must differ from the deployer: the worker sends transactions with them
continuously and nonces would collide.

```bash
cast wallet new
cast wallet new
cast wallet new
```

Copy the three address / private-key pairs into a local file outside the repo:

```bash
nano ~/.kronos-keys.env
```

```
DEPLOYER_PRIVATE_KEY=0x...
DEPLOYER_ADDRESS=0x...
ATTESTOR_PRIVATE_KEY=0x...
ATTESTOR_ADDRESS=0x...
MONITOR_PRIVATE_KEY=0x...
MONITOR_ADDRESS=0x...
```

```bash
chmod 600 ~/.kronos-keys.env
set -a; source ~/.kronos-keys.env; set +a
heroku config:set -a kronos ATTESTOR_PRIVATE_KEY=$ATTESTOR_PRIVATE_KEY MONITOR_PRIVATE_KEY=$MONITOR_PRIVATE_KEY
```

### 3.2 Testnet ETH

Budget: a full deploy is ~14.1M gas (27 transactions).

| Chain | Cost of one deploy | Where to get ETH |
|---|---|---|
| Aurora testnet | ~0.001 ETH (gas fixed at 0.07 gwei) | aurora.dev/faucet gives 0.001 ETH per claim (web only, no API). That's just short of one deploy, so either claim with all three wallets and send it to the deployer, or get Sepolia ETH (e.g. Google Cloud Web3 faucet) and bridge it with the testnet Rainbow Bridge (testnet.rainbowbridge.app). Aim for ≥ 0.003 ETH on the deployer. |
| Base Sepolia | well under 0.001 ETH | Coinbase CDP faucet: web (portal.cdp.coinbase.com → Faucets) or CLI below; also the Alchemy / QuickNode Base Sepolia faucets |

Base Sepolia from the command line (needs a free CDP account → API key + wallet secret; 0.0001 ETH per claim):

```bash
mkdir -p ~/cdp-faucet && cd ~/cdp-faucet && npm init -y >/dev/null && npm i @coinbase/cdp-sdk tsx >/dev/null
export CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... CDP_WALLET_SECRET=...
cat > claim.ts <<'TS'
import { CdpClient } from "@coinbase/cdp-sdk";
const cdp = new CdpClient();
for (const address of process.argv.slice(2)) {
  for (let i = 0; i < 5; i++) {
    const r = await cdp.evm.requestFaucet({ address: address as `0x${string}`, network: "base-sepolia", token: "eth" });
    console.log(address, r.transactionHash);
  }
}
TS
npx tsx claim.ts $DEPLOYER_ADDRESS $ATTESTOR_ADDRESS $MONITOR_ADDRESS
```

Move ETH between your wallets and check balances:

```bash
cast send $ATTESTOR_ADDRESS --value 0.0003ether --private-key $DEPLOYER_PRIVATE_KEY --rpc-url https://testnet.aurora.dev --legacy
cast balance $DEPLOYER_ADDRESS --ether --rpc-url https://testnet.aurora.dev
cast balance $DEPLOYER_ADDRESS --ether --rpc-url https://sepolia.base.org
```

Running costs: the attestor checks every `ATTESTOR_INTERVAL_MS` (60 s) and posts only when the current
attestation passes half its allowed age (`attestationMaxAgeBlocks`, 1800 blocks in the demo package) or
the oracle/solvency verdict changes. Block times differ: about 0.6 s on Aurora testnet (a post roughly
every 9 minutes) and about 0.2 s on Base Sepolia (roughly every 3 minutes, but Base gas is very cheap).

### 3.3 Get the approved parameters (so the config hash matches)

Heroku must be healthy and `ALLOW_DEV_LOGIN=true` (or pass `TOKEN=<access token>`):

```bash
cd ~/kronos/kronos-backend
API_URL=https://kronos-9fbcca7bfc9b.herokuapp.com npm run kronos -- prepare
```

This submits the MiniLend sample, waits for the analysis (6/6 attacks blocked), approves it and writes
`contracts/deployments/kronos.config.json` (approved parameters) and `kronos.protocol.json` (protocol id).

### 3.4 Deploy (and verify source on the explorers in the same step)

```bash
cd ~/kronos/kronos-backend/contracts
set -a; source ~/.kronos-keys.env; set +a
export RPC_AURORA_TESTNET=https://testnet.aurora.dev RPC_BASE_SEPOLIA=https://sepolia.base.org
export KRONOS_CONFIG=deployments/kronos.config.json

forge script script/Deploy.s.sol --rpc-url aurora_testnet --broadcast --legacy --slow \
  --verify --verifier blockscout --verifier-url https://explorer.testnet.aurora.dev/api/

forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --slow \
  --verify --etherscan-api-key $ETHERSCAN_API_KEY
```

Each run deploys the mock tokens and oracles, the thin THIN pool, `AttestationRegistry` (attestor =
`ATTESTOR_ADDRESS`), `GuardTimelock`, `GuardedMiniLend` (monitor = `MONITOR_ADDRESS`) and the unguarded
`MiniLend`, installs the tier table, lists the markets, sets the outflow threshold, closes setup and seeds
1M kUSDC of liquidity. Addresses go to `contracts/deployments/1313161555.json` and `84532.json`; commit
those (they're public) so the frontend can use them. Verification is optional: drop the `--verify …`
flags if the explorer is slow; the deployment still works.

### 3.5 Register with Kronos (on-chain verification → live)

```bash
cd ~/kronos/kronos-backend
API_URL=https://kronos-9fbcca7bfc9b.herokuapp.com npm run kronos -- register 1313161555
API_URL=https://kronos-9fbcca7bfc9b.herokuapp.com npm run kronos -- register 84532
```

All checks must show ✓ (config hash, every entry point reverts without an intent, timelock owns every
privileged function, setup closed). The protocol goes `live`; the monitor and the attestor pick it up
within a minute (`heroku logs --tail -a kronos --dyno worker`).

---

## 4. NEAR registry (testnet)

```bash
cargo install near-cli-rs cargo-near
# accounts (pick unique names: kronos.testnet is probably taken)
near account create-account sponsor-by-faucet-service kronos-registry-<you>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near account create-account sponsor-by-faucet-service kronos-monitor-<you>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create

cd near-registry
REGISTRY=kronos-registry-<you>.testnet MONITOR=kronos-monitor-<you>.testnet ./deploy.sh
```

`deploy.sh` builds and deploys the contract, calls `new` and `add_monitor`, and creates the monitor's
**function-call key** (receiver = registry, methods = `tighten`). Put the printed private key in
`NEAR_FUNCTION_CALL_KEY`, the monitor account in `NEAR_ACCOUNT_ID` and the registry in `NEAR_REGISTRY_CONTRACT`.

Register the protocol on NEAR. The `protocol_id` must be the Kronos protocol id (the UUID the API returns):

```bash
near contract call-function as-transaction kronos-registry-<you>.testnet register_protocol \
  json-args '{"protocol_id":"<kronos protocol uuid>","chain_id":"1313161555","guard":"0x<guard>","package_hash":"0x<configHash>"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <your-account>.testnet network-config testnet sign-with-keychain send
```

Showcase check: `tighten` with the monitor key succeeds, and `unpause` with the same key is rejected by
NEAR itself (the key can't call any other method).

---

## 5. GitHub App (sign-in + private repos + PRs in one)

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App:

- **Callback URL:** `<PUBLIC_API_URL>/v1/auth/github/callback`
- tick **Request user authorization (OAuth) during installation**
- **Setup URL:** the same callback URL; tick **Redirect on update**
- **Webhook:** untick Active
- **Repository permissions:** Contents read & write, Pull requests read & write, Metadata read
- **Where can it be installed:** Any account

Then generate a client secret and a private key. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_APP_PRIVATE_KEY`. The same app handles "Continue with
GitHub" and the later "Install the GitHub App" step.

---

## 6. Connecting the Vercel frontend

**Recommended: proxy the API through Vercel**, so the refresh cookie is first-party. Safari blocks
third-party cookies, which breaks the silent session restore if the browser calls `herokuapp.com` directly.

```js
// next.config.js (frontend)
async rewrites() {
  return [{ source: "/api/:path*", destination: "https://<app>.herokuapp.com/:path*" }];
}
```

Then on Heroku: `PUBLIC_API_URL=https://kronos-five-zeta.vercel.app/api` and `COOKIE_SAMESITE=lax`; on
Vercel: `NEXT_PUBLIC_API_URL=/api`. If the live log stream gets cut through the proxy, point only
`EventSource` at `https://<app>.herokuapp.com` (it authenticates with `?token=`, no cookie needed).
It resumes automatically with `Last-Event-ID`.

Direct alternative: `PUBLIC_API_URL=https://<app>.herokuapp.com`, `COOKIE_SAMESITE=none`,
`NEXT_PUBLIC_API_URL=https://<app>.herokuapp.com`. This works in Chrome and Firefox; Safari users have
to sign in again after reloading the page.
