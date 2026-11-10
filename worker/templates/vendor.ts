import fs from "node:fs/promises";
import path from "node:path";
import { KRONOS_CONTRACTS, KRONOS_SRC, ensureDir } from "../util/paths.js";

/**
 * Vendors the Kronos contract library (@kronos/contracts) into a package or verify workspace under
 * src/kronos/lib. Shared helper names are namespaced (IERC20 -> IKronosERC20, SafeTransfer ->
 * KronosSafeTransfer) so they never collide with the protocol's own files.
 */
const LIB_FILES: [string, string][] = [
  ["KronosGuard.sol", "KronosGuard.sol"],
  ["LendingInvariants.sol", "LendingInvariants.sol"],
  ["OutflowBreaker.sol", "OutflowBreaker.sol"],
  ["GuardTimelock.sol", "GuardTimelock.sol"],
  ["AttestationRegistry.sol", "AttestationRegistry.sol"],
  ["SafeTransfer.sol", "KronosSafeTransfer.sol"],
  ["interfaces/IAttestationRegistry.sol", "interfaces/IAttestationRegistry.sol"],
  ["interfaces/IKronosGuarded.sol", "interfaces/IKronosGuarded.sol"],
  ["interfaces/IERC20.sol", "interfaces/IKronosERC20.sol"],
];

export function namespace(src: string): string {
  return src
    .replace(/\bIERC20\b/g, "IKronosERC20")
    .replace(/\bSafeTransfer\b/g, "KronosSafeTransfer")
    .replace(/interfaces\/IERC20\.sol/g, "interfaces/IKronosERC20.sol")
    .replace(/\.\/SafeTransfer\.sol/g, "./KronosSafeTransfer.sol");
}

export async function libFiles(): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  for (const [from, to] of LIB_FILES) {
    out.push({ path: `src/kronos/lib/${to}`, content: namespace(await fs.readFile(path.join(KRONOS_SRC, from), "utf8")) });
  }
  return out;
}

export interface TestRewrite {
  name: string; // generated protocol name, e.g. MiniLend
  core: string; // core contract name
  mainFile: string; // path of the unguarded protocol file, relative to project root
  coreFile: string;
  params: Record<string, number | bigint>;
}

/** The attack library (contracts/test) rewritten to target the generated contracts. */
export async function testFiles(r: TestRewrite): Promise<{ path: string; content: string }[]> {
  const rel = (p: string) => path.posix.relative("test/kronos", p);
  const rewrite = (s: string) => {
    let out = s
      .replace(/"\.\.\/src\/samples\/GuardedMiniLend\.sol"/g, `"${rel(`src/kronos/Guarded${r.name}.sol`)}"`)
      .replace(/"\.\.\/src\/samples\/MiniLendCore\.sol"/g, `"${rel(r.coreFile)}"`)
      .replace(/"\.\.\/src\/samples\/MiniLend\.sol"/g, `"${rel(r.mainFile)}"`)
      .replace(/"\.\.\/src\/mocks\/Mocks\.sol"/g, `"./support/Mocks.sol"`)
      .replace(/"\.\.\/src\/(\w+)\.sol"/g, (_m, f) => `"../../src/kronos/lib/${f === "SafeTransfer" ? "KronosSafeTransfer" : f}.sol"`);
    out = out
      .replace(/\bGuardedMiniLend\b/g, `__GUARDED__`)
      .replace(/\bMiniLendCore\b/g, `__CORE__`)
      .replace(/\bMiniLend\b/g, `__MAIN__`)
      .replace(/__GUARDED__/g, `Guarded${r.name}`)
      .replace(/__CORE__/g, r.core)
      .replace(/__MAIN__/g, r.name);
    return out;
  };
  const files: { path: string; content: string }[] = [];
  for (const f of ["Base.t.sol", "Attacks.t.sol", "Guard.t.sol"]) {
    let c = rewrite(await fs.readFile(path.join(KRONOS_CONTRACTS, "test", f), "utf8"));
    if (f === "Base.t.sol") {
      const body = Object.entries(r.params)
        .map(([k, v]) => `            ${k}: ${BigInt(v).toString()}`)
        .join(",\n");
      c = c.replace(/return KronosGuard\.GuardParams\(\{[\s\S]*?\}\);/, `return KronosGuard.GuardParams({\n${body}\n        });`);
    }
    files.push({ path: `test/kronos/${f}`, content: c });
  }
  const mocks = (await fs.readFile(path.join(KRONOS_SRC, "mocks", "Mocks.sol"), "utf8")).replace(
    /import \{IERC20\} from "\.\.\/interfaces\/IERC20\.sol";/,
    `import {IERC20} from "../../../src/kronos/lib/interfaces/IKronosERC20.sol";`,
  );
  files.push({ path: "test/kronos/support/Mocks.sol", content: namespace(mocks).replace(/IKronosERC20\.sol";/, 'IKronosERC20.sol";') });
  return files;
}

export async function writeFiles(root: string, files: { path: string; content: string }[]) {
  for (const f of files) {
    const p = path.join(root, f.path);
    await ensureDir(path.dirname(p));
    await fs.writeFile(p, f.content);
  }
}
