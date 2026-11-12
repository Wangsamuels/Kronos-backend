import path from "node:path";
import { eq } from "drizzle-orm";
import { parseAbi, type Address } from "viem";
import { db, schema } from "../../db/client.js";
import { emit, runLogger } from "../../lib/events.js";
import { type StageJob } from "../../lib/queues.js";
import { publicClient } from "../../lib/chains.js";
import { teeEvidence } from "../../lib/llm.js";
import { ensureSources, loadRun, setStage, type IngestData } from "../context.js";
import { runDir } from "../util/paths.js";
import { buildGuard, protocolFiles } from "../build.js";
import { buildWorkspace, compile, runTests, summarize, type AttackResult } from "../verifier.js";
import { computeThresholds, forkReplay } from "../history.js";
import { draftInvariants, mapHeuristic, mergeDrafts } from "../agents/agents.js";
import { saveInvariants } from "./analyze.js";
import type { InvariantDecision } from "../templates/generate.js";

const MAX_ROUNDS = 2;

async function baseAssetOf(chainId: number, addresses: string[]): Promise<{ asset: Address | null; decimals: number }> {
  for (const a of addresses) {
    try {
      const c = publicClient(chainId);
      const asset = (await c.readContract({ address: a as Address, abi: parseAbi(["function base() view returns (address)"]), functionName: "base" })) as Address;
      const decimals = Number(await c.readContract({ address: asset, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" }));
      return { asset, decimals };
    } catch {
      /* try next */
    }
  }
  return { asset: null, decimals: 6 };
}

/**
 * Stage 3 — Verifier (deterministic): compile the generated guard, replay the attack library and normal
 * traffic on Foundry/anvil, set outflow thresholds from history. A successful exploit sends the gap back
 * to the drafters for up to 2 rounds. Then the run waits for human review.
 */
export async function verify(job: StageJob) {
  const { runId, protocolId } = job;
  const { run, protocol } = await loadRun(runId);
  const ingest = run.ingest as IngestData;
  const log = runLogger(runId, "verify");
  await setStage(runId, "verify", "Verifier: compiling the guard and replaying attacks on a fork");

  const { asset, decimals } = await baseAssetOf(protocol.chainId, protocol.addresses);
  const thresholds = await computeThresholds(protocol.chainId, protocol.addresses, asset, decimals, log);
  await log.info(`Outflow window: 24h net; threshold ${thresholds.assets.map((t) => t.threshold).join(", ")} (${thresholds.source})`);

  const snapshot = await ensureSources(runId, ingest);
  const srcFiles = await protocolFiles(snapshot);
  const applies = Object.fromEntries(((ingest.redTeam as { attacks?: { id: string; applies: boolean }[] })?.attacks ?? []).map((a) => [a.id, a.applies]));

  let round = ingest.rounds ?? 0;
  let summary: ReturnType<typeof summarize> | null = null;
  let compileLog = "";
  let generatedOk = false;
  let note: string | undefined;
  let gas: unknown = {};
  for (;;) {
    const invs = await db.select().from(schema.invariants).where(eq(schema.invariants.runId, runId));
    const decisions: InvariantDecision[] = invs.map((i) => ({ template: i.template, params: i.params as Record<string, unknown>, status: i.status }));
    const g = buildGuard(ingest, decisions);
    if (!g.files.length) {
      note = g.reason;
      await log.warn(g.reason ?? "no adapter");
      break;
    }
    if (!g.ok) await log.warn(g.reason ?? "unresolved generator slots");
    const dir = path.join(runDir(runId), "guard");
    await buildWorkspace({ dir, protocolFiles: srcFiles, generated: g.files, tests: g.tests });
    await log.info(`Generated GuardConfig.${g.name}.sol and Guarded${g.name}.sol (config hash ${g.configHash.slice(0, 10)}…); compiling`);
    const c = await compile(dir);
    compileLog = c.log;
    if (!c.ok) {
      await log.warn("Generated guard does not compile", { log: c.log.slice(-1500) });
      // The compiler decides: if the agent's mapping produced code that doesn't compile, retry once with
      // the deterministic AST mapping before giving up.
      if (ingest.mappingSource && !ingest.mappingSource.startsWith("heuristic")) {
        ingest.mapping = mapHeuristic(ingest.model);
        ingest.mappingSource = "heuristic (agent mapping did not compile)";
        await db.update(schema.analysisRuns).set({ ingest }).where(eq(schema.analysisRuns.id, runId));
        await log.warn("Retrying with the deterministic AST mapping");
        continue;
      }
      note = "Generated guard failed to compile; see details";
      break;
    }
    generatedOk = true;
    await log.info("Compiled. Running normal-traffic and attack replays (forge)");
    const t = await runTests(dir);
    if (!t.ok) {
      note = "forge test produced no parseable output";
      await log.warn(note, { raw: t.raw?.slice(-1000) });
      break;
    }
    summary = summarize(t.tests, t.logs, applies);
    gas = summary.gas;
    for (const atk of summary.attacks) {
      const base = atk.baselineExploitWorks === null ? "" : atk.baselineExploitWorks ? " (drains the unguarded protocol)" : " (baseline exploit did not reproduce)";
      await emit(runId, "log", "verify", `${atk.blocked ? "BLOCKED" : "NOT BLOCKED"}: ${atk.name}${base}`, atk, atk.blocked ? "info" : "warn");
    }
    const normalPass = summary.normal.filter((n) => n.passed).length;
    await log.info(`Normal traffic: ${normalPass}/${summary.normal.length} flows pass`);
    const gaps = summary.attacks.filter((a: AttackResult) => a.applies && !a.blocked).map((a) => a.targetInvariant);
    if (gaps.length && round < MAX_ROUNDS) {
      round++;
      await setStage(runId, "invariants", `Red team found gaps in ${gaps.join(", ")}: sending back to the drafters (round ${round}/${MAX_ROUNDS})`);
      const [a, b] = await Promise.all([
        draftInvariants(runId, "A", ingest.model, ingest.mapping!, protocol.chainId, gaps),
        draftInvariants(runId, "B", ingest.model, ingest.mapping!, protocol.chainId, gaps),
      ]);
      const rows = await saveInvariants(runId, mergeDrafts(a.data.invariants, b.data.invariants), round);
      for (const i of rows) await emit(runId, "invariant", "invariants", `${i.title} (round ${round})`, { id: i.id, template: i.template, params: i.params, needsReview: i.needsReview });
      await setStage(runId, "verify", `Re-verifying after round ${round}`);
      continue;
    }
    break;
  }

  const replay = await forkReplay(protocol.chainId, protocol.addresses, log).catch(() => null);
  const normalForge = summary?.normal ?? [];
  const attacks = (summary?.attacks ?? []).filter((a) => a.applies);
  await db.delete(schema.testReports).where(eq(schema.testReports.runId, runId));
  await db.insert(schema.testReports).values({
    runId,
    normalTxCount: normalForge.length + (replay?.total ?? 0),
    normalPass: normalForge.filter((n) => n.passed).length + (replay?.pass ?? 0),
    attacksTotal: attacks.length,
    attacksBlocked: attacks.filter((a) => a.blocked).length,
    gas: gas as object,
    details: {
      generated: generatedOk,
      note: note ?? null,
      compileLog: generatedOk ? null : compileLog.slice(-3000),
      attacks: summary?.attacks ?? [],
      normal: normalForge,
      forkReplay: replay,
      rounds: round,
      slither: ingest.slither ?? null,
    },
  });

  const tee = await teeEvidence(((run.llm as { chatIds?: string[] } | null)?.chatIds ?? []).slice(0, 3)).catch((e) => ({ error: String(e) }));
  await db
    .update(schema.analysisRuns)
    .set({
      status: "review",
      stage: "review",
      thresholds,
      ingest: { ...ingest, rounds: round },
      llm: { ...((run.llm as object) ?? {}), tee },
      finishedAt: new Date(),
    })
    .where(eq(schema.analysisRuns.id, runId));
  await db.update(schema.protocols).set({ status: "review", updatedAt: new Date() }).where(eq(schema.protocols.id, protocolId));
  const blocked = attacks.filter((a) => a.blocked).length;
  await emit(runId, "done", "review", `Analysis complete: ${blocked}/${attacks.length} attacks blocked, ${normalForge.filter((n) => n.passed).length}/${normalForge.length} normal flows pass. Ready for review.`, {
    attacksBlocked: blocked,
    attacksTotal: attacks.length,
    note: note ?? null,
  });
}
