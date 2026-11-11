import type { ZodType } from "zod";
import { zodToJsonSchema } from "./zodJson.js";
import { env } from "./env.js";
import { redis } from "./redis.js";
import { logger } from "./logger.js";
import { db, schema } from "../db/client.js";
import { eq, sql } from "drizzle-orm";
import { emit } from "./events.js";

/**
 * llm.ts — the single LLM gateway. Every agent call goes through `llmJson`:
 *   - provider choice: NEAR AI Cloud (private inference in a TEE), any OpenAI-compatible endpoint,
 *     or `heuristic` (deterministic rule-based agents, used when no key is configured)
 *   - JSON-schema output validated with Zod, with a repair retry that feeds the validation error back
 *   - retries with exponential backoff on transport errors
 *   - a token budget per run (LLM_TOKEN_BUDGET), tracked in Redis and persisted to analysis_runs.token_cost
 *   - NEAR AI: the per-response TEE signature id and the gateway attestation are recorded on the run
 */

export type ModelSlot = "A" | "B";

export interface LlmCall<T> {
  runId: string;
  agent: string;
  slot?: ModelSlot;
  system: string;
  prompt: string;
  schema: ZodType<T>;
  /** Deterministic implementation used by the heuristic provider (and if the budget is exhausted). */
  heuristic: () => T | Promise<T>;
  maxTokens?: number;
}

export interface LlmResult<T> {
  data: T;
  provider: string;
  model: string;
  tokens: number;
  chatId?: string;
}

export class BudgetExceeded extends Error {}

const budgetKey = (runId: string) => `kronos:tokens:${runId}`;

function endpoint(): { base: string; key: string } | null {
  if (env.LLM_PROVIDER === "near-ai" && env.NEAR_AI_API_KEY) return { base: env.NEAR_AI_BASE_URL, key: env.NEAR_AI_API_KEY };
  if (env.LLM_PROVIDER === "openai-compatible" && env.LLM_BASE_URL && env.LLM_API_KEY)
    return { base: env.LLM_BASE_URL, key: env.LLM_API_KEY };
  return null;
}

export function providerName(): string {
  return endpoint() ? env.LLM_PROVIDER! : "heuristic";
}

async function addTokens(runId: string, n: number) {
  const total = await redis().incrby(budgetKey(runId), n);
  await redis().expire(budgetKey(runId), 7 * 24 * 3600);
  await db
    .update(schema.analysisRuns)
    .set({ tokenCost: sql`${schema.analysisRuns.tokenCost} + ${n}` })
    .where(eq(schema.analysisRuns.id, runId));
  return total;
}

export async function llmJson<T>(call: LlmCall<T>): Promise<LlmResult<T>> {
  const ep = endpoint();
  if (!ep) {
    return { data: await call.heuristic(), provider: "heuristic", model: `heuristic-${call.slot ?? "A"}`, tokens: 0 };
  }
  const used = Number((await redis().get(budgetKey(call.runId))) ?? 0);
  if (used >= env.LLM_TOKEN_BUDGET) throw new BudgetExceeded(`token budget of ${env.LLM_TOKEN_BUDGET} exhausted`);

  const model = call.slot === "B" ? env.LLM_MODEL_B : env.LLM_MODEL_A;
  const jsonSchema = zodToJsonSchema(call.schema);
  const messages: { role: string; content: string }[] = [
    {
      role: "system",
      content: `${call.system}\n\nRespond with ONE JSON object only, no prose, matching this JSON schema:\n${JSON.stringify(jsonSchema)}`,
    },
    { role: "user", content: call.prompt },
  ];

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${ep.base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ep.key}` },
        body: JSON.stringify({
          model,
          messages,
          temperature: call.slot === "B" ? 0.4 : 0.1,
          max_tokens: call.maxTokens ?? 4096,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`LLM HTTP ${res.status}`);
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as {
        id?: string;
        choices: { message: { content: string } }[];
        usage?: { total_tokens?: number };
      };
      const tokens = body.usage?.total_tokens ?? 0;
      await addTokens(call.runId, tokens);
      const text = body.choices?.[0]?.message?.content ?? "";
      const parsed = call.schema.safeParse(extractJson(text));
      if (parsed.success) return { data: parsed.data, provider: env.LLM_PROVIDER!, model, tokens, chatId: body.id };
      // repair round: show the model exactly what failed validation
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "user",
        content: `That JSON failed validation: ${JSON.stringify(parsed.error.issues.slice(0, 8))}. Return corrected JSON only.`,
      });
      lastErr = parsed.error;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  logger.warn({ err: String(lastErr), agent: call.agent }, "llm failed after retries; using heuristic agent");
  // Make the fallback visible in the run's live log, not only in server logs.
  await emit(call.runId, "log", call.agent, `LLM call failed (${String(lastErr).slice(0, 200)}); used the deterministic ${call.agent} instead`, undefined, "warn").catch(() => undefined);
  return { data: await call.heuristic(), provider: "heuristic-fallback", model: "heuristic", tokens: 0 };
}

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf("{");
    const e = t.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(t.slice(s, e + 1));
      } catch {
        /* fallthrough */
      }
    }
    return null;
  }
}

/**
 * NEAR AI Cloud TEE evidence for the run: the gateway attestation report (Intel TDX quote) and, for a
 * sample of completions, the per-response signature. Recorded on analysis_runs.llm_json for the report.
 */
export async function teeEvidence(chatIds: string[]): Promise<Record<string, unknown>> {
  if (env.LLM_PROVIDER !== "near-ai" || !env.NEAR_AI_API_KEY) return { provider: providerName(), tee: false };
  const base = env.NEAR_AI_BASE_URL.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${env.NEAR_AI_API_KEY}` };
  const out: Record<string, unknown> = { provider: "near-ai", tee: true };
  try {
    const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const r = await fetch(`${base}/attestation/report?model=${encodeURIComponent(env.LLM_MODEL_A)}&nonce=${nonce}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (r.ok) {
      const rep = (await r.json()) as { gateway_attestation?: Record<string, unknown>; model_attestations?: unknown[] };
      const g = rep.gateway_attestation ?? {};
      out.attestation = {
        nonce,
        signingAddress: g.signing_address,
        signingAlgo: g.signing_algo,
        requestNonce: g.request_nonce,
        reportData: g.report_data,
        intelQuotePrefix: typeof g.intel_quote === "string" ? g.intel_quote.slice(0, 64) : undefined,
        modelAttestations: Array.isArray(rep.model_attestations) ? rep.model_attestations.length : 0,
      };
    } else out.attestationError = `HTTP ${r.status}`;
  } catch (e) {
    out.attestationError = String(e);
  }
  const sigs: unknown[] = [];
  for (const id of chatIds.slice(0, 3)) {
    try {
      const r = await fetch(`${base}/signature/${id}?signing_algo=ecdsa&model=${encodeURIComponent(env.LLM_MODEL_A)}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) sigs.push({ chatId: id, ...((await r.json()) as object) });
    } catch {
      /* best effort */
    }
  }
  out.signatures = sigs;
  return out;
}
