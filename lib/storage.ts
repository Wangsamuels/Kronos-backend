import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, integrations } from "./env.js";

/**
 * S3-compatible object storage (Cloudflare R2) for source snapshots, packages and reports.
 * Without R2 credentials it stores under LOCAL_STORAGE_DIR and the API serves downloads itself.
 */
let s3: S3Client | undefined;
function client() {
  s3 ??= new S3Client({
    region: "auto",
    endpoint: env.R2_ENDPOINT,
    credentials: { accessKeyId: env.R2_ACCESS_KEY!, secretAccessKey: env.R2_SECRET_KEY! },
  });
  return s3;
}

export async function putObject(key: string, body: Buffer | string, contentType = "application/octet-stream") {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  if (integrations.storage === "r2") {
    await client().send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, Body: buf, ContentType: contentType }));
  } else {
    const p = path.resolve(env.LOCAL_STORAGE_DIR, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buf);
  }
  return { key, sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

export async function getObject(key: string): Promise<Buffer> {
  if (integrations.storage === "r2") {
    const res = await client().send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  return fs.readFile(path.resolve(env.LOCAL_STORAGE_DIR, key));
}

/** A URL the frontend can download from. R2: presigned (1h). Local: the API's own download route. */
export async function downloadUrl(key: string, apiDownloadPath: string): Promise<string> {
  if (integrations.storage === "r2") {
    return getSignedUrl(client(), new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }), { expiresIn: 3600 });
  }
  return `${env.PUBLIC_API_URL ?? ""}${apiDownloadPath}`;
}
