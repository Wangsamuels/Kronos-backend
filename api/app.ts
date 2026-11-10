import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { env } from "../lib/env.js";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { allowedOrigin } from "./cors.js";
import authRoutes from "./routes/auth.js";
import protocolRoutes from "./routes/protocols.js";
import analysisRoutes from "./routes/analyses.js";
import packageRoutes from "./routes/packages.js";
import dashboardRoutes from "./routes/dashboard.js";
import miscRoutes, { healthRoutes } from "./routes/misc.js";

export async function buildApp() {
  const app = Fastify({ loggerInstance: logger, trustProxy: true }).withTypeProvider<ZodTypeProvider>();
  // Accept POSTs with `content-type: application/json` and an empty body (common from fetch wrappers).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body || (typeof body === "string" && body.trim() === "")) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      (e as { statusCode?: number }).statusCode = 400;
      done(e as Error, undefined);
    }
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowedOrigin(origin)),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Kronos API",
        version: "1.0.0",
        description:
          "Kronos backend: protocol onboarding, AI-assisted guard analysis, review, packaging, deployment verification and monitoring. All errors use {error:{code,message,details?}}.",
      },
      servers: [{ url: env.PUBLIC_API_URL ?? `http://localhost:${env.PORT}` }],
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: err.validation } });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err: err.cause }, "response serialization failed");
      return reply.code(500).send({ error: { code: "SERIALIZATION_ERROR", message: "Response did not match the API contract" } });
    }
    if (err.statusCode === 429) return reply.code(429).send({ error: { code: "RATE_LIMITED", message: err.message } });
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? "BAD_REQUEST", message: err.message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal server error" } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } }));

  await app.register(healthRoutes);
  await app.register(
    async (v1) => {
      await v1.register(authRoutes);
      await v1.register(miscRoutes);
      await v1.register(protocolRoutes);
      await v1.register(analysisRoutes);
      await v1.register(packageRoutes);
      await v1.register(dashboardRoutes);
    },
    { prefix: "/v1" },
  );
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  app.get("/", { schema: { hide: true } }, async () => ({ name: "kronos-api", docs: "/openapi.json", health: "/healthz" }));
  return app;
}
