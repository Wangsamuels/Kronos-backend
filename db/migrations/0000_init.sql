CREATE TYPE "public"."entry_role" AS ENUM('user', 'privileged');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('blocked', 'queued', 'released', 'admin_queued', 'admin_cancelled', 'admin_executed', 'tightened', 'alert');--> statement-breakpoint
CREATE TYPE "public"."log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."protocol_status" AS ENUM('draft', 'analyzing', 'review', 'approved', 'integrating', 'live', 'paused', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('proposed', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'review', 'approved', 'packaging', 'packaged', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tier_source" AS ENUM('agent', 'rule');--> statement-breakpoint
CREATE TABLE "admin_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"action_id" integer NOT NULL,
	"target" text NOT NULL,
	"selector" text NOT NULL,
	"function_name" text,
	"tier" integer NOT NULL,
	"eta" timestamp with time zone NOT NULL,
	"proposer" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_id" uuid NOT NULL,
	"commit_sha" text,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"error_json" jsonb,
	"snapshot_key" text,
	"ingest_json" jsonb,
	"thresholds_json" jsonb,
	"llm_json" jsonb,
	"token_cost" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_id" uuid,
	"chain_id" integer NOT NULL,
	"block" bigint NOT NULL,
	"oracle_ok" boolean NOT NULL,
	"solvency_ok" boolean NOT NULL,
	"proof_ref" text,
	"posted_tx" text,
	"data_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_id" uuid NOT NULL,
	"package_id" uuid,
	"chain_id" integer NOT NULL,
	"guard_address" text NOT NULL,
	"timelock_address" text,
	"registry_address" text,
	"verified" boolean DEFAULT false NOT NULL,
	"checks_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_block" bigint,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entrypoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"contract" text NOT NULL,
	"signature" text NOT NULL,
	"selector" text,
	"kind" text NOT NULL,
	"role" "entry_role" NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_id" uuid NOT NULL,
	"kind" "event_kind" NOT NULL,
	"tx_hash" text,
	"log_index" integer,
	"invariant_id" text,
	"asset" text,
	"amount" numeric,
	"data_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intent_schemas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"entrypoint_id" uuid NOT NULL,
	"eip712_json" jsonb NOT NULL,
	"bounds_json" jsonb NOT NULL,
	"plain_text" text,
	"status" "review_status" DEFAULT 'proposed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invariants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"template" text NOT NULL,
	"title" text NOT NULL,
	"plain_text" text NOT NULL,
	"solidity" text NOT NULL,
	"params_json" jsonb NOT NULL,
	"drafters" text[] DEFAULT '{}' NOT NULL,
	"evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"status" "review_status" DEFAULT 'proposed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"version" text NOT NULL,
	"config_hash" text NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"r2_key" text NOT NULL,
	"pr_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"website_url" text,
	"repo_url" text,
	"chain_id" integer NOT NULL,
	"addresses" text[] DEFAULT '{}' NOT NULL,
	"type" text DEFAULT 'lending' NOT NULL,
	"status" "protocol_status" DEFAULT 'draft' NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"github_installation_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"type" text DEFAULT 'log' NOT NULL,
	"stage" text NOT NULL,
	"level" "log_level" DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"payload_json" jsonb,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"normal_tx_count" integer NOT NULL,
	"normal_pass" integer NOT NULL,
	"attacks_total" integer NOT NULL,
	"attacks_blocked" integer NOT NULL,
	"gas_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"entrypoint_id" uuid NOT NULL,
	"tier" integer NOT NULL,
	"delay_seconds" integer NOT NULL,
	"source" "tier_source" NOT NULL,
	"rationale" text,
	"status" "review_status" DEFAULT 'proposed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_id" text,
	"github_login" text,
	"wallet_address" text,
	"near_account" text,
	"github_installation_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"protocol_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entrypoints" ADD CONSTRAINT "entrypoints_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_schemas" ADD CONSTRAINT "intent_schemas_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_schemas" ADD CONSTRAINT "intent_schemas_entrypoint_id_entrypoints_id_fk" FOREIGN KEY ("entrypoint_id") REFERENCES "public"."entrypoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invariants" ADD CONSTRAINT "invariants_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocols" ADD CONSTRAINT "protocols_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_reports" ADD CONSTRAINT "test_reports_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiers" ADD CONSTRAINT "tiers_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiers" ADD CONSTRAINT "tiers_entrypoint_id_entrypoints_id_fk" FOREIGN KEY ("entrypoint_id") REFERENCES "public"."entrypoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_actions_chain_action_idx" ON "admin_actions" USING btree ("protocol_id","chain_id","action_id");--> statement-breakpoint
CREATE INDEX "runs_protocol_idx" ON "analysis_runs" USING btree ("protocol_id");--> statement-breakpoint
CREATE INDEX "attestations_chain_block_idx" ON "attestations" USING btree ("chain_id","block");--> statement-breakpoint
CREATE INDEX "entrypoints_run_idx" ON "entrypoints" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "events_protocol_ts_idx" ON "events" USING btree ("protocol_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "events_tx_log_idx" ON "events" USING btree ("tx_hash","log_index","kind");--> statement-breakpoint
CREATE INDEX "protocols_owner_idx" ON "protocols" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "run_events_run_idx" ON "run_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_github_idx" ON "users" USING btree ("github_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_wallet_idx" ON "users" USING btree ("wallet_address");--> statement-breakpoint
CREATE UNIQUE INDEX "users_near_idx" ON "users" USING btree ("near_account");