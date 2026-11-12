import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, integrations } from "./env.js";
import { db, schema } from "../db/client.js";
import { notFound } from "./errors.js";
import { logger } from "./logger.js";

/**
 * Object storage for source snapshots, packages and reports.
 *   - R2 (S3-compatible) when R2_* is configured: recommended for production
 *   - otherwise Postgres (`blobs` table): works on Heroku, where web and worker dynos don't share a disk
 */
let s3: S3Client | undefined;
function client() {
  s3 ??= new S3Client({
    region: "auto",
    // Accept the S3 API URL exactly as Cloudflare shows it, with or without a trailing "/<bucket>".
    endpoint: r2Endpoint(env.R2_ENDPOINT!),
    // Path-style (<endpoint>/<bucket>/<key>): R2's TLS certificate doesn't cover <bucket>.<account>.r2.cloudflarestorage.com,
    // so virtual-hosted style fails with an SSL handshake error.
    forcePathStyle: true,
    credentials: { accessKeyId: env.R2_ACCESS_KEY!, secretAccessKey: env.R2_SECRET_KEY! },
  });
  return s3;
}

export async function putObject(key: string, body: Buffer | string, contentType = "application/octet-stream") {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  let toPostgres = integrations.storage !== "r2";
  if (!toPostgres) {
    try {
      await client().send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, Body: buf, ContentType: contentType }));
    } catch (e) {
      // R2 misconfigured or down: keep the pipeline running on the Postgres fallback (reads and downloads already
      // check Postgres for keys R2 doesn't have).
      logger.error({ err: (e as Error).message, key }, "R2 upload failed; stored the object in Postgres instead. Check R2_ENDPOINT / keys");
      toPostgres = true;
    }
  }
  if (toPostgres) {
    await db
      .insert(schema.blobs)
      .values({ key, data: buf, contentType, bytes: buf.length })
      .onConflictDoUpdate({ target: schema.blobs.key, set: { data: buf, contentType, bytes: buf.length } });
  }
  return { key, sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

export async function getObject(key: string): Promise<Buffer> {
  if (integrations.storage === "r2") {
    try {
      const res = await client().send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    } catch (e) {
      // Objects written before R2 was configured live in Postgres: fall back to them.
      const [old] = await db.select({ data: schema.blobs.data }).from(schema.blobs).where(eq(schema.blobs.key, key));
      if (old) return Buffer.from(old.data);
      throw e;
    }
  }
  const [row] = await db.select({ data: schema.blobs.data }).from(schema.blobs).where(eq(schema.blobs.key, key));
  if (!row) throw notFound(`Object ${key}`);
  return Buffer.from(row.data);
}

/**
 * Normalizes R2_ENDPOINT to https://<account id>[.eu|.fedramp].r2.cloudflarestorage.com. Accepts the S3 API URL as
 * the dashboard shows it (with "/<bucket>"), a "<bucket>.<account>..." host, or a bare 32-hex account id. Any other
 * host under r2.cloudflarestorage.com makes Cloudflare abort the TLS handshake ("sslv3 alert handshake failure").
 */
export function r2Endpoint(raw: string): string {
  const v = raw.trim();
  if (/^[0-9a-f]{32}$/i.test(v)) return `https://${v.toLowerCase()}.r2.cloudflarestorage.com`;
  const u = new URL(/^https?:\/\//.test(v) ? v : `https://${v}`);
  const m = u.hostname.toLowerCase().match(/(?:^|\.)([0-9a-f]{32})((?:\.eu|\.fedramp)?)\.r2\.cloudflarestorage\.com$/);
  if (m) return `https://${m[1]}${m[2]}.r2.cloudflarestorage.com`;
  if (u.hostname.endsWith("r2.cloudflarestorage.com")) {
    throw new Error(`R2_ENDPOINT host "${u.hostname}" has no 32-character account id; use https://<ACCOUNT_ID>.r2.cloudflarestorage.com (Cloudflare dashboard → R2 → Account details)`);
  }
  return `${u.protocol}//${u.host}`; // custom S3-compatible endpoint (e.g. MinIO in tests)
}

/** A URL the frontend can download from. R2: presigned (1h). Postgres: the API's own download route. */
export async function downloadUrl(key: string, apiDownloadPath: string): Promise<string> {
  if (integrations.storage === "r2") {
    const [old] = await db.select({ key: schema.blobs.key }).from(schema.blobs).where(eq(schema.blobs.key, key));
    if (old) return `${env.PUBLIC_API_URL ?? ""}${apiDownloadPath}`; // written before R2: served by the API
    return getSignedUrl(client(), new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }), { expiresIn: 3600 });
  }
  return `${env.PUBLIC_API_URL ?? ""}${apiDownloadPath}`;
}
