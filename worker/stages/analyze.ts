import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { emit, runLogger } from "../../lib/events.js";
import { enqueueStage, type StageJob } from "../../lib/queues.js";
import { providerName } from "../../lib/llm.js";
import { loadRun, setStage, type IngestData } from "../context.js";
import { allFunctions } from "../ast.js";
import { USER_KINDS } from "../agents/types.js";
import { TEMPLATES } from "../templates/library.js";
import {
  TIER_DELAYS,
  classifyTiers,
  draftInvariants,
  mapProtocol,
  mergeDrafts,
  redTeam,
  schemaFor,
  type MergedInvariant,
} from "../agents/agents.js";

/** Persists merged invariants (replacing any previous draft for the run). */
export async function saveInvariants(runId: string, merged: MergedInvariant[], round: number) {
  await db.delete(schema.invariants).where(eq(schema.invariants.runId, runId));
  const rows = merged.map((m) => {
    const t = TEMPLATES[m.template] ?? TEMPLATES.custom;
    return {
      runId,
      template: m.template,
      title: m.title || t.title,
      plainText: t.plain(m.params),
      solidity: m.customSolidity ?? t.solidity(m.params),
      params: m.params,
      drafters: m.drafters,
      needsReview: m.needsReview,
      evidence: { rationale: m.rationale, stops: t.stops, disagreement: m.disagreement ?? null, round },
    };
  });
  return rows.length ? db.insert(schema.invariants).values(rows).returning() : [];
}

/**
 * Stage 2 — Analysis orchestrator: mapper -> schema agent -> drafters A and B (independent) -> merge ->
 * tier classifier -> red-team plan. Every agent output is typed JSON validated by Zod.
 */
export async function analyze(job: StageJob) {
  const { runId, protocolId } = job;
  const { run, protocol } = await loadRun(runId);
  const ingest = run.ingest as IngestData;
  const model = ingest.model;
  const chatIds: string[] = [];
  const track = <T extends { chatId?: string }>(r: T) => {
    if (r.chatId) chatIds.push(r.chatId);
    return r;
  };

  // idempotent re-run
  await db.delete(schema.entrypoints).where(eq(schema.entrypoints.runId, runId));

  // --- mapper
  await setStage(runId, "map", `Mapper agent: listing entry points (provider: ${providerName()})`);
  const mapRes = track(await mapProtocol(runId, model));
  const map = mapRes.data;
  const mainContract = model.contracts.find((c) => c.name === map.protocolContract);
  const fns = mainContract ? allFunctions(model, mainContract) : model.contracts.flatMap((c) => c.functions);
  const epRows = map.entrypoints.map((e) => ({
    runId,
    contract: map.protocolContract,
    signature: e.signature,
    selector: fns.find((f) => f.signature === e.signature)?.selector ?? null,
    kind: e.kind,
    role: e.role,
    notes: e.notes ?? null,
  }));
  const eps = epRows.length ? await db.insert(schema.entrypoints).values(epRows).returning() : [];
  for (const e of eps) await emit(runId, "entrypoint", "map", `${e.role === "user" ? "User" : "Privileged"} ${e.kind}: ${e.signature}`, e);
  const log = runLogger(runId, "map");
  await log.info(`Main contract ${map.protocolContract}${map.coreContract ? ` (logic in ${map.coreContract})` : ""}; adapter: ${map.adapter}`, {
    keyState: map.keyState,
  });

  // --- schema agent
  await setStage(runId, "schema", "Schema agent: one EIP-712 intent per user entry point");
  const cf = 8000;
  const schemaRows = eps
    .filter((e) => e.role === "user" && USER_KINDS.has(e.kind))
    .map((e) => {
      const s = schemaFor(e.kind, protocol.chainId, cf);
      return { runId, entrypointId: e.id, eip712: s.eip712, bounds: s.bounds, plainText: s.plainText };
    });
  if (schemaRows.length) await db.insert(schema.intentSchemas).values(schemaRows);
  await runLogger(runId, "schema").info(`${schemaRows.length} intent types: ${[...new Set(schemaRows.map((s) => (s.eip712 as { primaryType: string }).primaryType))].join(", ")}`);

  // --- drafters A and B, independently
  await setStage(runId, "invariants", "Invariant drafters A and B: filling template slots independently");
  const [a, b] = await Promise.all([
    draftInvariants(runId, "A", model, map, protocol.chainId),
    draftInvariants(runId, "B", model, map, protocol.chainId),
  ]);
  track(a);
  track(b);
  const merged = mergeDrafts(a.data.invariants, b.data.invariants);
  const invRows = await saveInvariants(runId, merged, 0);
  for (const i of invRows) {
    await emit(runId, "invariant", "invariants", `${i.title}${i.needsReview ? " — drafters disagree, flagged for review" : " — both drafters agree"}`, {
      id: i.id,
      template: i.template,
      params: i.params,
      drafters: i.drafters,
      needsReview: i.needsReview,
    });
  }

  // --- tiers
  await setStage(runId, "tiers", "Tier classifier: timelock tier per privileged function (hard rules override)");
  const priv = eps.filter((e) => e.role === "privileged");
  const decisions = await classifyTiers(runId, priv.map((p) => ({ signature: p.signature, kind: p.kind })));
  const tierRows = decisions.map((d) => ({
    runId,
    entrypointId: priv.find((p) => p.signature === d.signature)!.id,
    tier: d.tier,
    delaySeconds: TIER_DELAYS[d.tier],
    source: d.source,
    rationale: d.rationale,
  }));
  await db.delete(schema.tiers).where(eq(schema.tiers.runId, runId));
  if (tierRows.length) await db.insert(schema.tiers).values(tierRows);
  const tl = runLogger(runId, "tiers");
  for (const d of decisions) await tl.info(`Tier ${d.tier} ${d.signature} — ${d.rationale}${d.source === "rule" ? " (hard rule)" : ""}`);

  // --- red team plan (execution happens in the verifier, on the fork)
  await setStage(runId, "redteam", "Red-team agent: choosing exploits to run against the drafted guard");
  const rt = track(await redTeam(runId, model, map, merged));
  const rtl = runLogger(runId, "redteam");
  for (const atk of rt.data.attacks) await rtl.info(`${atk.applies ? "Will attack" : "Skip"}: ${atk.name} — ${atk.reason}`);

  await db
    .update(schema.analysisRuns)
    .set({
      ingest: { ...ingest, mapping: map, redTeam: rt.data, rounds: 0 },
      llm: { provider: providerName(), chatIds, models: [mapRes.model, a.model, b.model] },
    })
    .where(eq(schema.analysisRuns.id, runId));
  await enqueueStage("verify", { runId, protocolId });
}
