import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env.js";

/** Heroku Key-Value Store uses rediss:// with a self-signed cert. */
export function redisOptions(): RedisOptions {
  const opts: RedisOptions = { maxRetriesPerRequest: null, enableReadyCheck: true };
  if (env.REDIS_URL.startsWith("rediss://")) {
    // Heroku Key-Value Store presents a self-signed certificate; traffic is still TLS-encrypted.
    opts.tls = { rejectUnauthorized: false };
  }
  return opts;
}

export function createRedis(): Redis {
  return new Redis(env.REDIS_URL, redisOptions());
}

let shared: Redis | undefined;
export function redis(): Redis {
  shared ??= createRedis();
  return shared;
}
