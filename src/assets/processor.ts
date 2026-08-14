import sharp from "sharp";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  AssetProcessingStatus,
  StoredFileKind,
  type CommunicationSourceEntityType,
} from "../generated/prisma/enums.js";
import type { AirtableIncrementalSource } from "../airtable/types.js";
import { AIRTABLE_TABLE_IDS } from "../airtable/field-ids.js";
import { parseAttachment, type AirtableAttachment } from "./communication-assets.js";
import type { ObjectStorage } from "./object-storage.js";

const MAX_PROCESSING_ATTEMPTS = 4;
const STALE_PROCESSING_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000] as const;

export type AssetProcessorConfig = {
  maxSourceBytes: number;
  maxDocumentSourceBytes: number;
  maxImagePixels: number;
  portalMaxDimension: number;
  thumbMaxDimension: number;
  portalWebpQuality: number;
  thumbWebpQuality: number;
  concurrency: number;
};

export type StoredFileJob = {
  id: string;
  deliveryId?: string | null;
  role?: string | null;
  sourceAttachmentId: string;
  sourceRecordId: string;
  sourceFieldId: string;
  sourceEntityType: CommunicationSourceEntityType;
  sourceHospitalRecordId: string;
  kind: StoredFileKind;
  originalMimeType: string;
  originalSizeBytes: bigint | null;
  attemptCount: number;
};

export interface AssetProcessorStore {
  claimNext(now: Date): Promise<StoredFileJob | null>;
  markImageReady(id: string, output: {
    portalObjectKey: string; thumbnailObjectKey: string;
    portalSizeBytes: number; thumbnailSizeBytes: number; width: number; height: number;
  }, processedAt: Date): Promise<void>;
  markDocumentReady(id: string, output: {
    documentObjectKey: string; documentSizeBytes: number;
  }, processedAt: Date): Promise<void>;
  markRejected(id: string, status: "REJECTED_TOO_LARGE" | "REJECTED_UNSUPPORTED", code: string, at: Date): Promise<void>;
  markFailed(id: string, code: string, nextAttemptAt: Date | null, at: Date): Promise<void>;
}

export class PrismaAssetProcessorStore implements AssetProcessorStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claimNext(now: Date): Promise<StoredFileJob | null> {
    const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
    for (let tries = 0; tries < 10; tries += 1) {
      const candidate = await this.prisma.storedFile.findFirst({
        where: {
          attemptCount: { lt: MAX_PROCESSING_ATTEMPTS },
          OR: [
            { processingStatus: AssetProcessingStatus.PENDING },
            { processingStatus: AssetProcessingStatus.FAILED, nextAttemptAt: { not: null, lte: now } },
            { processingStatus: AssetProcessingStatus.PROCESSING, processingStartedAt: { lt: staleBefore } },
          ],
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, processingStatus: true, processingStartedAt: true, nextAttemptAt: true },
      });
      if (!candidate) return null;
      const claimed = await this.prisma.storedFile.updateMany({
        where: {
          id: candidate.id,
          attemptCount: { lt: MAX_PROCESSING_ATTEMPTS },
          OR: [
            { processingStatus: AssetProcessingStatus.PENDING },
            { processingStatus: AssetProcessingStatus.FAILED, nextAttemptAt: { not: null, lte: now } },
            { processingStatus: AssetProcessingStatus.PROCESSING, processingStartedAt: { lt: staleBefore } },
          ],
        },
        data: {
          processingStatus: AssetProcessingStatus.PROCESSING,
          processingStartedAt: now,
          nextAttemptAt: null,
          lastErrorCode: null,
          attemptCount: { increment: 1 },
        },
      });
      if (claimed.count !== 1) continue;
      const file = await this.prisma.storedFile.findUniqueOrThrow({
        where: { id: candidate.id },
        select: {
          id: true, sourceAttachmentId: true, sourceRecordId: true, sourceFieldId: true,
          sourceEntityType: true, sourceHospitalRecordId: true, kind: true,
          originalMimeType: true, originalSizeBytes: true, attemptCount: true,
          communicationAssets: {
            take: 1, orderBy: { createdAt: "asc" }, select: { deliveryId: true, role: true },
          },
        },
      });
      const { communicationAssets, ...job } = file;
      return {
        ...job,
        deliveryId: communicationAssets[0]?.deliveryId ?? null,
        role: communicationAssets[0]?.role ?? null,
      };
    }
    return null;
  }

  async markImageReady(id: string, output: Parameters<AssetProcessorStore["markImageReady"]>[1], processedAt: Date) {
    await this.prisma.storedFile.update({ where: { id }, data: {
      processingStatus: AssetProcessingStatus.READY,
      portalObjectKey: output.portalObjectKey,
      thumbnailObjectKey: output.thumbnailObjectKey,
      portalSizeBytes: BigInt(output.portalSizeBytes),
      thumbnailSizeBytes: BigInt(output.thumbnailSizeBytes),
      width: output.width, height: output.height,
      processedAt, processingStartedAt: null, nextAttemptAt: null, lastErrorCode: null,
    } });
  }

  async markDocumentReady(id: string, output: Parameters<AssetProcessorStore["markDocumentReady"]>[1], processedAt: Date) {
    await this.prisma.storedFile.update({ where: { id }, data: {
      processingStatus: AssetProcessingStatus.READY,
      documentObjectKey: output.documentObjectKey,
      documentSizeBytes: BigInt(output.documentSizeBytes),
      processedAt, processingStartedAt: null, nextAttemptAt: null, lastErrorCode: null,
    } });
  }

  async markRejected(id: string, status: "REJECTED_TOO_LARGE" | "REJECTED_UNSUPPORTED", code: string, at: Date) {
    await this.prisma.storedFile.update({ where: { id }, data: {
      processingStatus: status, lastErrorCode: code, processedAt: at,
      processingStartedAt: null, nextAttemptAt: null,
    } });
  }

  async markFailed(id: string, code: string, nextAttemptAt: Date | null, at: Date) {
    await this.prisma.storedFile.update({ where: { id }, data: {
      processingStatus: AssetProcessingStatus.FAILED,
      lastErrorCode: code, processedAt: nextAttemptAt ? null : at,
      processingStartedAt: null, nextAttemptAt,
    } });
  }
}

