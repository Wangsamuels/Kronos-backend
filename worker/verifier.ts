import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../lib/env.js";
import { run } from "./util/exec.js";
import { FORGE_STD, ensureDir } from "./util/paths.js";
import { libFiles, testFiles, writeFiles, type TestRewrite } from "./templates/vendor.js";
import { ATTACK_LIBRARY, NORMAL_TESTS } from "./templates/library.js";

export interface WorkspaceInput {
  dir: string;
  protocolFiles: { path: string; content: string }[]; // at their project-relative paths
  generated: { path: string; content: string }[];
  tests: TestRewrite | null; // null => no adapter test library
}

const FOUNDRY_TOML = `[profile.default]
src = "src"
test = "test"
out = "out"
libs = ["lib"]
solc_version = "0.8.24"
evm_version = "paris"
optimizer = true
optimizer_runs = 200
`;

export async function buildWorkspace(w: WorkspaceInput) {
  await fs.rm(w.dir, { recursive: true, force: true });
  await ensureDir(path.join(w.dir, "lib"));
  await fs.symlink(FORGE_STD, path.join(w.dir, "lib", "forge-std"), "dir").catch(async () => {
    await fs.cp(FORGE_STD, path.join(w.dir, "lib", "forge-std"), { recursive: true });
  });
  await fs.writeFile(path.join(w.dir, "foundry.toml"), FOUNDRY_TOML);
  await writeFiles(w.dir, w.protocolFiles);
  await writeFiles(w.dir, await libFiles());
  await writeFiles(w.dir, w.generated);
  if (w.tests) await writeFiles(w.dir, await testFiles(w.tests));
}

export async function compile(dir: string) {
  const r = await run(env.FORGE_BIN, ["build", "--force"], { cwd: dir, timeoutMs: 600_000 });
  return { ok: r.code === 0, log: (r.stderr + "\n" + r.stdout).slice(-6000) };
}

interface ForgeTest {
  status: string;
  reason: string | null;
  decoded_logs?: string[];
  kind?: { Unit?: { gas: number } };
}

export interface TestOutcome {
  name: string;
  suite: string;
  passed: boolean;
  reason: string | null;
  gas?: number;
}

export async function runTests(dir: string): Promise<{ ok: boolean; tests: TestOutcome[]; logs: Record<string, string[]>; raw?: string }> {
  const r = await run(env.FORGE_BIN, ["test", "--json", "--offline", "-vv"], { cwd: dir, timeoutMs: 900_000 });
  const start = r.stdout.indexOf("{");
  if (start < 0) return { ok: false, tests: [], logs: {}, raw: (r.stderr + r.stdout).slice(-4000) };
  let parsed: Record<string, { test_results: Record<string, ForgeTest> }>;
  try {
    parsed = JSON.parse(r.stdout.slice(start));
  } catch {
    return { ok: false, tests: [], logs: {}, raw: r.stdout.slice(-4000) };
  }
  const tests: TestOutcome[] = [];
  const logs: Record<string, string[]> = {};
  for (const [suite, s] of Object.entries(parsed)) {
    for (const [name, t] of Object.entries(s.test_results)) {
      const short = name.replace(/\(.*\)$/, "");
      tests.push({ name: short, suite: suite.split(":").pop()!, passed: t.status === "Success", reason: t.reason, gas: t.kind?.Unit?.gas });
      if (t.decoded_logs?.length) logs[short] = t.decoded_logs;
    }
  }
  return { ok: true, tests, logs };
}

export interface AttackResult {
  id: string;
  name: string;
  targetInvariant: string;
  applies: boolean;
  baselineExploitWorks: boolean | null; // the attack succeeds against the unguarded protocol
  blocked: boolean; // every guarded test passed (attack reverted or queued)
  tests: TestOutcome[];
}

export function summarize(tests: TestOutcome[], logs: Record<string, string[]>, applies: Record<string, boolean>) {
  const byName = new Map(tests.map((t) => [t.name, t]));
  const attacks: AttackResult[] = ATTACK_LIBRARY.map((a) => {
    const guarded = a.guardedTests.map((n) => byName.get(n)).filter(Boolean) as TestOutcome[];
    const baseline = a.baselineTests.map((n) => byName.get(n)).filter(Boolean) as TestOutcome[];
    return {
      id: a.id,
      name: a.name,
      targetInvariant: a.targetInvariant,
      applies: applies[a.id] ?? true,
      baselineExploitWorks: baseline.length ? baseline.every((t) => t.passed) : null,
      blocked: guarded.length > 0 && guarded.every((t) => t.passed),
      tests: [...guarded, ...baseline],
    };
  });
  const normal = NORMAL_TESTS.map((n) => byName.get(n)).filter(Boolean) as TestOutcome[];
  const gasLines = logs["test_GasOverhead"] ?? [];
  const num = (label: string) => {
    const l = gasLines.find((x) => x.includes(label));
    return l ? Number(l.trim().split(/\s+/).pop()) : null;
  };
  const gas = {
    borrow: { plain: num("borrow gas plain"), guarded: num("borrow gas guarded"), overhead: num("overhead") },
    perTest: Object.fromEntries(tests.filter((t) => t.gas).map((t) => [t.name, t.gas])),
  };
  return { attacks, normal, gas };
}
