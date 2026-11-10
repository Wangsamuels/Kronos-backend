import { env } from "../lib/env.js";

const exact = new Set(
  env.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
// Allow Vercel preview deployments of the configured project, e.g. https://kronos-git-*.vercel.app
const patterns = [...exact].filter((o) => o.includes("*")).map((o) => new RegExp(`^${o.replace(/\./g, "\\.").replace(/\*/g, "[^.]+")}$`));

export function allowedOrigin(origin: string): boolean {
  return exact.has(origin) || patterns.some((p) => p.test(origin));
}