export interface AttachmentDownloadSource {
  resolve(job: StoredFileJob): Promise<AirtableAttachment>;
}

export class AirtableAttachmentDownloadSource implements AttachmentDownloadSource {
  constructor(private readonly airtable: AirtableIncrementalSource) {}

  async resolve(job: StoredFileJob): Promise<AirtableAttachment> {
    const tableId = job.sourceEntityType === "SERVICE_ORDER"
      ? AIRTABLE_TABLE_IDS.serviceOrders
      : job.sourceEntityType === "INSPECTION"
        ? AIRTABLE_TABLE_IDS.inspections
        : null;
    if (!tableId) throw new Error("ASSET_SOURCE_ENTITY_UNSUPPORTED");
    const record = await this.airtable.fetchRecord(
      tableId, job.sourceRecordId, [job.sourceFieldId],
    );
    const attachments = Array.isArray(record.fields[job.sourceFieldId])
      ? record.fields[job.sourceFieldId] as unknown[] : [];
    for (const value of attachments) {
      const attachment = parseAttachment(value);
      if (attachment?.id === job.sourceAttachmentId) return attachment;
    }
    throw new AssetPermanentError("AIRTABLE_ATTACHMENT_NOT_FOUND", "REJECTED_UNSUPPORTED");
  }
}

export async function runAssetProcessor(input: {
  store: AssetProcessorStore;
  source: AttachmentDownloadSource;
  storage: ObjectStorage;
  config: AssetProcessorConfig;
  now?: () => Date;
  fetchFunction?: typeof fetch;
  log?: (message: string) => void;
}): Promise<{ processed: number }> {
  const now = input.now ?? (() => new Date());
  const jobs = await Promise.all(Array.from({ length: input.config.concurrency }, () =>
    input.store.claimNext(now())));
  const claimed = jobs.filter((job): job is StoredFileJob => job !== null);
  await Promise.all(claimed.map((job) => processAsset({ ...input, job, now })));
  return { processed: claimed.length };
}

