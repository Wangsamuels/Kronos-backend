import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../lib/env.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Heroku Postgres requires SSL with a self-signed chain
  ssl: env.DATABASE_SSL || /amazonaws|heroku/.test(env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX ?? 10),
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { schema };
