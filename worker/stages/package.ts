import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { emit, runLogger } from "../../lib/events.js";
import { putObject } from "../../lib/storage.js";
import type { PackageJob } from "../../lib/queues.js";
import { loadRun, setStage, type IngestData } from "../context.js";
import { buildGuard } from "../build.js";
import { deployScript, PARAM_ORDER } from "../templates/generate.js";
import { libFiles, testFiles } from "../templates/vendor.js";
import { TEMPLATES } from "../templates/library.js";
import type { Thresholds } from "../history.js";

function zip(files: { path: string; content: string }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (c: Buffer) => chunks.push(c));
    out.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.pipe(out);
    for (const f of files) archive.append(f.content, { name: f.path });
    void archive.finalize();
  });
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Stage 4 — Package builder: assembles the approved guard package (contracts, config, tests, deploy
 * script, SDK snippet, docs), hashes it, uploads to R2, and records the manifest the PR and the
 * deployment verification use.
 */
export async function buildPackage(job: PackageJob) {
  const { runId, protocolId } = job;
  const { run, protocol } = await loadRun(runId);
  const ingest = run.ingest as IngestData;
  const log = runLogger(runId, "package");
  await db.update(schema.analysisRuns).set({ status: "packaging" }).where(eq(schema.analysisRuns.id, runId));
  await setStage(runId, "package", "Package builder: assembling the approved guard package");

  const invs = await db.select().from(schema.invariants).where(eq(schema.invariants.runId, runId));
  const eps = await db.select().from(schema.entrypoints).where(eq(schema.entrypoints.runId, runId));
  const tiers = await db.select().from(schema.tiers).where(and(eq(schema.tiers.runId, runId), eq(schema.tiers.status, "approved")));
  const intents = await db
    .select()
    .from(schema.intentSchemas)
    .where(and(eq(schema.intentSchemas.runId, runId), inArray(schema.intentSchemas.status, ["approved"])));
  const [report] = await db.select().from(schema.testReports).where(eq(schema.testReports.runId, runId));
  const thresholds = (run.thresholds as Thresholds | null) ?? null;

  const g = buildGuard(
    ingest,
    invs.map((i) => ({ template: i.template, params: i.params as Record<string, unknown>, status: i.status })),
  );
  const name = g.name;
  const privileged = tiers.map((t) => {
    const e = eps.find((x) => x.id === t.entrypointId)!;
    return { signature: e.signature, selector: e.selector, tier: t.tier, delaySeconds: t.delaySeconds, source: t.source };
  });
  const thr = (thresholds?.assets ?? []).map((a) => ({ asset: a.asset, threshold: a.threshold, staleLimit: a.staleLimit }));
  const n = (await db.select({ id: schema.packages.id }).from(schema.packages).innerJoin(schema.analysisRuns, eq(schema.analysisRuns.id, schema.packages.runId)).where(eq(schema.analysisRuns.protocolId, protocolId))).length;
  const version = `v${n + 1}-${g.configHash.slice(2, 8)}`;

  const config = {
    kronos: "1",
    protocol: { name: protocol.name, chainId: protocol.chainId, contract: name, commit: run.commitSha },
    adapter: ingest.mapping?.adapter,
    configHash: g.configHash,
    guardParams: Object.fromEntries(PARAM_ORDER.map((k) => [k, String(g.params[k])])),
    invariants: invs.map((i) => ({ template: i.template, title: i.title, status: i.status, params: i.params, plainText: i.plainText })),
    intents: intents.map((s) => ({ entrypoint: eps.find((e) => e.id === s.entrypointId)?.signature, eip712: s.eip712, bounds: s.bounds })),
    tiers: privileged,
    outflow: thresholds,
    guardedFunctions: g.guardedFunctions,
  };

  const sdkSnippet = `import { Kronos } from "@kronos/sdk";

// Guarded${name} on chain ${protocol.chainId}
const kronos = new Kronos({ chainId: ${protocol.chainId}, guard: GUARD_ADDRESS });

// Users sign a narrow, typed outcome in their wallet (EIP-712). A hacked frontend can only push values
// within these limits — it can't redirect funds.
const intent = await kronos.borrow({ asset: USDC, amount: 10_000n * 10n ** 6n, maxLtv: 0.7, minHealth: 1.2 });
const hash = await kronos.submit(intent, walletClient); // or a relayer submits and pays gas
`;

  const attacks = ((report?.details as { attacks?: { name: string; blocked: boolean; applies: boolean }[] })?.attacks ?? []).filter((a) => a.applies);
  const testReportMd = `# Kronos test report — ${protocol.name} ${version}

| Metric | Result |
|---|---|
| Normal traffic | ${report?.normalPass ?? 0} / ${report?.normalTxCount ?? 0} pass |
| Attacks blocked | ${report?.attacksBlocked ?? 0} / ${report?.attacksTotal ?? 0} |
| Borrow gas overhead | ${(report?.gas as { borrow?: { overhead?: number } })?.borrow?.overhead ?? "n/a"} |

## Attack library
${attacks.map((a) => `- ${a.blocked ? "✅ blocked" : "❌ NOT blocked"} — ${a.name}`).join("\n") || "- not run"}

## Invariants
${invs.map((i) => `- **${i.title}** (${i.status}): ${i.plainText}`).join("\n")}
`;

  const integrationMd = `# Integrating Kronos into ${name}

Package ${version} · config hash \`${g.configHash}\`

Kronos is a security layer: every user and admin action passes the same guard in the same transaction.
This package was generated from commit \`${run.commitSha ?? "n/a"}\`, reviewed and approved by your team.

## What's inside
- \`src/kronos/lib/\` — the Kronos guard library (@kronos/contracts): KronosGuard, LendingInvariants, OutflowBreaker, GuardTimelock, AttestationRegistry.
- \`src/kronos/GuardConfig.${name}.sol\` — generated: wires your getters into the invariant templates.
- \`src/kronos/Guarded${name}.sol\` — generated: your entry points taking a signed intent with \`guarded(...)\`.
- \`test/kronos/\` — normal-traffic replays and the attack library (oracle pump, share inflation, fake collateral, split drain, admin oracle swap, intent tampering).
- \`script/DeployKronos.s.sol\` — deploys the timelock, registry and guarded protocol with the approved parameters and tiers.
- \`kronos.config.json\` — every approved decision (invariants, intents, tiers, outflow thresholds).

## Steps
1. \`forge test --match-path 'test/kronos/*'\` — everything must pass.
2. Deploy: \`forge script script/DeployKronos.s.sol --rpc-url <rpc> --broadcast\` (see env vars at the top of the script).
3. Add your initial listings with \`timelock.setupCall(...)\` before \`finalizeSetup\` (already in the script).
4. In Kronos, register the deployment (guard + timelock addresses). Kronos verifies on-chain that the config hash matches this package, every entry point reverts without a valid intent, and the timelock owns every privileged role. The status then flips to **live** and the monitor and attestor subscribe.
5. Frontend: use \`@kronos/sdk\` (see \`sdk/kronos-example.ts\`).

## Timelock tiers
| Function | Tier | Delay |
|---|---|---|
${privileged.map((p) => `| \`${p.signature}\` | ${p.tier} | ${["instant (guardian)", "48 hours", "7 days", "14 days + co-sign"][p.tier]} |`).join("\n")}

