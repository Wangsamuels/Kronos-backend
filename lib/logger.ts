import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: process.env.DYNO ?? "local" },
  redact: ["req.headers.authorization", "*.privateKey", "*.token"],
});
