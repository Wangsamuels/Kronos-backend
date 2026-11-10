import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  serial,
  numeric,
  customType,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const protocolStatus = pgEnum("protocol_status", [
  "draft",
  "analyzing",
  "review",
  "approved",
  "integrating",
  "live",
  "paused",
  "unsupported",
]);
export const runStatus = pgEnum("run_status", ["queued", "running", "review", "approved", "packaging", "packaged", "failed"]);
export const reviewStatus = pgEnum("review_status", ["proposed", "approved", "rejected"]);
export const entryRole = pgEnum("entry_role", ["user", "privileged"]);
export const tierSource = pgEnum("tier_source", ["agent", "rule"]);
export const eventKind = pgEnum("event_kind", [
  "blocked",
  "queued",
  "released",
  "admin_queued",
  "admin_cancelled",
  "admin_executed",
  "tightened",
  "alert",
]);
export const logLevel = pgEnum("log_level", ["debug", "info", "warn", "error"]);

const ts = (n: string) => timestamp(n, { withTimezone: true });

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    githubId: text("github_id"),
    githubLogin: text("github_login"),
    walletAddress: text("wallet_address"),
    nearAccount: text("near_account"),
    githubInstallationId: bigint("github_installation_id", { mode: "number" }),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("users_github_idx").on(t.githubId),
    uniqueIndex("users_wallet_idx").on(t.walletAddress),
    uniqueIndex("users_near_idx").on(t.nearAccount),
  ],
);

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const authNonces = pgTable("auth_nonces", {
  nonce: text("nonce").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

export const protocols = pgTable(
  "protocols",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .references(() => users.id)
      .notNull(),
    name: text("name").notNull(),
    websiteUrl: text("website_url"),
    repoUrl: text("repo_url"),
    chainId: integer("chain_id").notNull(),
    addresses: text("addresses").array().notNull().default([]),
    type: text("type").notNull().default("lending"),
    status: protocolStatus("status").notNull().default("draft"),
    settings: jsonb("settings_json").notNull().default({}),
    githubInstallationId: bigint("github_installation_id", { mode: "number" }),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => [index("protocols_owner_idx").on(t.ownerId)],
);

export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    protocolId: uuid("protocol_id")
      .references(() => protocols.id, { onDelete: "cascade" })
      .notNull(),
    commitSha: text("commit_sha"),
    status: runStatus("status").notNull().default("queued"),
    stage: text("stage").notNull().default("queued"),
    error: jsonb("error_json"),
    snapshotKey: text("snapshot_key"),
    ingest: jsonb("ingest_json"), // classification, key state, source summary
    thresholds: jsonb("thresholds_json"),
    llm: jsonb("llm_json"), // provider, models, attestation (TEE) if any
    tokenCost: integer("token_cost").notNull().default(0),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("runs_protocol_idx").on(t.protocolId)],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: serial("id").primaryKey(),
    runId: uuid("run_id")
      .references(() => analysisRuns.id, { onDelete: "cascade" })
      .notNull(),
    type: text("type").notNull().default("log"), // stage | log | entrypoint | invariant | done | error
    stage: text("stage").notNull(),
    level: logLevel("level").notNull().default("info"),
    message: text("message").notNull(),
    payload: jsonb("payload_json"),
    ts: ts("ts").defaultNow().notNull(),
  },
  (t) => [index("run_events_run_idx").on(t.runId, t.id)],
);

export const entrypoints = pgTable(
  "entrypoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .references(() => analysisRuns.id, { onDelete: "cascade" })
      .notNull(),
    contract: text("contract").notNull(),
    signature: text("signature").notNull(),
    selector: text("selector"),
    kind: text("kind").notNull(),
    role: entryRole("role").notNull(),
    notes: text("notes"),
  },
  (t) => [index("entrypoints_run_idx").on(t.runId)],
);

export const intentSchemas = pgTable("intent_schemas", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .references(() => analysisRuns.id, { onDelete: "cascade" })
    .notNull(),
  entrypointId: uuid("entrypoint_id")
    .references(() => entrypoints.id, { onDelete: "cascade" })
    .notNull(),
  eip712: jsonb("eip712_json").notNull(),
  bounds: jsonb("bounds_json").notNull(),
  plainText: text("plain_text"),
  status: reviewStatus("status").notNull().default("proposed"),
});

export const invariants = pgTable("invariants", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .references(() => analysisRuns.id, { onDelete: "cascade" })
    .notNull(),
  template: text("template").notNull(),
  title: text("title").notNull(),
  plainText: text("plain_text").notNull(),
  solidity: text("solidity").notNull(),
  params: jsonb("params_json").notNull(),
  drafters: text("drafters").array().notNull().default([]),
  evidence: jsonb("evidence_json").notNull().default({}),
  needsReview: boolean("needs_review").notNull().default(false),
  status: reviewStatus("status").notNull().default("proposed"),
});

