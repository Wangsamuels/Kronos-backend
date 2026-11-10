import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "../lib/env.js";
import { chainInfo } from "../lib/chains.js";
import { cloneUrl, parseRepoUrl } from "../lib/github.js";
import { run } from "./util/exec.js";
import { KRONOS_SRC, ensureDir, listFiles } from "./util/paths.js";
import type { RunLogger } from "../lib/events.js";

export interface SourceBundle {
  root: string; // directory that contains the Solidity tree
  kind: "sample" | "git" | "explorer";
  commitSha: string;
  files: string[]; // relative to root
  explorer: { address: string; name: string; verified: boolean; implementation?: string }[];
  website?: { url: string; addresses: string[]; docs: string[]; error?: string };
  foundryProject: boolean;
}

/** Built-in samples, so the demo runs with no network access to GitHub. */
const SAMPLES: Record<string, string[]> = {
  minilend: ["samples/MiniLend.sol", "samples/MiniLendCore.sol", "interfaces/IERC20.sol", "SafeTransfer.sol"],
};

export async function fetchSources(
  ws: string,
  p: { repoUrl: string | null; addresses: string[]; chainId: number; websiteUrl: string | null; githubInstallationId: number | null },
  log: RunLogger,
): Promise<SourceBundle> {
  let bundle: SourceBundle;
  if (p.repoUrl?.startsWith("sample://")) {
    const name = p.repoUrl.slice(9).toLowerCase();
    const files = SAMPLES[name];
    if (!files) throw new Error(`Unknown sample "${name}". Available: ${Object.keys(SAMPLES).join(", ")}`);
    const root = await ensureDir(path.join(ws, "source"));
    const h = crypto.createHash("sha1");
    for (const f of files) {
      const dst = path.join(root, "src", f);
      await ensureDir(path.dirname(dst));
      const buf = await fsp.readFile(path.join(KRONOS_SRC, f));
      h.update(buf);
      await fsp.writeFile(dst, buf);
    }
    await log.info(`Loaded built-in sample "${name}" (${files.length} files)`);
    bundle = { root, kind: "sample", commitSha: `sample-${h.digest("hex").slice(0, 12)}`, files: files.map((f) => `src/${f}`), explorer: [], foundryProject: false };
  } else if (p.repoUrl) {
    const ref = parseRepoUrl(p.repoUrl);
    if (!ref) throw new Error("repoUrl must be a GitHub URL (https://github.com/org/repo[/tree/ref/subdir]) or sample://minilend");
    const dir = path.join(ws, "repo");
    const url = await cloneUrl(ref, p.githubInstallationId);
    await log.info(`Cloning ${ref.owner}/${ref.repo}${ref.ref ? `@${ref.ref}` : ""}${url.includes("x-access-token") ? " with GitHub App token" : ""}`);
    const args = ["clone", "--depth", "1", ...(ref.ref ? ["--branch", ref.ref] : []), url, dir];
    const r = await run("git", args, { timeoutMs: 180_000 });
    if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr.replace(/x-access-token:[^@]+@/g, "***@").slice(0, 400)}`);
    const sub = await run("git", ["submodule", "update", "--init", "--recursive", "--depth", "1"], { cwd: dir, timeoutMs: 180_000 });
    if (sub.code !== 0) await log.warn("Submodules could not be fetched; compilation may fail for external imports");
    const sha = (await run("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    const root = ref.subdir ? path.join(dir, ref.subdir) : dir;
    const files = (await listFiles(root, ".sol")).map((f) => path.relative(root, f)).filter((f) => !/(^|\/)(test|tests|script|mocks?)\//i.test(f) && !f.endsWith(".t.sol"));
    const foundry = await fsp.stat(path.join(root, "foundry.toml")).then(() => true, () => false);
    await log.info(`Cloned ${sha.slice(0, 10)}: ${files.length} Solidity files${foundry ? " (Foundry project)" : ""}`);
    bundle = { root, kind: "git", commitSha: sha, files, explorer: [], foundryProject: foundry };
  } else {
    const root = await ensureDir(path.join(ws, "explorer"));
    bundle = { root, kind: "explorer", commitSha: "", files: [], explorer: [], foundryProject: false };
  }

  if (p.addresses.length) {
    const ex = await fetchVerified(p.chainId, p.addresses, path.join(ws, "explorer"), log);
    bundle.explorer = ex.meta;
    if (bundle.kind === "explorer") {
      bundle.files = ex.files;
      bundle.commitSha = `explorer-${crypto.createHash("sha1").update(p.addresses.join(",")).digest("hex").slice(0, 12)}`;
    }
  }
  if (p.websiteUrl) bundle.website = await scrapeWebsite(p.websiteUrl, log);
  if (bundle.files.length === 0) throw new Error("No Solidity sources found (unverified contracts and no repo?)");
  return bundle;
}

interface EsSource {
  SourceCode: string;
  ContractName: string;
  ABI: string;
  Implementation?: string;
  Proxy?: string;
}

async function getSource(chainId: number, address: string): Promise<EsSource | null> {
  const info = chainInfo(chainId);
  if (!info.explorerApi) return null;
  const u = new URL(info.explorerApi.url);
  if (info.explorerApi.kind === "etherscan-v2") u.searchParams.set("chainid", String(chainId));
  u.searchParams.set("module", "contract");
  u.searchParams.set("action", "getsourcecode");
  u.searchParams.set("address", address);
  if (info.explorerApi.kind === "etherscan-v2" && env.ETHERSCAN_API_KEY) u.searchParams.set("apikey", env.ETHERSCAN_API_KEY);
  const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) return null;
  const body = (await r.json()) as { status: string; result: EsSource[] | string };
  if (!Array.isArray(body.result) || !body.result[0]?.SourceCode) return null;
  return body.result[0];
}

async function fetchVerified(chainId: number, addresses: string[], dir: string, log: RunLogger) {
  const meta: SourceBundle["explorer"] = [];
  const files: string[] = [];
  const queue = [...addresses];
  const seen = new Set<string>();
  while (queue.length) {
    const addr = queue.shift()!.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    let src: EsSource | null = null;
    try {
      src = await getSource(chainId, addr);
    } catch (e) {
      await log.warn(`Explorer lookup failed for ${addr}: ${String(e).slice(0, 120)}`);
    }
    if (!src) {
      meta.push({ address: addr, name: "unknown", verified: false });
      await log.warn(`${addr} is not verified on the explorer; skipping`);
      continue;
    }
    const base = path.join(dir, `${src.ContractName}_${addr.slice(2, 8)}`);
    let code = src.SourceCode.trim();
    const written: string[] = [];
    if (code.startsWith("{")) {
      if (code.startsWith("{{")) code = code.slice(1, -1);
      const j = JSON.parse(code) as { sources?: Record<string, { content: string }> } & Record<string, { content: string }>;
      const sources = j.sources ?? j;
      for (const [name, v] of Object.entries(sources)) {
        const f = path.join(base, name.replace(/^\/+/, ""));
        await ensureDir(path.dirname(f));
        await fsp.writeFile(f, v.content);
        written.push(f);
      }
    } else {
      const f = path.join(base, `${src.ContractName}.sol`);
      await ensureDir(base);
      await fsp.writeFile(f, code);
      written.push(f);
    }
    files.push(...written.map((f) => path.relative(dir, f)));
    const impl = src.Implementation && /^0x[0-9a-fA-F]{40}$/.test(src.Implementation) ? src.Implementation.toLowerCase() : undefined;
    meta.push({ address: addr, name: src.ContractName, verified: true, implementation: impl });
    await log.info(`Fetched verified source for ${src.ContractName} at ${addr}${impl ? ` (proxy → ${impl})` : ""}`);
    if (impl) queue.push(impl);
  }
  return { meta, files };
}

async function scrapeWebsite(url: string, log: RunLogger): Promise<NonNullable<SourceBundle["website"]>> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "KronosBot/0.1 (+security analysis)" } });
    const html = (await r.text()).slice(0, 1_000_000);
    const addresses = [...new Set(html.match(/0x[a-fA-F0-9]{40}/g) ?? [])].map((a) => a.toLowerCase()).slice(0, 50);
    const docs = [...new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => /docs|gitbook|github\.com|whitepaper/i.test(h)))].slice(0, 20);
    await log.info(`Website: ${addresses.length} addresses and ${docs.length} docs links found (used as hints only, never as source of truth)`);
    return { url, addresses, docs };
  } catch (e) {
    await log.warn(`Website could not be fetched: ${String(e).slice(0, 120)}`);
    return { url, addresses: [], docs: [], error: String(e) };
  }
}
