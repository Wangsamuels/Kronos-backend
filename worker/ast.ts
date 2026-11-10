import fs from "node:fs/promises";
import path from "node:path";
import { toFunctionSelector } from "viem";
import { env } from "../lib/env.js";
import { run } from "./util/exec.js";
import { ensureDir, listFiles } from "./util/paths.js";

/** The protocol model every agent works from. Built from the solc AST (via forge), regex fallback. */
export interface Param {
  name: string;
  type: string;
}
export interface CallArg {
  kind: "identifier" | "member" | "literal" | "other";
  text: string;
}
export interface FnModel {
  contract: string; // defining contract
  name: string;
  visibility: string;
  mutability: string;
  kind: string; // function | constructor | fallback | receive
  virtual: boolean;
  implemented: boolean;
  overrides: boolean;
  modifiers: string[];
  params: Param[];
  returns: Param[];
  signature: string; // name(type,...)
  selector: string | null;
  accessControlled: boolean;
  body: string; // source text, truncated
  delegate?: { callee: string; args: CallArg[] }; // body is a single call to an internal function
  sendsTokens: boolean;
}
export interface ContractModel {
  name: string;
  kind: string;
  abstract: boolean;
  file: string;
  bases: string[]; // linearized, most-derived first (excluding self)
  functions: FnModel[]; // declared in this contract
  stateVars: { name: string; type: string; visibility: string }[];
  modifiers: { name: string; body: string }[];
}
export interface ProtocolModel {
  astSource: "solc" | "regex";
  compiler?: string;
  contracts: ContractModel[];
  compileErrors?: string;
}

const ACCESS_MOD = /only|auth|admin|owner|governance|gov|role|guardian|restricted|keeper|manager/i;

type Node = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function buildModel(root: string, files: string[], foundryProject: boolean, ws: string): Promise<ProtocolModel> {
  let projectDir = root;
  if (!foundryProject) {
    projectDir = await ensureDir(path.join(ws, "ast"));
    for (const f of files) {
      const dst = path.join(projectDir, f.startsWith("src/") ? f : path.join("src", f));
      await ensureDir(path.dirname(dst));
      await fs.copyFile(path.join(root, f), dst);
    }
    await fs.writeFile(path.join(projectDir, "foundry.toml"), `[profile.default]\nsrc = "src"\nout = "out"\nauto_detect_solc = true\n`);
  }
  const r = await run(env.FORGE_BIN, ["build", "--ast", "--skip", "test", "--skip", "script", "--force"], { cwd: projectDir, timeoutMs: 600_000 });
  if (r.code !== 0) {
    const regex = await regexModel(root, files);
    regex.compileErrors = (r.stderr || r.stdout).slice(-4000);
    return regex;
  }
  const outDir = path.join(projectDir, "out");
  const jsons = await listFilesDeep(outDir);
  const asts = new Map<string, Node>();
  let compiler: string | undefined;
  for (const j of jsons) {
    try {
      const data = JSON.parse(await fs.readFile(j, "utf8")) as { ast?: Node; metadata?: { compiler?: { version?: string } } };
      if (data.ast?.absolutePath && !asts.has(data.ast.absolutePath)) asts.set(data.ast.absolutePath, data.ast);
      compiler ??= data.metadata?.compiler?.version;
    } catch {
      /* skip */
    }
  }
  const sources = new Map<string, string>();
  for (const p of asts.keys()) sources.set(p, await fs.readFile(path.join(projectDir, p), "utf8").catch(() => ""));
  return { astSource: "solc", compiler, contracts: fromAst(asts, sources) };
}

async function listFilesDeep(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "build-info") await walk(p);
      } else if (e.name.endsWith(".json")) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

function typeOf(p: Node): string {
  const t: string = p.typeDescriptions?.typeString ?? p.typeName?.name ?? "unknown";
  // canonical ABI-ish type: strip "contract X" -> address, "struct A.B storage" -> tuple name
  return t
    .replace(/^contract \w+$/, "address")
    .replace(/^enum [\w.]+$/, "uint8")
    .replace(/ (storage|memory|calldata)( pointer| ref)?/g, "")
    .replace(/^struct /, "")
    .replace(/ payable$/, "");
}

function slice(src: string, s: string | undefined, max = 1500): string {
  if (!s) return "";
  const [start, len] = s.split(":").map(Number);
  return Buffer.from(src).subarray(start, start + len).toString("utf8").slice(0, max);
}

