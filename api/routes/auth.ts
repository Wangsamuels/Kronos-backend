import crypto from "node:crypto";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { env, integrations } from "../../lib/env.js";
import { SUPPORTED_CHAIN_IDS } from "../../lib/chains.js";
import { ApiError, conflict, notFound } from "../../lib/errors.js";
import { endSession, issueSession, optionalAuth, requireAuth, rotateSession, verifyAccessToken } from "../auth.js";
import { createNonce, verifyNear, verifySiwe } from "../walletAuth.js";
import { Providers, Session, User } from "../schemas.js";

/**
 * Sign-in / sign-up. There is no separate sign-up: the first successful sign-in with any method creates
 * the account, and the session response says so (`isNewUser`). The frontend shows one modal for both.
 *
 *  GitHub : GET /v1/auth/github?returnTo=/path  ->  GitHub  ->  /v1/auth/github/callback
 *           -> FRONTEND_URL/auth/callback#access_token=…&expires_in=…&new_user=0|1&return_to=/path
 *  EVM    : GET /v1/auth/nonce -> wallet signs SIWE -> POST /v1/auth/wallet {type:"siwe"}
 *  NEAR   : GET /v1/auth/nonce -> wallet signMessage (NEP-413) -> POST /v1/auth/wallet {type:"near"}
 *  Linking: a signed-in user adds a wallet by calling /auth/wallet with their bearer token, or adds
 *           GitHub with /auth/github?linkToken=<access token>.
 */
const STATE_COOKIE = "kronos_oauth_state";
const SIWE_STATEMENT = "Sign in to Kronos. This request will not trigger a blockchain transaction or cost any gas.";
const NEAR_MESSAGE = "Sign in to Kronos";

interface OAuthState {
  s: string; // CSRF value
  r: string; // returnTo (validated relative path)
  l?: string; // user id to link GitHub to
}

/** Only same-site relative paths, so the callback can never become an open redirect. */
function safeReturnTo(v: unknown): string {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || v.includes("\\") || v.length > 300) return "/";
  return v;
}

function frontendCallback(params: Record<string, string>) {
  return `${env.FRONTEND_URL}/auth/callback#${new URLSearchParams(params).toString()}`;
}

