import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  AssetProcessingStatus,
  AssetSourceProvider,
  CommunicationAssetRole,
  CommunicationSourceEntityType,
  StoredFileKind,
} from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  INSPECTION_ATTACHMENT_FIELDS,
  SERVICE_ORDER_ATTACHMENT_FIELDS,
} from "../airtable/field-ids.js";
import type { AirtableIncrementalSource } from "../airtable/types.js";
import { discoverAttachments, type AllowedField, type DiscoveredAsset } from "./communication-assets.js";

const SERVICE_ORDER_FIELDS: readonly AllowedField[] = [
  { fieldId: SERVICE_ORDER_ATTACHMENT_FIELDS.repairProtocol, role: CommunicationAssetRole.REPAIR_PROTOCOL, kind: StoredFileKind.DOCUMENT },
  { fieldId: SERVICE_ORDER_ATTACHMENT_FIELDS.diagnosticProtocol, role: CommunicationAssetRole.DIAGNOSTIC_PROTOCOL, kind: StoredFileKind.DOCUMENT },
  { fieldId: SERVICE_ORDER_ATTACHMENT_FIELDS.offerPdf, role: CommunicationAssetRole.OTHER_DOCUMENT, kind: StoredFileKind.DOCUMENT },
  { fieldId: SERVICE_ORDER_ATTACHMENT_FIELDS.photo1, role: CommunicationAssetRole.PHOTO, kind: StoredFileKind.IMAGE },
  { fieldId: SERVICE_ORDER_ATTACHMENT_FIELDS.photo2, role: CommunicationAssetRole.PHOTO, kind: StoredFileKind.IMAGE },
];

const INSPECTION_FIELDS: readonly AllowedField[] = [
  { fieldId: INSPECTION_ATTACHMENT_FIELDS.documents, role: CommunicationAssetRole.OTHER_DOCUMENT, kind: StoredFileKind.DOCUMENT },
  { fieldId: INSPECTION_ATTACHMENT_FIELDS.photos, role: CommunicationAssetRole.PHOTO, kind: StoredFileKind.IMAGE },
];

export type CaseAttachmentSyncTarget = {
  sourceRecordId: string;
  sourceHospitalRecordId: string;
  sourceEntityType: CommunicationSourceEntityType;
};

export type CaseAttachmentSyncResult = { discovered: number; created: number; reused: number; removed: number };

export interface CaseAttachmentSyncStore {
  isAuthorized(target: CaseAttachmentSyncTarget): Promise<boolean>;
  synchronize(target: CaseAttachmentSyncTarget, assets: readonly DiscoveredAsset[], now: Date): Promise<CaseAttachmentSyncResult>;
}

export class PrismaCaseAttachmentSyncStore implements CaseAttachmentSyncStore {
  constructor(private readonly prisma: PrismaClient) {}

  async isAuthorized(target: CaseAttachmentSyncTarget): Promise<boolean> {
    const caseType = target.sourceEntityType === CommunicationSourceEntityType.SERVICE_ORDER
      ? "SERVICE_ORDER" : "INSPECTION";
    return await this.prisma.trackedCase.count({ where: {
      caseType, airtableRecordId: target.sourceRecordId,
      sourceHospitalRecordId: target.sourceHospitalRecordId, active: true,
    } }) === 1;
  }