export const tiers = pgTable("tiers", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .references(() => analysisRuns.id, { onDelete: "cascade" })
    .notNull(),
  entrypointId: uuid("entrypoint_id")
    .references(() => entrypoints.id, { onDelete: "cascade" })
    .notNull(),
  tier: integer("tier").notNull(),
  delaySeconds: integer("delay_seconds").notNull(),
  source: tierSource("source").notNull(),
  rationale: text("rationale"),
  status: reviewStatus("status").notNull().default("proposed"),
});

export const testReports = pgTable("test_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .references(() => analysisRuns.id, { onDelete: "cascade" })
    .notNull(),
  normalTxCount: integer("normal_tx_count").notNull(),
  normalPass: integer("normal_pass").notNull(),
  attacksTotal: integer("attacks_total").notNull(),
  attacksBlocked: integer("attacks_blocked").notNull(),
  gas: jsonb("gas_json").notNull().default({}),
  details: jsonb("details_json").notNull().default({}),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const packages = pgTable("packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .references(() => analysisRuns.id, { onDelete: "cascade" })
    .notNull(),
  version: text("version").notNull(),
  configHash: text("config_hash").notNull(),
  manifest: jsonb("manifest_json").notNull(),
  r2Key: text("r2_key").notNull(),
  prUrl: text("pr_url"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const deployments = pgTable("deployments", {
  id: uuid("id").primaryKey().defaultRandom(),
  protocolId: uuid("protocol_id")
    .references(() => protocols.id, { onDelete: "cascade" })
    .notNull(),
  packageId: uuid("package_id").references(() => packages.id),
  chainId: integer("chain_id").notNull(),
  guardAddress: text("guard_address").notNull(),
  timelockAddress: text("timelock_address"),
  registryAddress: text("registry_address"),
  verified: boolean("verified").notNull().default(false),
  checks: jsonb("checks_json").notNull().default([]),
  lastBlock: bigint("last_block", { mode: "number" }),
  verifiedAt: ts("verified_at"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    protocolId: uuid("protocol_id")
      .references(() => protocols.id, { onDelete: "cascade" })
      .notNull(),
    kind: eventKind("kind").notNull(),
    txHash: text("tx_hash"),
    logIndex: integer("log_index"),
    invariantId: text("invariant_id"),
    asset: text("asset"),
    amount: numeric("amount"),
    data: jsonb("data_json").notNull().default({}),
    ts: ts("ts").defaultNow().notNull(),
  },
  (t) => [index("events_protocol_ts_idx").on(t.protocolId, t.ts), uniqueIndex("events_tx_log_idx").on(t.txHash, t.logIndex, t.kind)],
);

export const adminActions = pgTable(
  "admin_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    protocolId: uuid("protocol_id")
      .references(() => protocols.id, { onDelete: "cascade" })
      .notNull(),
    chainId: integer("chain_id").notNull(),
    actionId: integer("action_id").notNull(),
    target: text("target").notNull(),
    selector: text("selector").notNull(),
    functionName: text("function_name"),
    tier: integer("tier").notNull(),
    eta: ts("eta").notNull(),
    proposer: text("proposer"),
    status: text("status").notNull().default("queued"), // queued | cancelled | executed
    txHash: text("tx_hash"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("admin_actions_chain_action_idx").on(t.protocolId, t.chainId, t.actionId)],
);

export const attestations = pgTable(
  "attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    protocolId: uuid("protocol_id").references(() => protocols.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(),
    block: bigint("block", { mode: "number" }).notNull(),
    oracleOk: boolean("oracle_ok").notNull(),
    solvencyOk: boolean("solvency_ok").notNull(),
    proofRef: text("proof_ref"),
    postedTx: text("posted_tx"),
    data: jsonb("data_json").notNull().default({}),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("attestations_chain_block_idx").on(t.chainId, t.block)],
);

export const waitlist = pgTable("waitlist", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  protocolType: text("protocol_type").notNull(),
  createdAt: ts("created_at").defaultNow().notNull(),
});

/** Object storage fallback when R2 is not configured (shared by every dyno, unlike local disk). */
export const blobs = pgTable("blobs", {
  key: text("key").primaryKey(),
  data: bytea("data").notNull(),
  contentType: text("content_type").notNull(),
  bytes: integer("bytes").notNull(),
  createdAt: ts("created_at").defaultNow().notNull(),
});