function argOf(n: Node, src: string): CallArg {
  if (n.nodeType === "Identifier") return { kind: "identifier", text: n.name };
  if (n.nodeType === "MemberAccess") return { kind: "member", text: slice(src, n.src, 200) };
  if (n.nodeType === "Literal") return { kind: "literal", text: String(n.value) };
  return { kind: "other", text: slice(src, n.src, 200) };
}

function fromAst(asts: Map<string, Node>, sources: Map<string, string>): ContractModel[] {
  const byId = new Map<number, Node>();
  const fileOf = new Map<number, string>();
  for (const [file, ast] of asts) {
    for (const n of ast.nodes ?? []) {
      if (n.nodeType === "ContractDefinition") {
        byId.set(n.id, n);
        fileOf.set(n.id, file);
      }
    }
  }
  const out: ContractModel[] = [];
  for (const [id, c] of byId) {
    const file = fileOf.get(id)!;
    const src = sources.get(file) ?? "";
    if (/^(lib|node_modules)\//.test(file) || file.includes("forge-std")) continue;
    const modifiers = (c.nodes as Node[])
      .filter((n) => n.nodeType === "ModifierDefinition")
      .map((m) => ({ name: m.name as string, body: slice(src, m.src, 800) }));
    const modBodies = new Map(modifiers.map((m) => [m.name, m.body]));
    const functions: FnModel[] = (c.nodes as Node[])
      .filter((n) => n.nodeType === "FunctionDefinition")
      .map((f) => {
        const params: Param[] = f.parameters.parameters.map((p: Node) => ({ name: p.name, type: typeOf(p) }));
        const returns: Param[] = f.returnParameters.parameters.map((p: Node) => ({ name: p.name, type: typeOf(p) }));
        const mods: string[] = f.modifiers.map((m: Node) => m.modifierName?.name ?? m.modifierName?.namePath).filter(Boolean);
        const body = slice(src, f.body?.src);
        const stmts: Node[] = f.body?.statements ?? [];
        let delegate: FnModel["delegate"];
        if (stmts.length === 1 && stmts[0].nodeType === "ExpressionStatement" && stmts[0].expression.nodeType === "FunctionCall") {
          const call = stmts[0].expression;
          if (call.expression.nodeType === "Identifier") {
            delegate = { callee: call.expression.name, args: call.arguments.map((a: Node) => argOf(a, src)) };
          }
        }
        const modSrc = mods.map((m) => modBodies.get(m) ?? "").join("\n");
        const accessControlled =
          mods.some((m) => ACCESS_MOD.test(m)) ||
          /msg\.sender\s*(==|!=)\s*\w+|hasRole\(|_checkOwner\(|_checkAdmin\(|_checkRole\(|requiresAuth/.test(body + modSrc);
        const sig = f.kind === "function" ? `${f.name}(${params.map((p) => p.type).join(",")})` : f.kind;
        let selector: string | null = f.functionSelector ? `0x${f.functionSelector}` : null;
        if (!selector && f.kind === "function" && (f.visibility === "external" || f.visibility === "public")) {
          try {
            selector = toFunctionSelector(`function ${sig}`);
          } catch {
            selector = null;
          }
        }
        return {
          contract: c.name,
          name: f.name || f.kind,
          visibility: f.visibility,
          mutability: f.stateMutability,
          kind: f.kind,
          virtual: Boolean(f.virtual),
          implemented: Boolean(f.implemented),
          overrides: Boolean(f.overrides),
          modifiers: mods,
          params,
          returns,
          signature: sig,
          selector,
          accessControlled,
          body,
          delegate,
          sendsTokens: /\.(safeTransfer|transfer|safeTransferFrom|transferFrom|call\{value)/.test(body),
        };
      });
    const stateVars = (c.nodes as Node[])
      .filter((n) => n.nodeType === "VariableDeclaration")
      .map((v) => ({ name: v.name, type: typeOf(v), visibility: v.visibility }));
    const bases = ((c.linearizedBaseContracts ?? []) as number[]).slice(1).map((b) => byId.get(b)?.name).filter(Boolean) as string[];
    out.push({ name: c.name, kind: c.contractKind, abstract: Boolean(c.abstract), file, bases, functions, stateVars, modifiers });
  }
  return out;
}

/** Fallback when the sources don't compile in isolation (missing remappings, exotic pragmas). */
async function regexModel(root: string, files: string[]): Promise<ProtocolModel> {
  const contracts: ContractModel[] = [];
  const all = files.length ? files : (await listFiles(root, ".sol")).map((f) => path.relative(root, f));
  for (const f of all) {
    const src = (await fs.readFile(path.join(root, f), "utf8").catch(() => "")).replace(/\/\/.*$/gm, "");
    for (const m of src.matchAll(/(abstract\s+)?(contract|interface|library)\s+(\w+)(?:\s+is\s+([^{]+))?\s*\{/g)) {
      const start = m.index! + m[0].length;
      let depth = 1;
      let i = start;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      const body = src.slice(start, i - 1);
      const functions: FnModel[] = [];
      for (const fm of body.matchAll(/function\s+(\w+)\s*\(([^)]*)\)([^{;]*)[{;]/g)) {
        const params = fm[2]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const parts = s.split(/\s+/).filter((w) => !/^(memory|calldata|storage)$/.test(w));
            return { type: parts[0], name: parts[parts.length - 1] === parts[0] ? "" : parts[parts.length - 1] };
          });
        const attrs = fm[3];
        const visibility = (attrs.match(/\b(external|public|internal|private)\b/) ?? [, "public"])[1]!;
        const mutability = (attrs.match(/\b(view|pure|payable)\b/) ?? [, "nonpayable"])[1]!;
        const mods = [...attrs.matchAll(/\b(\w+)(?:\([^)]*\))?/g)]
          .map((x) => x[1])
          .filter((w) => !/^(external|public|internal|private|view|pure|payable|virtual|override|returns|memory|calldata|storage|uint\d*|int\d*|address|bool|bytes\d*|string)$/.test(w));
        const sig = `${fm[1]}(${params.map((p) => p.type).join(",")})`;
        let selector: string | null = null;
        try {
          selector = toFunctionSelector(`function ${sig}`);
        } catch {
          /* ignore */
        }
        functions.push({
          contract: m[3],
          name: fm[1],
          visibility,
          mutability,
          kind: "function",
          virtual: /\bvirtual\b/.test(attrs),
          implemented: fm[0].endsWith("{"),
          overrides: /\boverride\b/.test(attrs),
          modifiers: mods,
          params,
          returns: [],
          signature: sig,
          selector,
          accessControlled: mods.some((x) => ACCESS_MOD.test(x)),
          body: "",
          sendsTokens: false,
        });
      }
      contracts.push({
        name: m[3],
        kind: m[2],
        abstract: Boolean(m[1]),
        file: f,
        bases: (m[4] ?? "").split(",").map((s) => s.trim().split(/[\s(]/)[0]).filter(Boolean),
        functions,
        stateVars: [],
        modifiers: [],
      });
    }
  }
  return { astSource: "regex", contracts };
}

/** All callable (external/public) state-changing functions of a concrete contract, including inherited ones. */
export function entryFunctions(model: ProtocolModel, contract: ContractModel): FnModel[] {
  const chain = [contract, ...contract.bases.map((b) => model.contracts.find((c) => c.name === b)).filter(Boolean)] as ContractModel[];
  const seen = new Set<string>();
  const out: FnModel[] = [];
  for (const c of chain) {
    for (const f of c.functions) {
      if (f.kind !== "function") continue;
      if (f.visibility !== "external" && f.visibility !== "public") continue;
      if (f.mutability === "view" || f.mutability === "pure") continue;
      if (seen.has(f.signature)) continue;
      seen.add(f.signature);
      out.push(f);
    }
  }
  return out;
}

export function allFunctions(model: ProtocolModel, contract: ContractModel): FnModel[] {
  const chain = [contract, ...contract.bases.map((b) => model.contracts.find((c) => c.name === b)).filter(Boolean)] as ContractModel[];
  return chain.flatMap((c) => c.functions);
}

/** Concrete, deployable contracts that expose entry points (not interfaces, libraries, mocks or abstract). */
export function concreteContracts(model: ProtocolModel): ContractModel[] {
  return model.contracts.filter((c) => c.kind === "contract" && !c.abstract && !/mock|test/i.test(c.name) && entryFunctions(model, c).length > 0);
}
