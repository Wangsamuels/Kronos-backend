/**
 * Small operator CLI for testnet deployment against a running Kronos API (Heroku or local).
 *
 *   API_URL=https://<app>.herokuapp.com npx tsx scripts/kronos-cli.ts prepare
 *       signs in (dev login, or TOKEN=<access token>), submits the MiniLend sample, waits for the analysis,
 *       approves it, downloads the package and writes contracts/deployments/kronos.config.json
 *       (the approved parameters forge must deploy with) + contracts/deployments/kronos.protocol.json
 *
 *   API_URL=... npx tsx scripts/kronos-cli.ts register 1313161555
 *       registers contracts/deployments/<chainId>.json with Kronos and prints the on-chain verification
 *
 *   NEAR_ACCOUNT_ID=... NEAR_FUNCTION_CALL_KEY=ed25519:... NEAR_REGISTRY_CONTRACT=... npx tsx scripts/kronos-cli.ts near-demo
 *       with the monitor's function-call key: tighten (pause the THIN market) succeeds, unpause is rejected
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = (process.env.API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY_DIR = path.join(ROOT, "contracts", "deployments");
const STATE = path.join(DEPLOY_DIR, "kronos.protocol.json");
let token = process.env.TOKEN ?? "";

async function api<T>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${j.error?.message ?? text}`);
  return j as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login() {
  if (token) return;
  const s = await api<{ accessToken: string }>("POST", "/v1/auth/dev", { login: process.env.LOGIN ?? "operator" });
  token = s.accessToken;
}

async function waitRun(id: string, until: string[]) {
  let last = "";
  for (let i = 0; i < 240; i++) {
    const r = await api<{ status: string; stage: string; error: { message?: string } | null }>("GET", `/v1/analyses/${id}`);
    if (`${r.status}/${r.stage}` !== last) {
      last = `${r.status}/${r.stage}`;
      console.log(`  ${last}`);
    }
    if (r.status === "failed") throw new Error(`analysis failed: ${r.error?.message ?? "see the run log"}`);
    if (until.includes(r.status)) return r;
    await sleep(5000);
  }
  throw new Error("timed out waiting for the analysis");
}

async function prepare() {
  const chainId = Number(process.env.CHAIN_ID ?? 1313161555);
  await login();
  console.log(`Submitting the MiniLend sample to ${API} (chain ${chainId})`);
  const { protocol, analysisId } = await api<{ protocol: { id: string }; analysisId: string }>("POST", "/v1/protocols", {
    repoUrl: process.env.REPO_URL ?? "sample://minilend",
    chainId,
  });
  await waitRun(analysisId, ["review"]);
  const res = await api<{ invariants: { id: string; title: string; needsReview: boolean }[]; testReport: { attacksBlocked: number; attacksTotal: number } | null }>(
    "GET",
    `/v1/analyses/${analysisId}/results`,
  );
  console.log(`  attacks blocked: ${res.testReport?.attacksBlocked}/${res.testReport?.attacksTotal}`);
  for (const i of res.invariants.filter((x) => x.needsReview)) {
    console.log(`  approving flagged invariant: ${i.title}`);
    await api("PATCH", `/v1/invariants/${i.id}`, { status: "approved" });
  }
  await api("POST", `/v1/analyses/${analysisId}/approve`);
  await waitRun(analysisId, ["packaged"]);
  const pkg = await api<{ id: string; version: string; configHash: string }>("GET", `/v1/analyses/${analysisId}/package`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kronos-pkg-"));
  const zip = path.join(tmp, "package.zip");
  fs.writeFileSync(zip, Buffer.from(await (await fetch(`${API}/v1/packages/${pkg.id}/download?token=${token}`)).arrayBuffer()));
  execFileSync("unzip", ["-q", "-o", zip, "kronos.config.json", "-d", tmp]);
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  fs.copyFileSync(path.join(tmp, "kronos.config.json"), path.join(DEPLOY_DIR, "kronos.config.json"));
  fs.writeFileSync(STATE, JSON.stringify({ api: API, protocolId: protocol.id, analysisId, packageId: pkg.id, version: pkg.version, configHash: pkg.configHash }, null, 2));
  console.log(`\nPackage ${pkg.version} approved. Config hash ${pkg.configHash}`);
  console.log(`Wrote contracts/deployments/kronos.config.json and kronos.protocol.json (protocol ${protocol.id})`);
}

async function register(chainId: string) {
  if (!chainId) throw new Error("usage: register <chainId>");
  const state = JSON.parse(fs.readFileSync(STATE, "utf8")) as { protocolId: string };
  const d = JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, `${chainId}.json`), "utf8")) as Record<string, string>;
  await login();
  const dep = await api<{ verified: boolean; checks: { ok: boolean; name: string; detail: string }[] }>("POST", `/v1/protocols/${state.protocolId}/deployments`, {
    chainId: Number(chainId),
    guardAddress: d.guardedMiniLend,
    timelockAddress: d.timelock,
  });
  for (const c of dep.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : ` — ${c.detail}`}`);
  console.log(dep.verified ? `\nVerified: protocol ${state.protocolId} is live on chain ${chainId}.` : "\nNot verified: fix the ✗ checks above and register again.");
}

async function nearDemo() {
  const state = JSON.parse(fs.readFileSync(STATE, "utf8")) as { protocolId: string };
  const d = JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, "1313161555.json"), "utf8")) as Record<string, string>;
  const { nearTighten, nearTryLoosen, nearView } = await import("../lib/near.js");
  const net = process.env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
  console.log(`Monitor key: tighten protocol ${state.protocolId} (pause the THIN market)`);
  const t = await nearTighten(state.protocolId, { Pause: { market: d.thin.toLowerCase() } }, "near-demo: oracle anomaly on THIN");
  if (t.dryRun) throw new Error("NEAR_ACCOUNT_ID / NEAR_FUNCTION_CALL_KEY are not set");
  console.log(t.ok ? `  ✓ tighten accepted: https://${net === "testnet" ? "testnet." : ""}nearblocks.io/txns/${t.tx}` : `  ✗ tighten failed: ${t.error}`);
  console.log("Same key tries to loosen (unpause):");
  const l = await nearTryLoosen(state.protocolId, d.thin.toLowerCase());
  console.log(l.rejected ? `  ✓ rejected: ${(l.error ?? "").split("\n")[0].slice(0, 160)}` : "  ✗ loosen was ACCEPTED (key is not restricted!)");
  const p = await nearView<{ paused: Record<string, boolean>; status: string }>("get_protocol", { protocol_id: state.protocolId });
  console.log(`Registry now: status=${p?.status}, paused=${JSON.stringify(p?.paused)}`);
}

/** One chat completion against NEAR AI Cloud with the same request shape the backend uses. */
async function llmCheck() {
  const key = process.env.NEAR_AI_API_KEY;
  if (!key) throw new Error("set NEAR_AI_API_KEY (heroku config:get NEAR_AI_API_KEY -a kronos)");
  const base = (process.env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL_A ?? "z-ai/glm-5.3";
  const models = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
  const list = models.ok ? ((await models.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [] : [];
  console.log(`models available (${list.length}): ${list.slice(0, 15).join(", ")}${list.length > 15 ? ", …" : ""}`);
  console.log(list.includes(model) ? `  ✓ ${model} is available` : `  ✗ ${model} is NOT in the list: set LLM_MODEL_A / LLM_MODEL_B to one of the above`);
  for (const withFormat of [true, false]) {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Respond with ONE JSON object only." },
          { role: "user", content: 'Return {"ok": true}' },
        ],
        temperature: 0.1,
        max_tokens: 64,
        ...(withFormat ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await r.text();
    console.log(`chat/completions ${withFormat ? "with" : "without"} response_format: HTTP ${r.status} ${text.slice(0, 300)}`);
  }
}

const [cmd, arg] = process.argv.slice(2);
(cmd === "prepare"
  ? prepare()
  : cmd === "register"
    ? register(arg)
    : cmd === "near-demo"
      ? nearDemo()
      : cmd === "llm-check"
        ? llmCheck()
        : Promise.reject(new Error("commands: prepare | register <chainId> | near-demo | llm-check"))).catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
