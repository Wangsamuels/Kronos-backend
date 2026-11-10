import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a binary without a shell (no injection), with a hard timeout and output cap. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; maxBytes?: number } = {},
): Promise<ExecResult> {
  const max = opts.maxBytes ?? 32 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 300_000);
    child.stdout.on("data", (d) => {
      if (stdout.length < max) stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < max) stderr += d;
    });
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: 127, stdout, stderr: stderr + String(e), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

export async function which(bin: string): Promise<boolean> {
  const r = await run(bin, ["--version"], { timeoutMs: 15_000 });
  return r.code === 0;
}