function apiBase(req: { protocol: string; host: string }) {
  return (env.PUBLIC_API_URL ?? `${req.protocol}://${req.host}`).replace(/\/$/, "");
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/auth/providers",
    {
      schema: {
        tags: ["auth"],
        summary: "Sign-in options for the sign-in / sign-up modal, with the exact values wallets must sign",
        response: { 200: Providers },
      },
    },
    async (req) => ({
      github: {
        enabled: integrations.githubOAuth,
        startUrl: `${apiBase(req)}/v1/auth/github`,
        appInstallUrl: env.GITHUB_APP_SLUG ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new` : null,
      },
      siwe: {
        enabled: true,
        domain: new URL(env.FRONTEND_URL).host,
        uri: env.FRONTEND_URL,
        chainIds: SUPPORTED_CHAIN_IDS,
        statement: SIWE_STATEMENT,
      },
      near: { enabled: true, network: env.NEAR_NETWORK, recipient: env.NEAR_SIGNIN_RECIPIENT!, message: NEAR_MESSAGE },
      dev: { enabled: env.ALLOW_DEV_LOGIN },
    }),
  );

  async function startState(reply: import("fastify").FastifyReply, returnTo?: string, linkToken?: string) {
    const state: OAuthState = { s: crypto.randomBytes(16).toString("hex"), r: safeReturnTo(returnTo) };
    if (linkToken) state.l = (await verifyAccessToken(linkToken)).id;
    reply.setCookie(STATE_COOKIE, Buffer.from(JSON.stringify(state)).toString("base64url"), {
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      path: env.COOKIE_PATH,
      maxAge: 600,
    });
    return state;
  }

  const startQuery = z.object({ returnTo: z.string().optional(), linkToken: z.string().optional() });

  /** GitHub OAuth start. Full-page navigation from the modal's "Continue with GitHub" button. */
  app.get(
    "/auth/github",
    {
      schema: {
        tags: ["auth"],
        summary: "Start GitHub sign-in / sign-up. returnTo = frontend path to land on afterwards; linkToken = add GitHub to a signed-in account",
        querystring: startQuery,
      },
    },
    async (req, reply) => {
      if (!integrations.githubOAuth) throw new ApiError(501, "NOT_CONFIGURED", "GitHub sign-in is not configured on this server");
      const state = await startState(reply, req.query.returnTo, req.query.linkToken);
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
      url.searchParams.set("redirect_uri", `${apiBase(req)}/v1/auth/github/callback`);
      url.searchParams.set("scope", "read:user");
      url.searchParams.set("state", state.s);
      return reply.redirect(url.toString());
    },
  );

  /**
   * GitHub App install (lets Kronos clone private repos and open the integration PR). With "Request user
   * authorization (OAuth) during installation" enabled on the App, this also signs the user in.
   */
  app.get(
    "/auth/github/install",
    { schema: { tags: ["auth"], summary: "Install the Kronos GitHub App (pass linkToken to attach it to the signed-in account)", querystring: startQuery } },
    async (req, reply) => {
      if (!env.GITHUB_APP_SLUG) throw new ApiError(501, "NOT_CONFIGURED", "GitHub App is not configured on this server");
      const state = await startState(reply, req.query.returnTo, req.query.linkToken);
      return reply.redirect(`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${state.s}`);
    },
  );

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
          error: z.string().optional(),
          error_description: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { code, state, installation_id, error } = req.query;
      let st: OAuthState | null = null;
      try {
        st = JSON.parse(Buffer.from(req.cookies[STATE_COOKIE] ?? "", "base64url").toString("utf8")) as OAuthState;
      } catch {
        st = null;
      }
      const returnTo = st?.r ?? "/";
      reply.clearCookie(STATE_COOKIE, { path: env.COOKIE_PATH });
      if (error) return reply.redirect(frontendCallback({ error, return_to: returnTo }));
      if (!code) {
        // App installed without user authorization: attach it to the account that started the install, if known.
        if (installation_id && st?.l && state === st.s) {
          await db.update(schema.users).set({ githubInstallationId: installation_id }).where(eq(schema.users.id, st.l));
        }
        return reply.redirect(frontendCallback({ installation_id: String(installation_id ?? ""), return_to: returnTo }));
      }
      if (!st || !state || state !== st.s) return reply.redirect(frontendCallback({ error: "state_mismatch", return_to: returnTo }));

      const tok = (await (
        await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
        })
      ).json()) as { access_token?: string; error?: string };
      if (!tok.access_token) return reply.redirect(frontendCallback({ error: tok.error ?? "oauth_failed", return_to: returnTo }));
      const gh = (await (
        await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": "kronos" } })
      ).json()) as { id: number; login: string };
      const githubId = String(gh.id);
      const install = installation_id ? { githubInstallationId: installation_id } : {};
      const [existing] = await db.select().from(schema.users).where(eq(schema.users.githubId, githubId));

      let userId: string;
      let isNew = false;
      if (st.l) {
        // linking GitHub to the signed-in account
        if (existing && existing.id !== st.l) return reply.redirect(frontendCallback({ error: "github_linked_to_another_account", return_to: returnTo }));
        await db.update(schema.users).set({ githubId, githubLogin: gh.login, ...install }).where(eq(schema.users.id, st.l));
        userId = st.l;
      } else if (existing) {
        await db.update(schema.users).set({ githubLogin: gh.login, ...install }).where(eq(schema.users.id, existing.id));
        userId = existing.id;
      } else {
        const [u] = await db.insert(schema.users).values({ githubId, githubLogin: gh.login, ...install }).returning();
        userId = u.id;
        isNew = true;
      }
      const s = await issueSession(reply, userId, isNew);
      return reply.redirect(
        frontendCallback({ access_token: s.accessToken, expires_in: String(s.expiresIn), new_user: isNew ? "1" : "0", return_to: returnTo }),
      );
    },
  );

  app.get(
    "/auth/nonce",
    {
      schema: { tags: ["auth"], summary: "Single-use nonce (10 min) for SIWE / NEAR sign-in", response: { 200: z.object({ nonce: z.string() }) } },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async () => ({ nonce: await createNonce() }),
  );

  app.post(
    "/auth/wallet",
    {
      preHandler: optionalAuth,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "SIWE or NEAR (NEP-413) signature. Signs in or signs up by wallet; with a bearer token, links the wallet to that account.",
        body: z.discriminatedUnion("type", [
          z.object({ type: z.literal("siwe"), message: z.string(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
          z.object({
            type: z.literal("near"),
            accountId: z.string(),
            publicKey: z.string(),
            signature: z.string(),
            message: z.string(),
            nonce: z.string().describe("the hex nonce from /auth/nonce (its 32 bytes are the NEP-413 nonce)"),
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
        return issueSession(reply, req.user.id, false);
      }
      if (existing) return issueSession(reply, existing.id, false);
      const [user] = await db.insert(schema.users).values({ [field]: value }).returning();
      return issueSession(reply, user.id, true);
    },
  );

  app.post(
    "/auth/refresh",
    {
      schema: {
        tags: ["auth"],
        summary: "Rotate the httpOnly refresh cookie and get a new access token (call on app load to restore the session)",
        response: { 200: Session },
      },
    },
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
      const [existing] = await db.select().from(schema.users).where(eq(schema.users.githubId, githubId));
      if (existing) return issueSession(reply, existing.id, false);
      const [user] = await db.insert(schema.users).values({ githubId, githubLogin: req.body.login }).returning();
      return issueSession(reply, user.id, true);
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
