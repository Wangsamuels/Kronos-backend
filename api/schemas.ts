import { z } from "zod";

/** Shared Zod schemas: request validation + OpenAPI 3.1 generation (the frontend contract). */

export const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.any().optional() }),
});

export const Id = z.object({ id: z.string().uuid() });
export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address");
export const Page = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const ProtocolStatus = z.enum(["draft", "analyzing", "review", "approved", "integrating", "live", "paused", "unsupported"]);
export const RunStatus = z.enum(["queued", "running", "review", "approved", "packaging", "packaged", "failed"]);
export const ReviewStatus = z.enum(["proposed", "approved", "rejected"]);

export const Session = z.object({ accessToken: z.string(), expiresIn: z.number(), userId: z.string() });

export const User = z.object({
  id: z.string(),
  githubLogin: z.string().nullable(),
  walletAddress: z.string().nullable(),
  nearAccount: z.string().nullable(),
  githubAppInstalled: z.boolean(),
  createdAt: z.string(),
});

export const CreateProtocol = z
  .object({
    name: z.string().min(1).max(80).optional(),
    websiteUrl: z.string().url().optional(),
    repoUrl: z
      .string()
      .min(1)
      .describe("https://github.com/org/repo[/tree/<ref>/<subdir>] or sample://minilend")
      .optional(),
    chainId: z.number().int(),
    addresses: z.array(Address).max(50).optional(),
  })
  .refine((v) => v.repoUrl || (v.addresses && v.addresses.length > 0), {
    message: "Provide repoUrl or at least one verified contract address",
  });

export const Protocol = z.object({
  id: z.string(),
  name: z.string(),
  websiteUrl: z.string().nullable(),
  repoUrl: z.string().nullable(),
  chainId: z.number(),
  addresses: z.array(z.string()),
  type: z.string(),
  status: ProtocolStatus,
  latestRunId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const Run = z.object({
  id: z.string(),
  protocolId: z.string(),
  commitSha: z.string().nullable(),
  status: RunStatus,
  stage: z.string(),
  error: z.any().nullable(),
  tokenCost: z.number(),
  llm: z.any().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const Entrypoint = z.object({
  id: z.string(),
  contract: z.string(),
  signature: z.string(),
  selector: z.string().nullable(),
  kind: z.string(),
  role: z.enum(["user", "privileged"]),
  notes: z.string().nullable(),
});

export const IntentSchema = z.object({
  id: z.string(),
  entrypointId: z.string(),
  eip712: z.any(),
  bounds: z.any(),
  plainText: z.string().nullable(),
  status: ReviewStatus,
});

export const Invariant = z.object({
  id: z.string(),
  template: z.string(),
  title: z.string(),
  plainText: z.string(),
  solidity: z.string(),
  params: z.record(z.any()),
  drafters: z.array(z.string()),
  evidence: z.any(),
  needsReview: z.boolean(),
  status: ReviewStatus,
});

export const Tier = z.object({
  id: z.string(),
  entrypointId: z.string(),
  tier: z.number(),
  delaySeconds: z.number(),
  source: z.enum(["agent", "rule"]),
  rationale: z.string().nullable(),
  status: ReviewStatus,
});

export const TestReport = z.object({
  id: z.string(),
  normalTxCount: z.number(),
  normalPass: z.number(),
  attacksTotal: z.number(),
  attacksBlocked: z.number(),
  gas: z.any(),
  details: z.any(),
});

export const Results = z.object({
  run: Run,
  entrypoints: z.array(Entrypoint),
  intentSchemas: z.array(IntentSchema),
  invariants: z.array(Invariant),
  tiers: z.array(Tier),
  thresholds: z.any().nullable(),
  testReport: TestReport.nullable(),
});

export const PatchInvariant = z.object({
  status: ReviewStatus.optional(),
  params: z.record(z.any()).optional(),
});
export const PatchIntentSchema = z.object({
  status: ReviewStatus.optional(),
  bounds: z.record(z.any()).optional(),
});
export const PatchTier = z.object({
  status: ReviewStatus.optional(),
  tier: z.number().int().min(0).max(3).optional(),
});

export const Package = z.object({
  id: z.string(),
  runId: z.string(),
  version: z.string(),
  configHash: z.string(),
  manifest: z.any(),
  downloadUrl: z.string(),
  prUrl: z.string().nullable(),
  createdAt: z.string(),
});

export const CreateDeployment = z.object({
  chainId: z.number().int(),
  guardAddress: Address,
  timelockAddress: Address.optional(),
  registryAddress: Address.optional(),
});

export const Deployment = z.object({
  id: z.string(),
  protocolId: z.string(),
  packageId: z.string().nullable(),
  chainId: z.number(),
  guardAddress: z.string(),
  timelockAddress: z.string().nullable(),
  registryAddress: z.string().nullable(),
  verified: z.boolean(),
  checks: z.any(),
  verifiedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const Event = z.object({
  id: z.string(),
  kind: z.string(),
  txHash: z.string().nullable(),
  invariantId: z.string().nullable(),
  asset: z.string().nullable(),
  amount: z.string().nullable(),
  data: z.any(),
  ts: z.string(),
});

export const AdminAction = z.object({
  id: z.string(),
  chainId: z.number(),
  actionId: z.number(),
  target: z.string(),
  selector: z.string(),
  functionName: z.string().nullable(),
  tier: z.number(),
  eta: z.string(),
  proposer: z.string().nullable(),
  status: z.string(),
  txHash: z.string().nullable(),
});

export const Overview = z.object({
  protocol: Protocol,
  deployment: Deployment.nullable(),
  stats24h: z.object({
    blocked: z.number(),
    queued: z.number(),
    released: z.number(),
    adminQueued: z.number(),
    alerts: z.number(),
  }),
  attestation: z
    .object({ block: z.number(), ageSeconds: z.number(), oracleOk: z.boolean(), solvencyOk: z.boolean(), postedTx: z.string().nullable() })
    .nullable(),
  queuedOutflow: z.array(z.object({ asset: z.string(), amount: z.string(), claims: z.number() })),
  pendingAdminActions: z.number(),
});

export const Settings = z.object({
  thresholds: z.record(z.object({ threshold: z.string(), staleLimit: z.string().optional() })).optional(),
  alerts: z
    .object({
      webhookUrl: z.string().url().nullable().optional(),
      telegramChatId: z.string().nullable().optional(),
      discordWebhookUrl: z.string().url().nullable().optional(),
    })
    .optional(),
  autoTighten: z.boolean().optional(),
});

export const Waitlist = z.object({ email: z.string().email(), protocolType: z.string().min(1).max(40) });
