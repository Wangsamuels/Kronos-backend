import { Worker, type Job } from "bullmq";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { createRedis } from "../lib/redis.js";
import { QUEUES, type StageJob, type PackageJob } from "../lib/queues.js";
import { pool } from "../db/client.js";
import { failRun, reopenReview } from "./context.js";
import { ingest } from "./stages/ingest.js";
import { analyze } from "./stages/analyze.js";
import { verify } from "./stages/verify.js";
import { buildPackage } from "./stages/package.js";
import { startMonitor } from "./monitor.js";
import { startAttestor } from "./attestor.js";

/**
 * Worker dyno: one BullMQ worker per stage queue plus the always-on monitor and the scheduled attestor.
 * WORKER_ROLES lets you split them across dynos later (e.g. a dedicated monitor dyno).
 */
const roles = new Set(env.WORKER_ROLES.split(",").map((s) => s.trim()));
const workers: Worker[] = [];

function stageWorker<T extends StageJob>(name: keyof typeof QUEUES, fn: (d: T) => Promise<unknown>, concurrency = 1) {
  const w = new Worker<T>(
    QUEUES[name],
    async (job: Job<T>) => {
      logger.info({ queue: name, runId: job.data.runId, attempt: job.attemptsMade + 1 }, "job start");
      await fn(job.data);
    },
    { connection: createRedis(), concurrency, lockDuration: 15 * 60_000 },
  );
  w.on("failed", async (job, err) => {
    logger.error({ queue: name, runId: job?.data.runId, err: err.message }, "job failed");
    // Out of retries: surface the failure on the run so the frontend stops waiting.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      if (name === "package") {
        // The review was already approved: put the run back in review so the team can approve again.
        await reopenReview(job.data.runId, job.data.protocolId, err.message).catch(() => undefined);
      } else {
        await failRun(job.data.runId, job.data.protocolId, `${name.toUpperCase()}_FAILED`, err.message).catch(() => undefined);
      }
    }
  });
  workers.push(w);
}

if (roles.has("ingest")) stageWorker("ingest", ingest, 2);
if (roles.has("analyze")) stageWorker("analyze", analyze, 2);
if (roles.has("verify")) stageWorker("verify", verify, 1);
if (roles.has("package")) stageWorker<PackageJob>("package", buildPackage, 2);
const stopMonitor = roles.has("monitor") ? startMonitor() : () => undefined;
const stopAttestor = roles.has("attestor") ? startAttestor() : () => undefined;
logger.info({ roles: [...roles] }, "kronos worker started");

const shutdown = async () => {
  stopMonitor();
  stopAttestor();
  await Promise.all(workers.map((w) => w.close()));
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
