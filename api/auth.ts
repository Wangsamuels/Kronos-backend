import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../lib/env.js";
import { unauthorized } from "../lib/errors.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);
export const REFRESH_COOKIE = "kronos_rt";

export interface AuthUser {
  id: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("kronos")
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AuthUser> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: "kronos" });
    if (!payload.sub) throw new Error("no sub");
    return { id: payload.sub };
  } catch {
    throw unauthorized("Invalid or expired token");
  }
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  // EventSource can't send headers: SSE routes accept ?token=
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof q === "string" ? q : undefined;
}

/** preHandler: requires a valid access token. */
export async function requireAuth(req: FastifyRequest) {
  const t = bearer(req);
  if (!t) throw unauthorized();
  req.user = await verifyAccessToken(t);
}

/** preHandler: attaches the user if a token is present, never fails. */
export async function optionalAuth(req: FastifyRequest) {
  const t = bearer(req);
  if (t) req.user = await verifyAccessToken(t).catch(() => undefined);
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function cookieOpts() {
  const prod = env.NODE_ENV === "production";
  const sameSite = env.COOKIE_SAMESITE ?? (prod ? "none" : "lax");
  return {
    httpOnly: true,
    secure: prod || sameSite === "none",
    sameSite,
    path: env.COOKIE_PATH,
    domain: env.COOKIE_DOMAIN,
    maxAge: env.REFRESH_TOKEN_TTL,
  } as const;
}

/** Issues an access JWT (returned in the body, kept in memory by the frontend) + a rotating refresh cookie. */
export async function issueSession(reply: FastifyReply, userId: string, isNewUser = false) {
  const raw = crypto.randomBytes(32).toString("base64url");
  await db.insert(schema.refreshTokens).values({
    userId,
    tokenHash: sha(raw),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000),
  });
  reply.setCookie(REFRESH_COOKIE, raw, cookieOpts());
  return { accessToken: await signAccessToken(userId), expiresIn: env.ACCESS_TOKEN_TTL, userId, isNewUser };
}

export async function rotateSession(req: FastifyRequest, reply: FastifyReply) {
  const raw = req.cookies[REFRESH_COOKIE];
  if (!raw) throw unauthorized("No refresh token");
  const [row] = await db
    .select()
    .from(schema.refreshTokens)
    .where(
      and(
        eq(schema.refreshTokens.tokenHash, sha(raw)),
        isNull(schema.refreshTokens.revokedAt),
        gt(schema.refreshTokens.expiresAt, new Date()),
      ),
    );
  if (!row) throw unauthorized("Refresh token invalid");
  await db.update(schema.refreshTokens).set({ revokedAt: new Date() }).where(eq(schema.refreshTokens.id, row.id));
  return issueSession(reply, row.userId);
}

export async function endSession(req: FastifyRequest, reply: FastifyReply) {
  const raw = req.cookies[REFRESH_COOKIE];
  if (raw) await db.update(schema.refreshTokens).set({ revokedAt: new Date() }).where(eq(schema.refreshTokens.tokenHash, sha(raw)));
  reply.clearCookie(REFRESH_COOKIE, { path: env.COOKIE_PATH, domain: env.COOKIE_DOMAIN });
}
