import crypto from "node:crypto";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { env, integrations } from "../../lib/env.js";
import { ApiError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { endSession, issueSession, optionalAuth, requireAuth, rotateSession } from "../auth.js";
import { createNonce, verifyNear, verifySiwe } from "../walletAuth.js";
import { Session, User } from "../schemas.js";

const STATE_COOKIE = "kronos_oauth_state";

const routes: FastifyPluginAsyncZod = async (app) => {
  /** GitHub OAuth start. Afterwards the frontend may send the user to /auth/github/install for the App. */
  app.get("/auth/github", { schema: { tags: ["auth"], summary: "Start GitHub OAuth" } }, async (req, reply) => {
    if (!integrations.githubOAuth) throw new ApiError(501, "NOT_CONFIGURED", "GitHub OAuth is not configured on this server");
    const state = crypto.randomBytes(16).toString("hex");
    reply.setCookie(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production", path: "/v1/auth", maxAge: 600 });
    const redirect = `${env.PUBLIC_API_URL ?? `${req.protocol}://${req.host}`}/v1/auth/github/callback`;
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("scope", "read:user");
    url.searchParams.set("state", state);
    return reply.redirect(url.toString());
  });

  /** GitHub App install redirect (lets the App clone private repos and open the integration PR). */
  app.get("/auth/github/install", { schema: { tags: ["auth"], summary: "Install the Kronos GitHub App" } }, async (_req, reply) => {
    if (!env.GITHUB_APP_SLUG) throw new ApiError(501, "NOT_CONFIGURED", "GitHub App is not configured on this server");
    return reply.redirect(`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`);
  });

  app.get(
    "/auth/github/callback",
    {
      schema: {
        tags: ["auth"],
        summary: "GitHub OAuth / App install callback; redirects to FRONTEND_URL/auth/callback#access_token=…",
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          installation_id: z.coerce.number().optional(),
          setup_action: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { code, state, installation_id } = req.query;
      if (!code) {
        // App installation without OAuth (setup URL): just bounce back to the frontend.
        return reply.redirect(`${env.FRONTEND_URL}/auth/callback#installation_id=${installation_id ?? ""}`);
      }
      if (!state || state !== req.cookies[STATE_COOKIE]) throw badRequest("OAuth state mismatch");
      const tok = (await (
        await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
        })
      ).json()) as { access_token?: string; error?: string };
      if (!tok.access_token) throw badRequest(`GitHub OAuth failed: ${tok.error ?? "no token"}`);
      const gh = (await (
        await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": "kronos" } })
      ).json()) as { id: number; login: string };
      const [user] = await db
        .insert(schema.users)
        .values({ githubId: String(gh.id), githubLogin: gh.login, githubInstallationId: installation_id ?? null })
        .onConflictDoUpdate({
          target: schema.users.githubId,
          set: { githubLogin: gh.login, ...(installation_id ? { githubInstallationId: installation_id } : {}) },
        })
        .returning();
      const s = await issueSession(reply, user.id);
      reply.clearCookie(STATE_COOKIE, { path: "/v1/auth" });
      return reply.redirect(`${env.FRONTEND_URL}/auth/callback#access_token=${s.accessToken}&expires_in=${s.expiresIn}`);
    },
  );

  app.get(
    "/auth/nonce",
    { schema: { tags: ["auth"], summary: "Nonce for SIWE / NEAR sign-in", response: { 200: z.object({ nonce: z.string() }) } } },
    async () => ({ nonce: await createNonce() }),
  );

  app.post(
    "/auth/wallet",
    {
      preHandler: optionalAuth,
      schema: {
        tags: ["auth"],
        summary: "SIWE or NEAR signature. Links the wallet to the signed-in user, or signs in by wallet.",
        body: z.discriminatedUnion("type", [
          z.object({ type: z.literal("siwe"), message: z.string(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
          z.object({
            type: z.literal("near"),
            accountId: z.string(),
            publicKey: z.string(),
            signature: z.string(),
            message: z.string(),
            nonce: z.string(),
            recipient: z.string(),
            callbackUrl: z.string().optional(),
          }),
        ]),
        response: { 200: Session },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const field = b.type === "siwe" ? "walletAddress" : "nearAccount";
      const value = b.type === "siwe" ? await verifySiwe(b.message, b.signature as `0x${string}`) : await verifyNear(b);
      const col = b.type === "siwe" ? schema.users.walletAddress : schema.users.nearAccount;
      const [existing] = await db.select().from(schema.users).where(eq(col, value));
      if (req.user) {
        if (existing && existing.id !== req.user.id) throw conflict("This wallet is linked to another account");
        await db.update(schema.users).set({ [field]: value }).where(eq(schema.users.id, req.user.id));
        return issueSession(reply, req.user.id);
      }
      const user = existing ?? (await db.insert(schema.users).values({ [field]: value }).returning())[0];
      return issueSession(reply, user.id);
    },
  );

  app.post(
    "/auth/refresh",
    { schema: { tags: ["auth"], summary: "Rotate the httpOnly refresh cookie, get a new access token", response: { 200: Session } } },
    async (req, reply) => rotateSession(req, reply),
  );

  app.post("/auth/logout", { schema: { tags: ["auth"], response: { 204: z.null() } } }, async (req, reply) => {
    await endSession(req, reply);
    return reply.code(204).send(null);
  });

  /** Local/judging convenience. Disabled unless ALLOW_DEV_LOGIN=true. */
  app.post(
    "/auth/dev",
    {
      schema: {
        tags: ["auth"],
        summary: "Dev login (only when ALLOW_DEV_LOGIN=true)",
        body: z.object({ login: z.string().min(1).max(39).default("demo") }),
        response: { 200: Session },
      },
    },
    async (req, reply) => {
      if (!env.ALLOW_DEV_LOGIN) throw notFound("Route");
      const githubId = `dev:${req.body.login}`;
      const [user] = await db
        .insert(schema.users)
        .values({ githubId, githubLogin: req.body.login })
        .onConflictDoUpdate({ target: schema.users.githubId, set: { githubLogin: req.body.login } })
        .returning();
      return issueSession(reply, user.id);
    },
  );

  app.get("/me", { preHandler: requireAuth, schema: { tags: ["auth"], response: { 200: User } } }, async (req) => {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, req.user!.id));
    if (!u) throw notFound("User");
    return {
      id: u.id,
      githubLogin: u.githubLogin,
      walletAddress: u.walletAddress,
      nearAccount: u.nearAccount,
      githubAppInstalled: Boolean(u.githubInstallationId),
      createdAt: u.createdAt.toISOString(),
    };
  });
};

export default routes;
