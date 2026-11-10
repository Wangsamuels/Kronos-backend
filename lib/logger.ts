import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: process.env.DYNO ?? "local" },
  redact: ["req.headers.authorization", "req.headers.cookie", "*.privateKey", "*.token"],
  serializers: {
    // Never log tokens passed in query strings (SSE ?token=, GitHub ?linkToken=, downloads).
    req: (req: { method?: string; url?: string; host?: string; ip?: string }) => ({
      method: req.method,
      url: req.url?.replace(/([?&](?:token|linkToken|code|state)=)[^&]*/g, "$1***"),
      host: req.host,
      remoteAddress: req.ip,
    }),
  },
});