async function processAsset(input: {
  store: AssetProcessorStore; source: AttachmentDownloadSource; storage: ObjectStorage;
  config: AssetProcessorConfig; job: StoredFileJob; now: () => Date;
  fetchFunction?: typeof fetch; log?: (message: string) => void;
}): Promise<void> {
  const started = input.now();
  const { job } = input;
  const identity = `storedFileId=${job.id} deliveryId=${job.deliveryId ?? "NONE"} ` +
    `sourceAttachmentId=${job.sourceAttachmentId} role=${job.role ?? "UNKNOWN"}`;
  input.log?.(`COMMUNICATION_ASSET_PROCESSING ${identity} kind=${job.kind} attempt=${job.attemptCount}`);
  try {
    const sourceLimit = job.kind === StoredFileKind.DOCUMENT
      ? input.config.maxDocumentSourceBytes
      : input.config.maxSourceBytes;
    if (job.originalSizeBytes !== null && job.originalSizeBytes > BigInt(sourceLimit)) {
      throw new AssetPermanentError("SOURCE_TOO_LARGE", "REJECTED_TOO_LARGE");
    }
    const attachment = await input.source.resolve(job);
    const source = await downloadLimited(
      attachment.url, sourceLimit, input.fetchFunction ?? fetch,
    );
    if (job.kind === StoredFileKind.IMAGE) {
      const output = await transformImage(source, job.id, input.config, input.storage);
      await input.store.markImageReady(job.id, output, input.now());
      input.log?.(
        `COMMUNICATION_ASSET_READY ${identity} kind=IMAGE attempt=${job.attemptCount} ` +
        `durationMs=${input.now().getTime() - started.getTime()} sourceSizeBytes=${source.byteLength} ` +
        `portalSizeBytes=${output.portalSizeBytes} thumbnailSizeBytes=${output.thumbnailSizeBytes} status=READY`,
      );
      return;
    }
    if (!isPdf(source) || attachment.type !== "application/pdf") {
      throw new AssetPermanentError("DOCUMENT_UNSUPPORTED", "REJECTED_UNSUPPORTED");
    }
    const documentObjectKey = `assets/${job.id}/document`;
    await input.storage.putObject(documentObjectKey, source, "application/pdf");
    await input.store.markDocumentReady(job.id, {
      documentObjectKey, documentSizeBytes: source.byteLength,
    }, input.now());
    input.log?.(
      `COMMUNICATION_ASSET_READY ${identity} kind=DOCUMENT attempt=${job.attemptCount} ` +
      `durationMs=${input.now().getTime() - started.getTime()} sourceSizeBytes=${source.byteLength} ` +
      `outputSizeBytes=${source.byteLength} status=READY`,
    );
  } catch (error: unknown) {
    if (error instanceof AssetPermanentError) {
      await input.store.markRejected(job.id, error.status, error.code, input.now());
      input.log?.(
        `COMMUNICATION_ASSET_REJECTED ${identity} kind=${job.kind} attempt=${job.attemptCount} ` +
        `durationMs=${input.now().getTime() - started.getTime()} status=${error.status} errorCode=${error.code}`,
      );
      return;
    }
    const nextAttemptAt = job.attemptCount < MAX_PROCESSING_ATTEMPTS
      ? new Date(input.now().getTime() + RETRY_DELAYS_MS[job.attemptCount - 1]!) : null;
    await input.store.markFailed(job.id, assetErrorCode(error), nextAttemptAt, input.now());
    input.log?.(
      `COMMUNICATION_ASSET_FAILED ${identity} kind=${job.kind} attempt=${job.attemptCount} ` +
      `durationMs=${input.now().getTime() - started.getTime()} status=FAILED errorCode=${assetErrorCode(error)}`,
    );
  }
}

async function transformImage(
  source: Uint8Array,
  id: string,
  config: AssetProcessorConfig,
  storage: ObjectStorage,
) {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(source, { limitInputPixels: config.maxImagePixels, failOn: "error" }).metadata();
  } catch (error: unknown) {
    if (error instanceof Error && /pixel limit/i.test(error.message)) {
      throw new AssetPermanentError("IMAGE_PIXEL_LIMIT", "REJECTED_TOO_LARGE");
    }
    throw new AssetPermanentError("IMAGE_DECODE_UNSUPPORTED", "REJECTED_UNSUPPORTED");
  }
  if (!metadata.width || !metadata.height || !metadata.format) {
    throw new AssetPermanentError("IMAGE_METADATA_INVALID", "REJECTED_UNSUPPORTED");
  }
  if (metadata.width * metadata.height > config.maxImagePixels) {
    throw new AssetPermanentError("IMAGE_PIXEL_LIMIT", "REJECTED_TOO_LARGE");
  }
  const base = () => sharp(source, { limitInputPixels: config.maxImagePixels, failOn: "error" }).rotate();
  const portal = await base().resize({
    width: config.portalMaxDimension, height: config.portalMaxDimension,
    fit: "inside", withoutEnlargement: true,
  }).webp({ quality: config.portalWebpQuality }).toBuffer({ resolveWithObject: true });
  const thumb = await base().resize({
    width: config.thumbMaxDimension, height: config.thumbMaxDimension,
    fit: "inside", withoutEnlargement: true,
  }).webp({ quality: config.thumbWebpQuality }).toBuffer({ resolveWithObject: true });
  const portalObjectKey = `assets/${id}/portal.webp`;
  const thumbnailObjectKey = `assets/${id}/thumb.webp`;
  await storage.putObject(portalObjectKey, portal.data, "image/webp");
  await storage.putObject(thumbnailObjectKey, thumb.data, "image/webp");
  return {
    portalObjectKey, thumbnailObjectKey,
    portalSizeBytes: portal.data.byteLength,
    thumbnailSizeBytes: thumb.data.byteLength,
    width: portal.info.width, height: portal.info.height,
  };
}

async function downloadLimited(url: string, maxBytes: number, fetchFunction: typeof fetch): Promise<Uint8Array> {
  const response = await fetchFunction(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(`ASSET_DOWNLOAD_HTTP_${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AssetPermanentError("SOURCE_TOO_LARGE", "REJECTED_TOO_LARGE");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AssetPermanentError("SOURCE_TOO_LARGE", "REJECTED_TOO_LARGE");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function isPdf(value: Uint8Array): boolean {
  return value.length >= 5 && String.fromCharCode(...value.slice(0, 5)) === "%PDF-";
}

class AssetPermanentError extends Error {
  constructor(
    readonly code: string,
    readonly status: "REJECTED_TOO_LARGE" | "REJECTED_UNSUPPORTED",
  ) { super(code); }
}

function assetErrorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message.slice(0, 100) : "ASSET_PROCESSING_ERROR";
}
