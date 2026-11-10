import { buildApp } from "./app.js";
import { env } from "../lib/env.js";
import { pool } from "../db/client.js";

const app = await buildApp();
await app.listen({ port: env.PORT, host: "0.0.0.0" });

const shutdown = async (sig: string) => {
  app.log.info({ sig }, "shutting down");
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
