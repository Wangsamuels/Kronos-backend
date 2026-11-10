import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../../lib/env.js";

/** Repo root, both from source (tsx) and from dist/ (compiled). */
function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "contracts", "foundry.toml"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export const ROOT = findRoot();
export const KRONOS_CONTRACTS = path.join(ROOT, "contracts");
export const KRONOS_SRC = path.join(KRONOS_CONTRACTS, "src");
export const FORGE_STD = path.join(KRONOS_CONTRACTS, "lib", "forge-std");

export function runDir(runId: string) {
  return path.resolve(env.WORKDIR, runId);
}

export async function ensureDir(p: string) {
  await fsp.mkdir(p, { recursive: true });
  return p;
}

export async function copyDir(src: string, dst: string, filter?: (p: string) => boolean) {
  await fsp.cp(src, dst, {
    recursive: true,
    filter: (p) => !/\/(\.git|node_modules|out|cache|broadcast)(\/|$)/.test(p) && (!filter || fs.statSync(p).isDirectory() || filter(p)),
  });
}

export async function listFiles(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (/^(\.git|node_modules|out|cache|broadcast|lib)$/.test(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(ext)) out.push(p);
    }
  }
  await walk(dir);
  return out;
}
