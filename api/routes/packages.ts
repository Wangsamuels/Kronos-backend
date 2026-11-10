import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { downloadUrl, getObject } from "../../lib/storage.js";
import { openIntegrationPr, parseRepoUrl } from "../../lib/github.js";
import { integrations } from "../../lib/env.js";
import { requireAuth } from "../auth.js";
import { ownedRun } from "../access.js";
import { Id, Package } from "../schemas.js";

async function ownedPackage(id: string, userId: string) {
  const [pkg] = await db.select().from(schema.packages).where(eq(schema.packages.id, id));
  if (!pkg) throw notFound("Package");
  const { run, protocol } = await ownedRun(pkg.runId, userId);
  return { pkg, run, protocol };
}

async function toPackage(pkg: typeof schema.packages.$inferSelect) {
  return {
    id: pkg.id,
    runId: pkg.runId,
    version: pkg.version,
    configHash: pkg.configHash,
    manifest: pkg.manifest,
    downloadUrl: await downloadUrl(pkg.r2Key, `/v1/packages/${pkg.id}/download`),
    prUrl: pkg.prUrl,
    createdAt: pkg.createdAt.toISOString(),
  };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireAuth);

  app.get(
    "/packages/:id",
    { schema: { tags: ["packages"], summary: "Manifest, diff preview and a download URL", params: Id, response: { 200: Package } } },
    async (req) => toPackage((await ownedPackage(req.params.id, req.user!.id)).pkg),
  );

  app.get(
    "/analyses/:id/package",
    { schema: { tags: ["packages"], summary: "The package built from this run, if any", params: Id, response: { 200: Package } } },
    async (req) => {
      const { run } = await ownedRun(req.params.id, req.user!.id);
      const [pkg] = await db.select().from(schema.packages).where(eq(schema.packages.runId, run.id)).orderBy(desc(schema.packages.createdAt)).limit(1);
      if (!pkg) throw notFound("Package");
      return toPackage(pkg);
    },
  );

  app.get(
    "/packages/:id/download",
    {
      schema: {
        tags: ["packages"],
        summary: "Zip download (contracts, config, tests, SDK snippet, INTEGRATION.md). Auth via header or ?token=",
        params: Id,
        querystring: z.object({ token: z.string().optional() }),
      },
    },
    async (req, reply) => {
      const { pkg, protocol } = await ownedPackage(req.params.id, req.user!.id);
      const buf = await getObject(pkg.r2Key);
      const name = `kronos-${protocol.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}-${pkg.version}.zip`;
      return reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="${name}"`).send(buf);
    },
  );

  app.post(
    "/packages/:id/pull-request",
    {
      schema: {
        tags: ["packages"],
        summary: "Open the integration PR through the Kronos GitHub App and return its URL",
        params: Id,
        response: { 200: z.object({ prUrl: z.string() }) },
      },
    },
    async (req) => {
      const { pkg, protocol } = await ownedPackage(req.params.id, req.user!.id);
      if (pkg.prUrl) return { prUrl: pkg.prUrl };
      const ref = protocol.repoUrl ? parseRepoUrl(protocol.repoUrl) : null;
      if (!ref) throw new ApiError(422, "NO_GITHUB_REPO", "This protocol has no GitHub repository; use the zip download");
      if (!integrations.githubApp) {
        throw new ApiError(501, "GITHUB_APP_NOT_CONFIGURED", "GitHub App credentials are not set on this server; use the zip download");
      }
      const manifest = pkg.manifest as { prFiles: { path: string; key: string }[]; prBody: string; prTitle: string };
      const files = await Promise.all(manifest.prFiles.map(async (f) => ({ path: f.path, content: (await getObject(f.key)).toString("utf8") })));
      try {
        const prUrl = await openIntegrationPr(ref, protocol.githubInstallationId, pkg.version, files, manifest.prTitle, manifest.prBody);
        await db.update(schema.packages).set({ prUrl }).where(eq(schema.packages.id, pkg.id));
        await db.update(schema.protocols).set({ status: "integrating", updatedAt: new Date() }).where(eq(schema.protocols.id, protocol.id));
        return { prUrl };
      } catch (e) {
        throw new ApiError(502, "GITHUB_ERROR", (e as Error).message);
      }
    },
  );
};

export default routes;
