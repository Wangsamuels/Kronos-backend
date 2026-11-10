import { Queue, type JobsOptions } from "bullmq";
import { createRedis } from "./redis.js";

/** One queue per stage, retries with backoff, idempotent job ids. */
export const QUEUES = {
  ingest: "kronos-ingest",
  analyze: "kronos-analyze",
  verify: "kronos-verify",
  package: "kronos-package",
} as const;
export type QueueName = keyof typeof QUEUES;

export interface StageJob {
  runId: string;
  protocolId: string;
}
export interface PackageJob extends StageJob {
  version?: string;
}

const defaults: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
  removeOnFail: { age: 14 * 24 * 3600 },
};

const cache = new Map<QueueName, Queue>();
export function queue(name: QueueName): Queue {
  let q = cache.get(name);
  if (!q) {
    q = new Queue(QUEUES[name], { connection: createRedis(), defaultJobOptions: defaults });
    cache.set(name, q);
  }
  return q;
}

/** Idempotent enqueue: the same (stage, runId) never runs twice concurrently. */
export async function enqueueStage(name: QueueName, data: StageJob | PackageJob, suffix = "") {
  // BullMQ custom ids may not contain ':'
  return queue(name).add(name, data, { jobId: `${name}-${data.runId}${suffix ? `-${suffix}` : ""}` });
}

export async function queueHealth() {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(QUEUES) as QueueName[]) {
    out[name] = await queue(name).getJobCounts("waiting", "active", "failed", "delayed");
  }
  return out;
}
