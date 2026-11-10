import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { forbidden, notFound } from "../lib/errors.js";

export async function ownedProtocol(protocolId: string, userId: string) {
  const [p] = await db.select().from(schema.protocols).where(eq(schema.protocols.id, protocolId));
  if (!p) throw notFound("Protocol");
  if (p.ownerId !== userId) throw forbidden();
  return p;
}

export async function ownedRun(runId: string, userId: string) {
  const [row] = await db
    .select({ run: schema.analysisRuns, protocol: schema.protocols })
    .from(schema.analysisRuns)
    .innerJoin(schema.protocols, eq(schema.protocols.id, schema.analysisRuns.protocolId))
    .where(eq(schema.analysisRuns.id, runId));
  if (!row) throw notFound("Analysis");
  if (row.protocol.ownerId !== userId) throw forbidden();
  return row;
}

export async function latestRun(protocolId: string) {
  const [r] = await db
    .select()
    .from(schema.analysisRuns)
    .where(eq(schema.analysisRuns.protocolId, protocolId))
    .orderBy(desc(schema.analysisRuns.createdAt))
    .limit(1);
  return r ?? null;
}

export async function latestDeployment(protocolId: string) {
  const [d] = await db
    .select()
    .from(schema.deployments)
    .where(and(eq(schema.deployments.protocolId, protocolId)))
    .orderBy(desc(schema.deployments.createdAt))
    .limit(1);
  return d ?? null;
}

/** Review edits are only allowed while the run is in review. */
export function assertReviewable(status: string) {
  if (status !== "review") throw forbidden(`Run is ${status}; review edits are only allowed during review`);
}
