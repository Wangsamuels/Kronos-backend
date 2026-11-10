import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** API contract tests against a real Postgres + Redis. Run with RUN_API_TESTS=1 (see README). */
const enabled = process.env.RUN_API_TESTS === "1";

describe.skipIf(!enabled)("API", () => {
  process.env.ALLOW_DEV_LOGIN = "true";
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

  it("rejects unsupported chains", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/protocols", headers: { authorization: `Bearer ${token}` }, payload: { repoUrl: "sample://minilend", chainId: 999 } });
    expect(r.statusCode).toBe(400);
  });
});
