import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { conflict, notFound } from "../../lib/errors.js";
import { enqueueStage } from "../../lib/queues.js";
import { emit } from "../../lib/events.js";
import { requireAuth } from "../auth.js";
import { assertReviewable, ownedRun } from "../access.js";
import { streamRun } from "../sse.js";
import { Id, IntentSchema, Invariant, PatchIntentSchema, PatchInvariant, PatchTier, Results, Run, Tier } from "../schemas.js";
import { toEntrypoint, toIntentSchema, toInvariant, toRun, toTestReport, toTier } from "../dto.js";

const RESTING = new Set(["review", "failed", "packaged"]);
const TIER_DELAYS = [0, 48 * 3600, 7 * 86400, 14 * 86400];

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireAuth);

  app.get("/analyses/:id", { schema: { tags: ["analyses"], params: Id, response: { 200: Run } } }, async (req) => {
    const { run } = await ownedRun(req.params.id, req.user!.id);
    return toRun(run);
  });

  app.get(
    "/analyses/:id/stream",
    {
      schema: {
        tags: ["analyses"],
        summary: "SSE live log: events stage, log, entrypoint, invariant, done, error. Auth via ?token= (EventSource can't send headers)",
        params: Id,
        querystring: z.object({ token: z.string().optional(), lastEventId: z.coerce.number().optional() }),
      },
    },
    async (req, reply) => {
      const { run } = await ownedRun(req.params.id, req.user!.id);
      await streamRun(req, reply, run.id, RESTING.has(run.status));
    },
  );

  app.get("/analyses/:id/results", { schema: { tags: ["analyses"], params: Id, response: { 200: Results } } }, async (req) => {
    const { run } = await ownedRun(req.params.id, req.user!.id);
    const [eps, schemas, invs, trs, reports] = await Promise.all([
      db.select().from(schema.entrypoints).where(eq(schema.entrypoints.runId, run.id)).orderBy(asc(schema.entrypoints.contract)),
      db.select().from(schema.intentSchemas).where(eq(schema.intentSchemas.runId, run.id)),
      db.select().from(schema.invariants).where(eq(schema.invariants.runId, run.id)),
      db.select().from(schema.tiers).where(eq(schema.tiers.runId, run.id)),
      db.select().from(schema.testReports).where(eq(schema.testReports.runId, run.id)),
    ]);
    return {
      run: toRun(run),
      entrypoints: eps.map(toEntrypoint),
      intentSchemas: schemas.map(toIntentSchema),
      invariants: invs.map(toInvariant),
      tiers: trs.map(toTier),
      thresholds: run.thresholds ?? null,
      testReport: reports[0] ? toTestReport(reports[0]) : null,
    };
  });

  // ---------------------------------------------------------------- review edits

  app.patch(
    "/invariants/:id",
    { schema: { tags: ["review"], summary: "Approve, reject or edit params", params: Id, body: PatchInvariant, response: { 200: Invariant } } },
    async (req) => {
      const [inv] = await db.select().from(schema.invariants).where(eq(schema.invariants.id, req.params.id));
      if (!inv) throw notFound("Invariant");
      const { run } = await ownedRun(inv.runId, req.user!.id);
      assertReviewable(run.status);
      const evidence = { ...(inv.evidence as object), ...(req.body.params ? { editedBy: req.user!.id, previousParams: inv.params } : {}) };
      const [u] = await db
        .update(schema.invariants)
        .set({
          ...(req.body.status ? { status: req.body.status } : {}),
          ...(req.body.params ? { params: { ...(inv.params as object), ...req.body.params }, evidence } : {}),
        })
        .where(eq(schema.invariants.id, inv.id))
        .returning();
      await emit(run.id, "log", "review", `Invariant "${u.title}" ${req.body.status ?? "edited"}`, { invariantId: u.id });
      return toInvariant(u);
    },
  );

  app.patch(
    "/intent-schemas/:id",
    { schema: { tags: ["review"], params: Id, body: PatchIntentSchema, response: { 200: IntentSchema } } },
    async (req) => {
      const [s] = await db.select().from(schema.intentSchemas).where(eq(schema.intentSchemas.id, req.params.id));
      if (!s) throw notFound("Intent schema");
      const { run } = await ownedRun(s.runId, req.user!.id);
      assertReviewable(run.status);
      const [u] = await db
        .update(schema.intentSchemas)
        .set({
          ...(req.body.status ? { status: req.body.status } : {}),
          ...(req.body.bounds ? { bounds: { ...(s.bounds as object), ...req.body.bounds } } : {}),
        })
        .where(eq(schema.intentSchemas.id, s.id))
        .returning();
      return toIntentSchema(u);
    },
  );

  app.patch(
    "/tiers/:id",
    {
      schema: {
        tags: ["review"],
        summary: "Approve/reject or change a tier. Hard rules can only be made stricter.",
        params: Id,
        body: PatchTier,
        response: { 200: Tier },
      },
    },
    async (req) => {
      const [t] = await db.select().from(schema.tiers).where(eq(schema.tiers.id, req.params.id));
      if (!t) throw notFound("Tier");
      const { run } = await ownedRun(t.runId, req.user!.id);
      assertReviewable(run.status);
      if (req.body.tier !== undefined && t.source === "rule" && req.body.tier < t.tier) {
        throw conflict(`Tier ${t.tier} is a hard rule (${t.rationale}); it can only be raised`);
      }
      const [u] = await db
        .update(schema.tiers)
        .set({
          ...(req.body.status ? { status: req.body.status } : {}),
          ...(req.body.tier !== undefined ? { tier: req.body.tier, delaySeconds: TIER_DELAYS[req.body.tier] } : {}),
        })
        .where(eq(schema.tiers.id, t.id))
        .returning();
      return toTier(u);
    },
  );

  app.post(
    "/analyses/:id/approve",
    {
      schema: {
        tags: ["review"],
        summary: "Lock the review and build the package. Items flagged needsReview must be decided first.",
        params: Id,
        response: { 202: Run },
      },
    },
    async (req, reply) => {
      const { run, protocol } = await ownedRun(req.params.id, req.user!.id);
      assertReviewable(run.status);
      const invs = await db.select().from(schema.invariants).where(eq(schema.invariants.runId, run.id));
      const undecided = invs.filter((i) => i.needsReview && i.status === "proposed");
      if (undecided.length) {
        throw conflict("Some invariants need an explicit decision (drafters disagreed)", { invariantIds: undecided.map((i) => i.id) });
      }
      // Everything else still "proposed" is accepted as drafted.
      await db
        .update(schema.invariants)
        .set({ status: "approved" })
        .where(and(eq(schema.invariants.runId, run.id), eq(schema.invariants.status, "proposed")));
      await db
        .update(schema.intentSchemas)
        .set({ status: "approved" })
        .where(and(eq(schema.intentSchemas.runId, run.id), eq(schema.intentSchemas.status, "proposed")));
      await db.update(schema.tiers).set({ status: "approved" }).where(and(eq(schema.tiers.runId, run.id), eq(schema.tiers.status, "proposed")));
      const approved = await db
        .select({ id: schema.invariants.id })
        .from(schema.invariants)
        .where(and(eq(schema.invariants.runId, run.id), eq(schema.invariants.status, "approved")));
      if (approved.length === 0) throw conflict("At least one invariant must be approved");

      const [u] = await db
        .update(schema.analysisRuns)
        .set({ status: "approved", stage: "package" })
        .where(and(eq(schema.analysisRuns.id, run.id), eq(schema.analysisRuns.status, "review")))
        .returning();
      if (!u) throw conflict("Run already approved");
      await db.update(schema.protocols).set({ status: "approved", updatedAt: new Date() }).where(eq(schema.protocols.id, protocol.id));
      await emit(run.id, "stage", "review", "Review approved by the protocol team; building package");
      await enqueueStage("package", { runId: run.id, protocolId: protocol.id }, String(Date.now())); // unique: approving again after a failed build must enqueue a new job
      return reply.code(202).send(toRun(u));
    },
  );
};

export default routes;
