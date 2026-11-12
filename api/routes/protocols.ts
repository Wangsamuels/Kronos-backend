import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { enqueueStage } from "../../lib/queues.js";
import { conflict, notFound } from "../../lib/errors.js";
import { chainInfo } from "../../lib/chains.js";
import { requireAuth } from "../auth.js";
import { latestRun, ownedProtocol } from "../access.js";
import { CreateProtocol, Id, Page, Protocol, Run } from "../schemas.js";
import { toProtocol, toRun } from "../dto.js";

function deriveName(repoUrl?: string, websiteUrl?: string): string {
  if (repoUrl?.startsWith("sample://")) return repoUrl.slice(9).replace(/^\w/, (c) => c.toUpperCase());
  if (repoUrl) {
    const m = repoUrl.match(/github\.com\/[^/]+\/([^/#?]+)/);
    if (m) return m[1].replace(/\.git$/, "");
  }
  if (websiteUrl) return new URL(websiteUrl).hostname.replace(/^www\./, "");
  return "Untitled protocol";
}

export async function startRun(protocolId: string) {
  const [run] = await db.insert(schema.analysisRuns).values({ protocolId, status: "queued", stage: "queued" }).returning();
  await db.update(schema.protocols).set({ status: "analyzing", updatedAt: new Date() }).where(eq(schema.protocols.id, protocolId));
  await enqueueStage("ingest", { runId: run.id, protocolId });
  return run;
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireAuth);

  app.post(
    "/protocols",
    {
      schema: {
        tags: ["protocols"],
        summary: "Create a draft protocol and start ingest",
        body: CreateProtocol,
        response: { 201: z.object({ protocol: Protocol, analysisId: z.string() }) },
      },
    },
    async (req, reply) => {
      const b = req.body;
      chainInfo(b.chainId); // validates chain
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, req.user!.id));
      const [p] = await db
        .insert(schema.protocols)
        .values({
          ownerId: req.user!.id,
          name: b.name ?? deriveName(b.repoUrl, b.websiteUrl),
          websiteUrl: b.websiteUrl ?? null,
          repoUrl: b.repoUrl ?? null,
          chainId: b.chainId,
          addresses: (b.addresses ?? []).map((a) => a.toLowerCase()),
          githubInstallationId: user?.githubInstallationId ?? null,
        })
        .returning();
      const run = await startRun(p.id);
      return reply.code(201).send({ protocol: toProtocol({ ...p, status: "analyzing" }, run.id), analysisId: run.id });
    },
  );

  app.get(
    "/protocols",
    {
      schema: {
        tags: ["protocols"],
        querystring: Page,
        response: { 200: z.object({ items: z.array(Protocol), nextCursor: z.string().nullable() }) },
      },
    },
    async (req) => {
      const { cursor, limit } = req.query;
      const rows = await db
        .select()
        .from(schema.protocols)
        .where(
          and(eq(schema.protocols.ownerId, req.user!.id), cursor ? lt(schema.protocols.createdAt, new Date(cursor)) : undefined),
        )
        .orderBy(desc(schema.protocols.createdAt))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const runs = page.length
        ? await db
            .select({ id: schema.analysisRuns.id, protocolId: schema.analysisRuns.protocolId, createdAt: schema.analysisRuns.createdAt })
            .from(schema.analysisRuns)
            .where(inArray(schema.analysisRuns.protocolId, page.map((p) => p.id)))
            .orderBy(desc(schema.analysisRuns.createdAt))
        : [];
      const latest = new Map<string, string>();
      for (const r of runs) if (!latest.has(r.protocolId)) latest.set(r.protocolId, r.id);
      return {
        items: page.map((p) => toProtocol(p, latest.get(p.id) ?? null)),
        nextCursor: rows.length > limit ? page[page.length - 1].createdAt.toISOString() : null,
      };
    },
  );

  app.get(
    "/protocols/:id",
    { schema: { tags: ["protocols"], params: Id, response: { 200: Protocol } } },
    async (req) => {
      const p = await ownedProtocol(req.params.id, req.user!.id);
      const r = await latestRun(p.id);
      return toProtocol(p, r?.id ?? null);
    },
  );

  app.post(
    "/protocols/:id/transfer",
    {
      schema: {
        tags: ["protocols"],
        summary: "Transfer a protocol to another Kronos user (owner only), e.g. from a dev/operator account to your GitHub account",
        params: Id,
        body: z.object({ toUserId: z.string().uuid() }),
        response: { 200: Protocol },
      },
    },
    async (req) => {
      const p = await ownedProtocol(req.params.id, req.user!.id);
      const [target] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, req.body.toUserId));
      if (!target) throw notFound("Target user");
      const [u] = await db.update(schema.protocols).set({ ownerId: target.id, updatedAt: new Date() }).where(eq(schema.protocols.id, p.id)).returning();
      const r = await latestRun(p.id);
      return toProtocol(u, r?.id ?? null);
    },
  );

  app.post(
    "/protocols/:id/analyses",
    {
      schema: {
        tags: ["analyses"],
        summary: "Start a new analysis run (also used to re-analyse after code changes)",
        params: Id,
        response: { 201: Run },
      },
    },
    async (req, reply) => {
      const p = await ownedProtocol(req.params.id, req.user!.id);
      const r = await latestRun(p.id);
      if (r && (r.status === "queued" || r.status === "running" || r.status === "packaging")) {
        throw conflict("An analysis is already in progress", { analysisId: r.id });
      }
      const run = await startRun(p.id);
      return reply.code(201).send(toRun(run));
    },
  );
};

export default routes;
