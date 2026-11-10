import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { emit } from "../lib/events.js";
import { getObject } from "../lib/storage.js";
import { run } from "./util/exec.js";
import { ensureDir, runDir } from "./util/paths.js";
import type { ProtocolModel } from "./ast.js";
import type { MapperOutput } from "./agents/types.js";
import type { SourceBundle } from "./source.js";

export interface IngestData {
  source: Omit<SourceBundle, "root"> & { snapshotKey: string };
  classification: { type: string; confidence: number; reasons: string[]; provider: string };
  model: ProtocolModel;
  slither?: { ran: boolean; detectors?: Record<string, number>; error?: string };
  mapping?: MapperOutput;
  redTeam?: unknown;
  rounds?: number;
}

export async function loadRun(runId: string) {
  const [row] = await db
    .select({ run: schema.analysisRuns, protocol: schema.protocols })
    .from(schema.analysisRuns)
    .innerJoin(schema.protocols, eq(schema.protocols.id, schema.analysisRuns.protocolId))
    .where(eq(schema.analysisRuns.id, runId));
  if (!row) throw new Error(`run ${runId} not found`);
  return row;
}

export async function setStage(runId: string, stage: string, message: string, extra: Partial<typeof schema.analysisRuns.$inferInsert> = {}) {
  await db.update(schema.analysisRuns).set({ stage, ...extra }).where(eq(schema.analysisRuns.id, runId));
  await emit(runId, "stage", stage, message);
}

export async function failRun(runId: string, protocolId: string, code: string, message: string, protocolStatus: "draft" | "unsupported" = "draft") {
  await db
    .update(schema.analysisRuns)
    .set({ status: "failed", error: { code, message }, finishedAt: new Date() })
    .where(eq(schema.analysisRuns.id, runId));
  await db.update(schema.protocols).set({ status: protocolStatus, updatedAt: new Date() }).where(eq(schema.protocols.id, protocolId));
  await emit(runId, "error", "failed", message, { code });
}

/** Restores the source snapshot into the run workspace if this dyno doesn't have it (restart, other dyno). */
export async function ensureSources(runId: string, ingest: IngestData): Promise<string> {
  const dir = path.join(runDir(runId), "snapshot");
  try {
    await fs.access(dir);
    return dir;
  } catch {
    await ensureDir(dir);
    const tgz = path.join(runDir(runId), "snapshot.tgz");
    await fs.writeFile(tgz, await getObject(ingest.source.snapshotKey));
    const r = await run("tar", ["-xzf", tgz, "-C", dir]);
    if (r.code !== 0) throw new Error(`snapshot restore failed: ${r.stderr}`);
    return dir;
  }
}

/** Project-relative path a source file gets in AST builds and verify workspaces. */
export function projectPath(file: string, foundryProject: boolean) {
  return foundryProject || file.startsWith("src/") ? file : `src/${file}`;
}