## What Kronos can't stop
Users signing a malicious intent (phishing), stolen exchange keys, bugs in the chain itself, or bugs in these
invariants. Keep audits and fork tests in your release process.
${g.ok ? "" : `\n> ⚠️ ${g.reason}\n`}`;

  const files: { path: string; content: string }[] = [
    ...(await libFiles()),
    ...g.files,
    ...(g.tests ? await testFiles(g.tests) : []),
    { path: "script/DeployKronos.s.sol", content: deployScript(name, g.coreCtor, g.params, privileged, thr) },
    { path: "kronos.config.json", content: JSON.stringify(config, null, 2) },
    { path: "sdk/kronos-example.ts", content: sdkSnippet },
    { path: "INTEGRATION.md", content: integrationMd },
    { path: "KRONOS_TEST_REPORT.md", content: testReportMd },
  ];
  const zipBuf = await zip(files);
  const [pkgRow] = await db
    .insert(schema.packages)
    .values({ runId, version, configHash: g.configHash, manifest: {}, r2Key: "pending" })
    .returning();
  const base = `packages/${pkgRow.id}`;
  const stored = await putObject(`${base}/kronos-package.zip`, zipBuf, "application/zip");
  const prFiles = [];
  for (const f of files) {
    const key = `${base}/files/${f.path}`;
    await putObject(key, f.content, "text/plain");
    prFiles.push({ path: f.path, key });
  }
  const manifest = {
    version,
    configHash: g.configHash,
    guardParams: config.guardParams,
    packageSha256: stored.sha256,
    files: files.map((f) => ({ path: f.path, sha256: sha(f.content), bytes: Buffer.byteLength(f.content) })),
    guardedFunctions: g.guardedFunctions,
    privileged,
    thresholds,
    prFiles,
    prTitle: `Integrate Kronos guard (${version})`,
    prBody: `This PR adds the Kronos guard approved in review.\n\n- config hash: \`${g.configHash}\`\n- ${g.guardedFunctions.length} guarded entry points: ${g.guardedFunctions.map((f) => `\`${f.name}\``).join(", ")}\n- ${privileged.length} privileged functions routed through the GuardTimelock\n- attacks blocked in fork tests: ${report?.attacksBlocked ?? 0}/${report?.attacksTotal ?? 0}\n\nSee INTEGRATION.md and KRONOS_TEST_REPORT.md.`,
    diffPreview: {
      added: files.map((f) => f.path),
      summary: `${files.length} files: guard library, generated GuardConfig + Guarded${name}, ${g.tests ? "attack-library tests, " : ""}deploy script, config, docs`,
      generated: g.files.map((f) => ({ path: f.path, content: f.content })),
    },
    invariantTemplates: Object.fromEntries(invs.map((i) => [i.template, TEMPLATES[i.template]?.stops ?? ""])),
    warnings: g.ok ? [] : [g.reason],
  };
  await db.update(schema.packages).set({ manifest, r2Key: stored.key }).where(eq(schema.packages.id, pkgRow.id));
  await db.update(schema.analysisRuns).set({ status: "packaged", stage: "packaged" }).where(eq(schema.analysisRuns.id, runId));
  await log.info(`Package ${version}: ${files.length} files, ${(zipBuf.length / 1024).toFixed(1)} KB, sha256 ${stored.sha256.slice(0, 12)}`);
  await emit(runId, "done", "package", `Package ${version} ready (config hash ${g.configHash.slice(0, 10)}…). Open the integration PR or download the zip.`, {
    packageId: pkgRow.id,
    version,
    configHash: g.configHash,
  });
}
