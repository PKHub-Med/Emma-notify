import "dotenv/config";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { AirtableClient } from "../airtable/client.js";
import { createS3ObjectStorage } from "../assets/object-storage.js";

if (process.env.ASSET_PROBE_APPROVED !== "true") throw new Error("ASSET_PROBE_APPROVED=true is required");
const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const airtable = new AirtableClient({
  baseId: required("AIRTABLE_BASE_ID"),
  personalAccessToken: required("AIRTABLE_PAT"),
});
const storage = createS3ObjectStorage({
  storageEndpoint: required("RAILWAY_STORAGE_ENDPOINT"),
  storageRegion: process.env.RAILWAY_STORAGE_REGION?.trim() || "auto",
  storageBucket: required("RAILWAY_STORAGE_BUCKET"),
  storageAccessKeyId: required("RAILWAY_STORAGE_ACCESS_KEY_ID"),
  storageSecretAccessKey: required("RAILWAY_STORAGE_SECRET_ACCESS_KEY"),
  storageForcePathStyle: process.env.RAILWAY_STORAGE_FORCE_PATH_STYLE === "true",
});
const tableId = required("ASSET_PROBE_TABLE_ID");
const recordId = required("ASSET_PROBE_RECORD_ID");
const fieldId = required("ASSET_PROBE_FIELD_ID");
const attachmentId = required("ASSET_PROBE_ATTACHMENT_ID");
const record = await airtable.fetchRecord(tableId, recordId, [fieldId]);
const values = Array.isArray(record.fields[fieldId]) ? record.fields[fieldId] as unknown[] : [];
const attachment = values.find((value): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && (value as Record<string, unknown>).id === attachmentId);
if (!attachment || typeof attachment.url !== "string" || typeof attachment.type !== "string") {
  throw new Error("Selected attachment was not found");
}
const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`Attachment download failed with HTTP ${response.status}`);
const source = new Uint8Array(await response.arrayBuffer());
const isImage = attachment.type.startsWith("image/");
const body = isImage ? await sharp(source).rotate().resize({ width: 64, height: 64, fit: "inside" })
  .webp({ quality: 70 }).toBuffer() : source;
const contentType = isImage ? "image/webp" : attachment.type;
const key = `integration-probes/${randomUUID()}`;
try {
  await storage.putObject(key, body, contentType);
  const head = await storage.headObject(key);
  if (!head || head.sizeBytes !== body.byteLength) throw new Error("Storage verification failed");
  console.info(`ASSET_INTEGRATION_PROBE status=SUCCEEDED kind=${isImage ? "IMAGE" : "DOCUMENT"} bytes=${body.byteLength}`);
} finally {
  await storage.deleteObject(key).catch(() => undefined);
}
