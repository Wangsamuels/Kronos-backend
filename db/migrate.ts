import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

/** Heroku release phase: `node dist/db/migrate.js` runs Drizzle migrations on every deploy. */
const here = path.dirname(fileURLToPath(import.meta.url));
// migrations live in db/migrations (copied next to the compiled file by scripts/copy-assets.mjs)
const migrationsFolder = path.join(here, "migrations");

await migrate(db, { migrationsFolder });
await pool.end();
console.log("migrations applied");
