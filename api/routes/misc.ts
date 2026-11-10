import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { redis } from "../../lib/redis.js";
import { queueHealth } from "../../lib/queues.js";
import { env, integrations } from "../../lib/env.js";
import { CHAINS } from "../../lib/chains.js";
import { Waitlist } from "../schemas.js";

/** Unversioned health check + versioned public metadata and waitlist. */
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/healthz", { schema: { tags: ["meta"], summary: "DB, Redis and queue status" } }, async (_req, reply) => {
    const out: Record<string, unknown> = { ok: true };
    try {
      await db.execute(sql`select 1`);
      out.db = "ok";
    } catch (e) {
      out.ok = false;
      out.db = String(e);
    }
    try {
      out.redis = await redis().ping();
      out.queues = await queueHealth();
    } catch (e) {
      out.ok = false;
      out.redis = String(e);
    }
    return reply.code(out.ok ? 200 : 503).send(out);
  });
};

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/meta",
    {
      schema: {
        tags: ["meta"],
        summary: "Supported chains and which integrations are live vs local fallback",
        response: {
          200: z.object({
            version: z.string(),
            chains: z.array(z.object({ chainId: z.number(), name: z.string() })),
            integrations: z.record(z.union([z.string(), z.boolean()])),
            devLogin: z.boolean(),
            protocolTypes: z.array(z.object({ type: z.string(), available: z.boolean() })),
          }),
        },
      },
    },
    async () => ({
      version: "0.1.0",
      chains: Object.entries(CHAINS).map(([id, c]) => ({ chainId: Number(id), name: c.chain.name })),
      integrations,
      devLogin: env.ALLOW_DEV_LOGIN,
      protocolTypes: [
        { type: "lending", available: true },
        { type: "bridge", available: false },
        { type: "dex", available: false },
      ],
    }),
  );

  app.post(
    "/waitlist",
    {
      schema: { tags: ["meta"], summary: "Join the waitlist for bridges and other protocol types", body: Waitlist, response: { 201: z.object({ ok: z.literal(true) }) } },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      await db.insert(schema.waitlist).values(req.body);
      return reply.code(201).send({ ok: true as const });
    },
  );
};

export default routes;
