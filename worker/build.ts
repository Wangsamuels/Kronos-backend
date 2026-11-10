import fs from "node:fs/promises";
import path from "node:path";
import type { IngestData } from "./context.js";
import { projectPath } from "./context.js";
import { allFunctions } from "./ast.js";
import { configHash, generate, guardParamsFrom, PARAM_ORDER, type InvariantDecision, type GuardParams } from "./templates/generate.js";
import type { TestRewrite } from "./templates/vendor.js";

export interface GeneratedGuard {
  ok: boolean;
  reason?: string;
  name: string;
  files: { path: string; content: string }[];
  params: GuardParams;
  configHash: `0x${string}`;
  unresolved: string[];
  guardedFunctions: { name: string; kind: string }[];
  coreCtor: { name: string; type: string }[];
  tests: TestRewrite | null;
  mainFile: string;
  coreFile: string;
}

/** Renders the guard for the current decisions. Shared by the verifier and the package builder. */
export function buildGuard(ingest: IngestData, invariants: InvariantDecision[]): GeneratedGuard {
  const { model, mapping } = ingest;
  const { params, disabled } = guardParamsFrom(invariants);
  const hash = configHash(params);
  const base = { params, configHash: hash, files: [], unresolved: [], guardedFunctions: [], coreCtor: [], tests: null, mainFile: "", coreFile: "" };
  if (!mapping) return { ok: false, reason: "no mapping", name: "Unknown", ...base };
  const name = mapping.protocolContract;
  const main = model.contracts.find((c) => c.name === name);
  const core = model.contracts.find((c) => c.name === mapping.coreContract);
  if (mapping.adapter !== "compound-v2-style" || !main || !core) {
    return {
      ok: false,
      reason: `No vetted adapter matches ${name} yet (adapter: ${mapping.adapter}). The package will contain the guard library, config and intent schemas; wiring GuardConfig needs a manual step or an LLM-drafted adapter.`,
      name,
      ...base,
    };
  }
  const fp = ingest.source.foundryProject;
  const mainFile = projectPath(main.file, fp);
  const coreFile = projectPath(core.file, fp);
  const fns = allFunctions(model, main);
  const userEntrypoints = mapping.entrypoints
    .filter((e) => e.role === "user")
    .map((e) => ({ fn: fns.find((f) => f.signature === e.signature)!, kind: e.kind }))
    .filter((e) => e.fn);
  const g = generate({
    name,
    core,
    coreImport: path.posix.relative("src/kronos", coreFile).replace(/^(?!\.)/, "./"),
    model,
    keyState: mapping.keyState,
    userEntrypoints,
    disabled,
  });
  return {
    ok: g.unresolved.length === 0,
    reason: g.unresolved.length ? `Unresolved: ${g.unresolved.join("; ")}` : undefined,
    name,
    files: [
      { path: `src/kronos/GuardConfig.${name}.sol`, content: g.guardConfig },
      { path: `src/kronos/Guarded${name}.sol`, content: g.guarded },
    ],
    params,
    configHash: hash,
    unresolved: g.unresolved,
    guardedFunctions: g.guardedFunctions,
    coreCtor: g.coreCtor,
    mainFile,
    coreFile,
    tests: {
      name,
      core: core.name,
      mainFile,
      coreFile,
      params: Object.fromEntries(PARAM_ORDER.map((k) => [k, BigInt(params[k])])),
    },
  };
}

/** Protocol sources as project-relative files (for the verify workspace and the package diff). */
export async function protocolFiles(snapshotDir: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".sol")) out.push({ path: path.relative(snapshotDir, p), content: await fs.readFile(p, "utf8") });
    }
  };
  await walk(snapshotDir);
  return out;
}
