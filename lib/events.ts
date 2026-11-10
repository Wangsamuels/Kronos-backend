import { db, schema } from "../db/client.js";
import { redis } from "./redis.js";

export type RunEventType = "stage" | "log" | "entrypoint" | "invariant" | "done" | "error";
export type Level = "debug" | "info" | "warn" | "error";

export interface RunEvent {
  id: number;
  runId: string;
  type: RunEventType;
  stage: string;
  level: Level;
  message: string;
  payload?: unknown;
  ts: string;
}

export const runChannel = (runId: string) => `kronos:run:${runId}`;

/**
 * Every stage writes progress to Postgres (durable, replayable live log) and Redis pub/sub
 * (low-latency fan-out). The API relays both to the frontend as SSE.
 */
export async function emit(
  runId: string,
  type: RunEventType,
  stage: string,
  message: string,
  payload?: unknown,
  level: Level = type === "error" ? "error" : "info",
): Promise<RunEvent> {
  const [row] = await db
    .insert(schema.runEvents)
    .values({ runId, type, stage, level, message, payload: payload ?? null })
    .returning();
  const ev: RunEvent = {
    id: row.id,
    runId,
    type,
    stage,
    level,
    message,
    payload: payload ?? undefined,
    ts: row.ts.toISOString(),
  };
  await redis().publish(runChannel(runId), JSON.stringify(ev));
  return ev;
}

/** Stage-scoped logger used by worker stages. */
export function runLogger(runId: string, stage: string) {
  return {
    info: (m: string, p?: unknown) => emit(runId, "log", stage, m, p, "info"),
    warn: (m: string, p?: unknown) => emit(runId, "log", stage, m, p, "warn"),
    debug: (m: string, p?: unknown) => emit(runId, "log", stage, m, p, "debug"),
    stage: (m: string, p?: unknown) => emit(runId, "stage", stage, m, p),
  };
}
export type RunLogger = ReturnType<typeof runLogger>;
