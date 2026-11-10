import path from "node:path";
import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { env } from "../../lib/env.js";
import { runLogger } from "../../lib/events.js";
import { enqueueStage, type StageJob } from "../../lib/queues.js";
import { putObject } from "../../lib/storage.js";
import { run, which } from "../util/exec.js";
import { ensureDir, runDir } from "../util/paths.js";
import { fetchSources } from "../source.js";
import { buildModel, concreteContracts } from "../ast.js";
import { classify } from "../agents/agents.js";
import { failRun, loadRun, setStage, projectPath, type IngestData } from "../context.js";

/**
 * Stage 1 — Ingest (deterministic): fetch sources and ABIs, snapshot them, compile to a solc AST,
 * run Slither when available, classify the protocol. Non-lending stops with "coming soon".
 */
export async function ingest(job: StageJob) {
  const { runId, protocolId } = job;
  const { protocol } = await loadRun(runId);
  const log = runLogger(runId, "ingest");
  await db.update(schema.analysisRuns).set({ status: "running", startedAt: new Date() }).where(eq(schema.analysisRuns.id, runId));
  await setStage(runId, "ingest", "Ingest: fetching sources");

  const ws = await ensureDir(runDir(runId));
  let bundle;
  try {
    bundle = await fetchSources(
      ws,
      {
        repoUrl: protocol.repoUrl,
        addresses: protocol.addresses,
        chainId: protocol.chainId,
        websiteUrl: protocol.websiteUrl,
        githubInstallationId: protocol.githubInstallationId,
      },
      log,
    );
  } catch (e) {
    return failRun(runId, protocolId, "INGEST_FAILED", (e as Error).message);
  }

  // Snapshot (only the Solidity tree) to object storage.
  const snapDir = await ensureDir(path.join(ws, "snapshot"));
  for (const f of bundle.files) {
    const dst = path.join(snapDir, projectPath(f, bundle.foundryProject));
    await ensureDir(path.dirname(dst));
    await fs.copyFile(path.join(bundle.root, f), dst);
  }
  const tgz = path.join(ws, "snapshot.tgz");
  await run("tar", ["-czf", tgz, "-C", snapDir, "."]);
  const snap = await putObject(`snapshots/${runId}.tgz`, await fs.readFile(tgz), "application/gzip");
  await log.info(`Source snapshot stored (${(snap.bytes / 1024).toFixed(1)} KB, sha256 ${snap.sha256.slice(0, 12)})`);

  await log.info("Compiling with forge to extract the AST (call graph, state variables, modifiers)");
  const model = await buildModel(bundle.root, bundle.files, bundle.foundryProject, ws);
  if (model.astSource === "regex") await log.warn("Sources did not compile in isolation; using the regex fallback parser", { errors: model.compileErrors?.slice(-800) });
  else await log.info(`AST: ${model.contracts.length} contracts (solc ${model.compiler ?? "?"}), ${concreteContracts(model).map((c) => c.name).join(", ")} deployable`);

  let slither: IngestData["slither"] = { ran: false };
  if (await which(env.SLITHER_BIN)) {
    await log.info("Running Slither");
    const target = bundle.foundryProject ? bundle.root : path.join(ws, "ast");
    const r = await run(env.SLITHER_BIN, [".", "--json", "-", "--exclude-informational", "--exclude-optimization"], { cwd: target, timeoutMs: 300_000 });
    try {
      const out = JSON.parse(r.stdout) as { results?: { detectors?: { impact: string }[] } };
      const counts: Record<string, number> = {};
      for (const d of out.results?.detectors ?? []) counts[d.impact] = (counts[d.impact] ?? 0) + 1;
      slither = { ran: true, detectors: counts };
      await log.info(`Slither: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "no findings"}`);
    } catch {
      slither = { ran: false, error: r.stderr.slice(-500) };
      await log.warn("Slither did not produce JSON output; continuing without it");
    }
  } else {
    await log.debug("Slither not installed on this dyno; skipping");
  }

  const cls = await classify(runId, model);
  await log.info(`Classified as ${cls.data.type} (${Math.round(cls.data.confidence * 100)}%): ${cls.data.reasons.join("; ")}`, { provider: cls.provider });

  const { root: _root, ...src } = bundle;
  const ingestData: IngestData = {
    source: { ...src, snapshotKey: snap.key },
    classification: { ...cls.data, provider: cls.provider },
    model,
    slither,
  };
  await db
    .update(schema.analysisRuns)
    .set({ ingest: ingestData, commitSha: bundle.commitSha, snapshotKey: snap.key })
    .where(eq(schema.analysisRuns.id, runId));

  if (cls.data.type !== "lending") {
    await db.update(schema.protocols).set({ type: cls.data.type }).where(eq(schema.protocols.id, protocolId));
    return failRun(runId, protocolId, "UNSUPPORTED_TYPE", "Bridges and other types coming soon. Join the waitlist to hear first.", "unsupported");
  }
  await enqueueStage("analyze", { runId, protocolId });
}