  async synchronize(
    target: CaseAttachmentSyncTarget,
    assets: readonly DiscoveredAsset[],
    now: Date,
  ): Promise<CaseAttachmentSyncResult> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
      let created = 0;
      let reused = 0;
      const activeIds: string[] = [];
      for (const asset of assets) {
        const existing = await tx.storedFile.findUnique({
          where: { sourceProvider_sourceAttachmentId: {
            sourceProvider: AssetSourceProvider.AIRTABLE,
            sourceAttachmentId: asset.sourceAttachmentId,
          } },
          select: { id: true, kind: true },
        });
        if (existing && existing.kind !== asset.kind) throw new Error("ASSET_KIND_MISMATCH");
        const file = await tx.storedFile.upsert({
          where: { sourceProvider_sourceAttachmentId: {
            sourceProvider: AssetSourceProvider.AIRTABLE,
            sourceAttachmentId: asset.sourceAttachmentId,
          } },
          create: {
            sourceProvider: AssetSourceProvider.AIRTABLE,
            sourceAttachmentId: asset.sourceAttachmentId,
            sourceRecordId: asset.sourceRecordId,
            sourceFieldId: asset.sourceFieldId,
            sourceEntityType: asset.sourceEntityType,
            sourceHospitalRecordId: asset.sourceHospitalRecordId,
            kind: asset.kind,
            originalFileName: asset.originalFileName,
            originalMimeType: asset.originalMimeType,
            originalSizeBytes: asset.originalSizeBytes,
          },
          update: {
            originalFileName: asset.originalFileName,
            originalMimeType: asset.originalMimeType,
            originalSizeBytes: asset.originalSizeBytes,
          },
          select: { id: true },
        });
        existing ? reused += 1 : created += 1;
        const link = await tx.caseAsset.upsert({
          where: { sourceEntityType_sourceRecordId_sourceFieldId_storedFileId: {
            sourceEntityType: target.sourceEntityType,
            sourceRecordId: target.sourceRecordId,
            sourceFieldId: asset.sourceFieldId,
            storedFileId: file.id,
          } },
          create: {
            storedFileId: file.id,
            sourceRecordId: target.sourceRecordId,
            sourceFieldId: asset.sourceFieldId,
            sourceEntityType: target.sourceEntityType,
            sourceHospitalRecordId: target.sourceHospitalRecordId,
            role: asset.role,
            displayOrder: asset.displayOrder,
            active: true,
            firstSeenAt: now,
            lastSeenAt: now,
          },
          update: {
            sourceHospitalRecordId: target.sourceHospitalRecordId,
            role: asset.role,
            displayOrder: asset.displayOrder,
            active: true,
            lastSeenAt: now,
            removedAt: null,
          },
          select: { id: true },
        });
        activeIds.push(link.id);
      }
      const removed = await tx.caseAsset.updateMany({
        where: {
          sourceEntityType: target.sourceEntityType,
          sourceRecordId: target.sourceRecordId,
          active: true,
          ...(activeIds.length ? { id: { notIn: activeIds } } : {}),
        },
        data: { active: false, removedAt: now, lastSeenAt: now },
      });
      return { discovered: assets.length, created, reused, removed: removed.count };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error: unknown) {
        if (attempt === 3 || !isConcurrencyConflict(error)) throw error;
      }
    }
    throw new Error("ASSET_SYNC_CONCURRENCY_RETRY_EXHAUSTED");
  }
}

export async function synchronizeCaseAttachments(input: {
  target: CaseAttachmentSyncTarget;
  airtable: AirtableIncrementalSource;
  store: CaseAttachmentSyncStore;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<CaseAttachmentSyncResult> {
  const started = Date.now();
  const safe = logContext(input.target);
  if (!await input.store.isAuthorized(input.target)) {
    input.log?.(`ASSET_SYNC stage=ACCESS_SCOPE ${safe} status=DENIED durationMs=${Date.now() - started} retryable=false errorCategory=SCOPE_MISMATCH`);
    return { discovered: 0, created: 0, reused: 0, removed: 0 };
  }
  const fields = input.target.sourceEntityType === CommunicationSourceEntityType.SERVICE_ORDER
    ? SERVICE_ORDER_FIELDS : INSPECTION_FIELDS;
  const tableId = input.target.sourceEntityType === CommunicationSourceEntityType.SERVICE_ORDER
    ? AIRTABLE_TABLE_IDS.serviceOrders : AIRTABLE_TABLE_IDS.inspections;
  input.log?.(`ASSET_SYNC stage=AIRTABLE_FETCH ${safe} status=STARTED retryable=true`);
  const record = await input.airtable.fetchRecord(tableId, input.target.sourceRecordId,
    fields.map((field) => field.fieldId));
  const assets = discoverAttachments(record, fields, input.target.sourceHospitalRecordId,
    input.target.sourceEntityType);
  input.log?.(`ASSET_SYNC stage=ATTACHMENT_DISCOVERY ${safe} status=SUCCEEDED count=${assets.length} retryable=false`);
  const result = await input.store.synchronize(input.target, assets, input.now?.() ?? new Date());
  input.log?.(`ASSET_SYNC stage=DATABASE_UPDATE ${safe} status=SUCCEEDED discovered=${result.discovered} created=${result.created} reused=${result.reused} removed=${result.removed} durationMs=${Date.now() - started} retryable=false`);
  return result;
}

function logContext(target: CaseAttachmentSyncTarget): string {
  return `sourceRecordId=${safeLogValue(target.sourceRecordId)} kind=${target.sourceEntityType}`;
}

function safeLogValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error.code === "P2034" || error.code === "P2002");
}

export async function scheduleSelectedFailedAssetRetry(input: {
  prisma: PrismaClient;
  storedFileIds: readonly string[];
  now?: Date;
  maxFiles?: number;
}): Promise<number> {
  const ids = [...new Set(input.storedFileIds)].slice(0, input.maxFiles ?? 25);
  if (ids.length === 0) return 0;
  const result = await input.prisma.storedFile.updateMany({
    where: {
      id: { in: ids },
      processingStatus: AssetProcessingStatus.FAILED,
      nextAttemptAt: null,
    },
    data: {
      processingStatus: AssetProcessingStatus.PENDING,
      attemptCount: 0,
      nextAttemptAt: input.now ?? new Date(),
      processingStartedAt: null,
      lastErrorCode: null,
      processedAt: null,
    },
  });
  return result.count;
}
