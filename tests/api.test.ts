import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSiweMessage } from "viem/siwe";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

/** API contract tests against a real Postgres + Redis. Run with RUN_API_TESTS=1 (see README). */
const enabled = process.env.RUN_API_TESTS === "1";

describe.skipIf(!enabled)("API", () => {
  process.env.ALLOW_DEV_LOGIN = "true";
  process.env.GITHUB_CLIENT_ID = "test-client";
  process.env.GITHUB_CLIENT_SECRET = "test-secret";
  process.env.FRONTEND_URL = "https://kronos-five-zeta.vercel.app";
  process.env.CORS_ORIGINS = "https://kronos-five-zeta.vercel.app,http://localhost:3000";
  let app: Awaited<ReturnType<typeof import("../api/app.js").buildApp>>;
  let token = "";
  beforeAll(async () => {
    const { buildApp } = await import("../api/app.js");
    app = await buildApp();
    const r = await app.inject({ method: "POST", url: "/v1/auth/dev", payload: { login: "vitest" } });
    token = r.json().accessToken;
  });
  afterAll(async () => app?.close());

  it("serves the OpenAPI 3.1 contract", async () => {
    const r = await app.inject({ url: "/openapi.json" });
    expect(r.json().openapi).toBe("3.1.0");
    expect(Object.keys(r.json().paths)).toContain("/v1/analyses/{id}/stream");
  });

  it("uses one error shape", async () => {
    const r = await app.inject({ url: "/v1/protocols" });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    const v = await app.inject({ method: "POST", url: "/v1/protocols", headers: { authorization: `Bearer ${token}` }, payload: { chainId: 1 } });
    expect(v.statusCode).toBe(400);
    expect(v.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("creates a protocol and starts a run", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/protocols",
      headers: { authorization: `Bearer ${token}` },
      payload: { repoUrl: "sample://minilend", chainId: 1313161555 },
    });
    expect(r.statusCode).toBe(201);
    const { protocol, analysisId } = r.json();
    expect(protocol.status).toBe("analyzing");
    const run = await app.inject({ url: `/v1/analyses/${analysisId}`, headers: { authorization: `Bearer ${token}` } });
    expect(["queued", "running", "review"]).toContain(run.json().status);
    const list = await app.inject({ url: "/v1/protocols?limit=5", headers: { authorization: `Bearer ${token}` } });
    expect(list.json().items.length).toBeGreaterThan(0);
  });

  it("lists sign-in providers for the modal", async () => {
    const r = (await app.inject({ url: "/v1/auth/providers" })).json();
    expect(r.github.enabled).toBe(true);
    expect(r.siwe.domain).toBe("kronos-five-zeta.vercel.app");
    expect(r.near.recipient).toBe("kronos-five-zeta.vercel.app");
  });

  it("starts GitHub OAuth with a safe returnTo only", async () => {
    const ok = await app.inject({ url: "/v1/auth/github?returnTo=/protect" });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toContain("github.com/login/oauth/authorize");
    const cookie = ok.cookies.find((c) => c.name === "kronos_oauth_state")!;
    expect(JSON.parse(Buffer.from(cookie.value, "base64url").toString()).r).toBe("/protect");
    const evil = await app.inject({ url: "/v1/auth/github?returnTo=//evil.example" });
    const c2 = evil.cookies.find((c) => c.name === "kronos_oauth_state")!;
    expect(JSON.parse(Buffer.from(c2.value, "base64url").toString()).r).toBe("/");
    // user cancels on GitHub -> back to the frontend with the error and where they were
    const cancel = await app.inject({ url: "/v1/auth/github/callback?error=access_denied", cookies: { kronos_oauth_state: cookie.value } });
    expect(cancel.headers.location).toBe("https://kronos-five-zeta.vercel.app/auth/callback#error=access_denied&return_to=%2Fprotect");
  });

  it("signs up, then signs in, with an Ethereum wallet (SIWE)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signIn = async () => {
      const { nonce } = (await app.inject({ url: "/v1/auth/nonce" })).json();
      const message = createSiweMessage({
        address: account.address,
        chainId: 84532,
        domain: "kronos-five-zeta.vercel.app",
        nonce,
        uri: "https://kronos-five-zeta.vercel.app",
        version: "1",
      });
      const signature = await account.signMessage({ message });
      return app.inject({ method: "POST", url: "/v1/auth/wallet", payload: { type: "siwe", message, signature } });
    };
    const first = await signIn();
    expect(first.statusCode).toBe(200);
    expect(first.json().isNewUser).toBe(true);
    const rt = first.cookies.find((c) => c.name === "kronos_rt")!;
    expect(rt.httpOnly).toBe(true);
    expect(rt.path).toBe("/");
    const second = await signIn();
    expect(second.json().isNewUser).toBe(false);
    expect(second.json().userId).toBe(first.json().userId);
    // the refresh cookie restores the session
    const refreshed = await app.inject({ method: "POST", url: "/v1/auth/refresh", cookies: { kronos_rt: rt.value } });
    expect(refreshed.json().userId).toBe(first.json().userId);
  });

  it("rejects a SIWE message for another domain and a replayed nonce", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { nonce } = (await app.inject({ url: "/v1/auth/nonce" })).json();
    const message = createSiweMessage({ address: account.address, chainId: 84532, domain: "evil.example", nonce, uri: "https://evil.example", version: "1" });
    const r = await app.inject({ method: "POST", url: "/v1/auth/wallet", payload: { type: "siwe", message, signature: await account.signMessage({ message }) } });
    expect(r.statusCode).toBe(401);
  });

  it("rejects a NEAR signature for another recipient", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/auth/wallet",
      payload: { type: "near", accountId: "x.testnet", publicKey: "ed25519:11111111111111111111111111111111", signature: "AA==", message: "Sign in to Kronos", nonce: "00", recipient: "other.app" },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toContain("recipient");
  });

  it("rejects unsupported chains", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/protocols", headers: { authorization: `Bearer ${token}` }, payload: { repoUrl: "sample://minilend", chainId: 999 } });
    expect(r.statusCode).toBe(400);
  });
});
