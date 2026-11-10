import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Address } from "viem";
import { db, schema } from "../../db/client.js";
import { conflict, notFound } from "../../lib/errors.js";
import { verifyDeployment, type PackageManifestForVerify } from "../../lib/deployVerify.js";
import { chainInfo } from "../../lib/chains.js";
import { requireAuth } from "../auth.js";
import { latestDeployment, latestRun, ownedProtocol } from "../access.js";
import { AdminAction, CreateDeployment, Deployment, Event, Id, Overview, Page, Settings } from "../schemas.js";
import { toAdminAction, toDeployment, toEvent, toProtocol } from "../dto.js";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireAuth);

  app.post(
    "/protocols/:id/deployments",
    {
      schema: {
        tags: ["deployments"],
        summary: "Register a deployed guard and run on-chain verification; on success the protocol goes live",
        params: Id,
        body: CreateDeployment,
        response: { 201: Deployment },
      },
    },
    async (req, reply) => {
      const p = await ownedProtocol(req.params.id, req.user!.id);
      chainInfo(req.body.chainId);
      const run = await latestRun(p.id);
      const [pkg] = run
        ? await db.select().from(schema.packages).where(eq(schema.packages.runId, run.id)).orderBy(desc(schema.packages.createdAt)).limit(1)
        : [];
      if (!pkg) throw conflict("No approved package yet: approve an analysis first");
      const res = await verifyDeployment(
        req.body.chainId,
        req.body.guardAddress as Address,
        (req.body.timelockAddress as Address | undefined) ?? null,
        pkg.manifest as PackageManifestForVerify,
      );
      const [d] = await db
        .insert(schema.deployments)
        .values({
          protocolId: p.id,
          packageId: pkg.id,
          chainId: req.body.chainId,
          guardAddress: req.body.guardAddress.toLowerCase(),
          timelockAddress: res.timelock?.toLowerCase() ?? null,
          registryAddress: (req.body.registryAddress ?? res.registry)?.toLowerCase() ?? null,
          verified: res.verified,
          checks: res.checks,
          lastBlock: Number(res.block),
          verifiedAt: res.verified ? new Date() : null,
        })
        .returning();
      // Monitor and attestor pick up verified deployments automatically.
      await db
        .update(schema.protocols)
        .set({ status: res.verified ? "live" : "integrating", updatedAt: new Date() })
        .where(eq(schema.protocols.id, p.id));
      return reply.code(201).send(toDeployment(d));
    },
  );

  app.get(
    "/protocols/:id/deployments",
    { schema: { tags: ["deployments"], params: Id, response: { 200: z.array(Deployment) } } },
    async (req) => {
      const p = await ownedProtocol(req.params.id, req.user!.id);
      const rows = await db.select().from(schema.deployments).where(eq(schema.deployments.protocolId, p.id)).orderBy(desc(schema.deployments.createdAt));
      return rows.map(toDeployment);
    },
  );

  app.get(
    "/protocols/:id/overview",
    { schema: { tags: ["dashboard"], summary: "Status, 24h stats, attestation age, queued outflow", params: Id, response: { 200: Overview } } },
    async (req) => {
      const p = await ownedProtocol(req.params.id, req.user!.id);
      const [run, dep] = await Promise.all([latestRun(p.id), latestDeployment(p.id)]);
      const since = new Date(Date.now() - 24 * 3600_000);
      const counts = await db
        .select({ kind: schema.events.kind, n: sql<number>`count(*)::int` })
        .from(schema.events)
        .where(and(eq(schema.events.protocolId, p.id), gte(schema.events.ts, since)))
        .groupBy(schema.events.kind);
      const c = Object.fromEntries(counts.map((r) => [r.kind, r.n])) as Record<string, number>;
      const [att] = await db
        .select()
        .from(schema.attestations)
        .where(eq(schema.attestations.protocolId, p.id))
        .orderBy(desc(schema.attestations.block))
        .limit(1);
      // queued outflow = queued minus released claims, by asset (claim ids tracked in data_json.claimId)
      const queued = await db.execute(sql`
        select q.asset, sum(q.amount)::text as amount, count(*)::int as claims
        from events q
        where q.protocol_id = ${p.id} and q.kind = 'queued'
          and not exists (select 1 from events r where r.protocol_id = q.protocol_id and r.kind = 'released'
                          and r.data_json->>'claimId' = q.data_json->>'claimId')
        group by q.asset`);
      const [{ pending }] = await db
        .select({ pending: sql<number>`count(*)::int` })
        .from(schema.adminActions)
        .where(and(eq(schema.adminActions.protocolId, p.id), eq(schema.adminActions.status, "queued")));
      return {
        protocol: toProtocol(p, run?.id ?? null),
        deployment: dep ? toDeployment(dep) : null,
        stats24h: {
          blocked: c.blocked ?? 0,
          queued: c.queued ?? 0,
          released: c.released ?? 0,
          adminQueued: c.admin_queued ?? 0,
          alerts: c.alert ?? 0,
        },
        attestation: att
          ? {
              block: att.block,
              ageSeconds: Math.round((Date.now() - att.createdAt.getTime()) / 1000),
              oracleOk: att.oracleOk,
              solvencyOk: att.solvencyOk,
              postedTx: att.postedTx,
            }
          : null,
        queuedOutflow: (queued.rows as { asset: string; amount: string; claims: number }[]).map((r) => ({
          asset: r.asset ?? "unknown",
          amount: r.amount ?? "0",
          claims: r.claims,
        })),
        pendingAdminActions: pending,
      };
    },
  );

  app.get(
    "/protocols/:id/events",
    {
      schema: {
        tags: ["dashboard"],
        summary: "Paginated activity feed",
        params: Id,
        querystring: Page.extend({ kind: z.string().optional() }),
        response: { 200: z.object({ items: z.array(Event), nextCursor: z.string().nullable() }) },
      },
    },
    async (req) => {
      const p = await ownedProtocol(req.params.id, req.user!.id);
      const { cursor, limit, kind } = req.query;
      const rows = await db
        .select()
        .from(schema.events)
        .where(
          and(
            eq(schema.events.protocolId, p.id),
            cursor ? lt(schema.events.ts, new Date(cursor)) : undefined,
            kind ? eq(schema.events.kind, kind as never) : undefined,
          ),
        )
        .orderBy(desc(schema.events.ts))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      return { items: page.map(toEvent), nextCursor: rows.length > limit ? page[page.length - 1].ts.toISOString() : null };
    },
  );

  app.get(
    "/protocols/:id/admin-queue",
    {
      schema: {
        tags: ["dashboard"],
        summary: "Timelocked changes with ETA and tier",
        params: Id,
        querystring: z.object({ status: z.enum(["queued", "cancelled", "executed", "all"]).default("queued") }),
        response: { 200: z.array(AdminAction) },
      },
    },
    async (req) => {
      const p = await ownedProtocol(req.params.id, req.user!.id);
      const rows = await db
        .select()
        .from(schema.adminActions)
        .where(and(eq(schema.adminActions.protocolId, p.id), req.query.status === "all" ? undefined : eq(schema.adminActions.status, req.query.status)))
        .orderBy(schema.adminActions.eta);
      return rows.map(toAdminAction);
    },
  );

  app.get("/protocols/:id/settings", { schema: { tags: ["dashboard"], params: Id, response: { 200: Settings } } }, async (req) => {
    const p = await ownedProtocol(req.params.id, req.user!.id);
    return p.settings as z.infer<typeof Settings>;
  });

  app.patch(
    "/protocols/:id/settings",
    {
      schema: {
        tags: ["dashboard"],
        summary:
          "Alert channels and desired outflow thresholds. Loosening a threshold on-chain is a Tier 1 timelock action; the monitor alerts against these values and can only tighten on its own.",
        params: Id,
        body: Settings,
        response: { 200: Settings },
      },
    },
    async (req) => {
      const p = await ownedProtocol(req.params.id, req.user!.id);
      const cur = p.settings as z.infer<typeof Settings>;
      const next = {
        ...cur,
        ...req.body,
        thresholds: { ...(cur.thresholds ?? {}), ...(req.body.thresholds ?? {}) },
        alerts: { ...(cur.alerts ?? {}), ...(req.body.alerts ?? {}) },
      };
      const [u] = await db.update(schema.protocols).set({ settings: next, updatedAt: new Date() }).where(eq(schema.protocols.id, p.id)).returning();
      if (!u) throw notFound("Protocol");
      return u.settings as z.infer<typeof Settings>;
    },
  );
};

export default routes;
