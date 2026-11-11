import "dotenv/config";
import { z } from "zod";

/**
 * Every setting comes from Heroku config vars (or a local .env). No secrets in code.
 * Optional integrations fall back to clearly labelled local modes so the repo runs end to end
 * without third-party keys:
 *   - no NEAR_AI_API_KEY / LLM key  -> LLM_PROVIDER=heuristic (deterministic rule-based agents)
 *   - no R2_*                       -> objects stored in Postgres (works across Heroku dynos)
 *   - no GITHUB_APP_*               -> public clones only; PR step returns a zip download instead
 *   - no ATTESTOR_PRIVATE_KEY       -> attestor disabled
 *   - no NEAR_FUNCTION_CALL_KEY     -> monitor logs the tighten call it would have made
 */
const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/kronos"),
  DATABASE_SSL: bool,
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(16).default("dev-only-secret-change-me-please"),
  ALLOW_DEV_LOGIN: bool,
  COOKIE_SAMESITE: z.enum(["lax", "none", "strict"]).optional(),
  COOKIE_DOMAIN: z.string().optional(),
  // "/" so the refresh cookie also works when the frontend proxies the API under a path (e.g. /api)
  COOKIE_PATH: z.string().default("/"),
  // NEP-413 `recipient` the NEAR wallet signs for; defaults to the frontend's host
  NEAR_SIGNIN_RECIPIENT: z.string().optional(),
  ACCESS_TOKEN_TTL: z.coerce.number().default(15 * 60),
  REFRESH_TOKEN_TTL: z.coerce.number().default(30 * 24 * 3600),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  LLM_PROVIDER: z.enum(["near-ai", "openai-compatible", "heuristic"]).optional(),
  NEAR_AI_API_KEY: z.string().optional(),
  NEAR_AI_BASE_URL: z.string().default("https://cloud-api.near.ai/v1"),
  LLM_MODEL_A: z.string().default("z-ai/glm-5.3"),
  LLM_MODEL_B: z.string().default("Qwen/Qwen3.6-35B-A3B-FP8"), // a different model family keeps drafter B independent
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_TOKEN_BUDGET: z.coerce.number().default(400_000),

  ETHERSCAN_API_KEY: z.string().optional(),
  RPC_AURORA_TESTNET: z.string().default("https://testnet.aurora.dev"),
  RPC_BASE_SEPOLIA: z.string().default("https://sepolia.base.org"),
  RPC_LOCAL: z.string().optional(),

  ATTESTOR_PRIVATE_KEY: z.string().optional(),
  ATTESTOR_INTERVAL_MS: z.coerce.number().default(60_000), // how often to check; posts only when needed
  MONITOR_PRIVATE_KEY: z.string().optional(), // EVM key holding the guard's tighten-only `monitor` role
  MONITOR_INTERVAL_MS: z.coerce.number().default(12_000),
  NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NEAR_RPC_URL: z.string().optional(),
  NEAR_REGISTRY_CONTRACT: z.string().default("kronos.testnet"),
  NEAR_ACCOUNT_ID: z.string().optional(),
  NEAR_FUNCTION_CALL_KEY: z.string().optional(),

  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY: z.string().optional(),
  R2_SECRET_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("kronos"),

  ALERT_WEBHOOK_URL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  DISCORD_WEBHOOK_URL: z.string().optional(),

  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  PUBLIC_API_URL: z.string().optional(),
  WORKDIR: z.string().default(".data/work"),
  FORGE_BIN: z.string().default("forge"),
  ANVIL_BIN: z.string().default("anvil"),
  SLITHER_BIN: z.string().default("slither"),
  WORKER_ROLES: z.string().default("ingest,analyze,verify,package,monitor,attestor"),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  const e = parsed.data;
  e.FRONTEND_URL = e.FRONTEND_URL.replace(/\/$/, "");
  e.NEAR_SIGNIN_RECIPIENT ??= new URL(e.FRONTEND_URL).host;
  if (!e.LLM_PROVIDER) {
    e.LLM_PROVIDER = e.NEAR_AI_API_KEY ? "near-ai" : e.LLM_API_KEY && e.LLM_BASE_URL ? "openai-compatible" : "heuristic";
  }
  if (e.NODE_ENV === "production" && e.JWT_SECRET.startsWith("dev-only")) {
    console.error("JWT_SECRET must be set in production");
    process.exit(1);
  }
  return e;
}

export const env = load();

export const integrations = {
  llm: env.LLM_PROVIDER as string,
  storage: env.R2_ENDPOINT && env.R2_ACCESS_KEY && env.R2_SECRET_KEY ? "r2" : "postgres",
  githubApp: Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY),
  githubOAuth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  attestor: Boolean(env.ATTESTOR_PRIVATE_KEY),
  nearMonitorKey: Boolean(env.NEAR_ACCOUNT_ID && env.NEAR_FUNCTION_CALL_KEY),
  evmMonitorKey: Boolean(env.MONITOR_PRIVATE_KEY),
  etherscan: Boolean(env.ETHERSCAN_API_KEY),
};
