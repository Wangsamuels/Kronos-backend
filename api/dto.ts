import type { schema } from "../db/client.js";

type S = typeof schema;
type Row<K extends keyof S> = S[K] extends { $inferSelect: infer R } ? R : never;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const toProtocol = (p: Row<"protocols">, latestRunId: string | null = null) => ({
  id: p.id,
  name: p.name,
  websiteUrl: p.websiteUrl,
  repoUrl: p.repoUrl,
  chainId: p.chainId,
  addresses: p.addresses,
  type: p.type,
  status: p.status,
  latestRunId,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

export const toRun = (r: Row<"analysisRuns">) => ({
  id: r.id,
  protocolId: r.protocolId,
  commitSha: r.commitSha,
  status: r.status,
  stage: r.stage,
  error: r.error ?? null,
  tokenCost: r.tokenCost,
  llm: r.llm ?? null,
  startedAt: iso(r.startedAt),
  finishedAt: iso(r.finishedAt),
  createdAt: r.createdAt.toISOString(),
});

export const toEntrypoint = (e: Row<"entrypoints">) => ({
  id: e.id,
  contract: e.contract,
  signature: e.signature,
  selector: e.selector,
  kind: e.kind,
  role: e.role,
  notes: e.notes,
});

export const toIntentSchema = (s: Row<"intentSchemas">) => ({
  id: s.id,
  entrypointId: s.entrypointId,
  eip712: s.eip712,
  bounds: s.bounds,
  plainText: s.plainText,
  status: s.status,
});

export const toInvariant = (i: Row<"invariants">) => ({
  id: i.id,
  template: i.template,
  title: i.title,
  plainText: i.plainText,
  solidity: i.solidity,
  params: i.params as Record<string, unknown>,
  drafters: i.drafters,
  evidence: i.evidence,
  needsReview: i.needsReview,
  status: i.status,
});

export const toTier = (t: Row<"tiers">) => ({
  id: t.id,
  entrypointId: t.entrypointId,
  tier: t.tier,
  delaySeconds: t.delaySeconds,
  source: t.source,
  rationale: t.rationale,
  status: t.status,
});

export const toTestReport = (t: Row<"testReports">) => ({
  id: t.id,
  normalTxCount: t.normalTxCount,
  normalPass: t.normalPass,
  attacksTotal: t.attacksTotal,
  attacksBlocked: t.attacksBlocked,
  gas: t.gas,
  details: t.details,
});

export const toDeployment = (d: Row<"deployments">) => ({
  id: d.id,
  protocolId: d.protocolId,
  packageId: d.packageId,
  chainId: d.chainId,
  guardAddress: d.guardAddress,
  timelockAddress: d.timelockAddress,
  registryAddress: d.registryAddress,
  verified: d.verified,
  checks: d.checks,
  verifiedAt: iso(d.verifiedAt),
  createdAt: d.createdAt.toISOString(),
});

export const toEvent = (e: Row<"events">) => ({
  id: e.id,
  kind: e.kind,
  txHash: e.txHash,
  invariantId: e.invariantId,
  asset: e.asset,
  amount: e.amount,
  data: e.data,
  ts: e.ts.toISOString(),
});

export const toAdminAction = (a: Row<"adminActions">) => ({
  id: a.id,
  chainId: a.chainId,
  actionId: a.actionId,
  target: a.target,
  selector: a.selector,
  functionName: a.functionName,
  tier: a.tier,
  eta: a.eta.toISOString(),
  proposer: a.proposer,
  status: a.status,
  txHash: a.txHash,
});
