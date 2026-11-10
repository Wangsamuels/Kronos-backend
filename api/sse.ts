import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, gt } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { createRedis } from "../lib/redis.js";
import type { RunEvent } from "../lib/events.js";
import { allowedOrigin } from "./cors.js";

/** One shared Redis subscriber for the dyno, fanned out in-process. */
const bus = new EventEmitter();
bus.setMaxListeners(0);
let started = false;
function ensureSubscriber() {
  if (started) return;
  started = true;
  const sub = createRedis();
  sub.psubscribe("kronos:run:*").catch(() => {
    started = false;
  });
  sub.on("pmessage", (_p, channel, message) => bus.emit(channel, message));
}

const TERMINAL = new Set(["done", "error"]);

/**
 * GET /v1/analyses/:id/stream — Server-Sent Events.
 * Events: stage, log, entrypoint, invariant, done, error. Each carries `id` so the browser's automatic
 * reconnect (Last-Event-ID) resumes without gaps. Heartbeat every 15s (Heroku's router drops idle
 * connections after 55s).
 */
export async function streamRun(req: FastifyRequest, reply: FastifyReply, runId: string, runIsFinal: boolean) {
  ensureSubscriber();
  const origin = req.headers.origin;
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...(origin && allowedOrigin(origin) ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : {}),
  });
  res.write("retry: 3000\n\n");

  let lastId = Number(req.headers["last-event-id"] ?? (req.query as Record<string, string>).lastEventId ?? 0) || 0;
  let closed = false;
  const buffered: RunEvent[] = [];
  let replaying = true;

  const send = (ev: RunEvent) => {
    if (closed || ev.id <= lastId) return;
    lastId = ev.id;
    res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    if (!replaying && TERMINAL.has(ev.type)) finish();
  };

  const channel = `kronos:run:${runId}`;
  const onMessage = (raw: string) => {
    const ev = JSON.parse(raw) as RunEvent;
    if (replaying) buffered.push(ev);
    else send(ev);
  };
  bus.on(channel, onMessage);
  const heartbeat = setInterval(() => !closed && res.write(`: ping ${Date.now()}\n\n`), 15_000);

  function finish() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    bus.off(channel, onMessage);
    res.end();
  }
  req.raw.on("close", finish);

  // Replay history from Postgres, then switch to live.
  const rows = await db
    .select()
    .from(schema.runEvents)
    .where(and(eq(schema.runEvents.runId, runId), gt(schema.runEvents.id, lastId)))
    .orderBy(asc(schema.runEvents.id));
  for (const r of rows) {
    send({
      id: r.id,
      runId,
      type: r.type as RunEvent["type"],
      stage: r.stage,
      level: r.level,
      message: r.message,
      payload: r.payload ?? undefined,
      ts: r.ts.toISOString(),
    });
  }
  replaying = false;
  for (const ev of buffered.sort((a, b) => a.id - b.id)) send(ev);
  // A run that is resting (review, failed, packaged) has nothing more to say: end after the replay.
  if (runIsFinal && !closed) finish();
}
