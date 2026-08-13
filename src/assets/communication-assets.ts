import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationAssetRole,
  CommunicationScenario,
  CommunicationSourceEntityType,
  StoredFileKind,
} from "../generated/prisma/enums.js";
import { AIRTABLE_TABLE_IDS, SERVICE_ORDER_ATTACHMENT_FIELDS } from "../airtable/field-ids.js";
import type { AirtableIncrementalSource, AirtableRecord } from "../airtable/types.js";

export type CommunicationAssetDelivery = {
  id: string;
  scenario: CommunicationScenario;
  sourceRecordId: string;
  eventSnapshot: unknown;
};

export type DiscoveredAsset = {
  sourceAttachmentId: string;
  sourceRecordId: string;
  sourceFieldId: string;
  sourceEntityType: CommunicationSourceEntityType;
  sourceHospitalRecordId: string;
  kind: StoredFileKind;
  role: CommunicationAssetRole;
  displayOrder: number;
  originalFileName: string;
  originalMimeType: string;
  originalSizeBytes: bigint | null;
};

export type RegisteredAsset = {
  storedFileId: string;
  reused: boolean;
  status: string;
};

export interface CommunicationAssetRegistrationStore {
  register(deliveryId: string, assets: readonly DiscoveredAsset[]): Promise<RegisteredAsset[]>;
}

export class PrismaCommunicationAssetRegistrationStore implements CommunicationAssetRegistrationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async register(deliveryId: string, assets: readonly DiscoveredAsset[]): Promise<RegisteredAsset[]> {
    return this.prisma.$transaction(async (transaction) => {
      const result: RegisteredAsset[] = [];
      for (const asset of assets) {
        const existing = await transaction.storedFile.findUnique({
          where: { sourceAttachmentId: asset.sourceAttachmentId },
          select: {
            id: true, processingStatus: true, sourceHospitalRecordId: true,
            sourceRecordId: true, sourceFieldId: true,
          },
        });
        const storedFile = await transaction.storedFile.upsert({
          where: { sourceAttachmentId: asset.sourceAttachmentId },
          create: {
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
          update: {},
          select: {
            id: true, processingStatus: true, sourceHospitalRecordId: true,
            sourceRecordId: true, sourceFieldId: true,
          },
        });
        if (storedFile.sourceHospitalRecordId !== asset.sourceHospitalRecordId ||
          storedFile.sourceRecordId !== asset.sourceRecordId ||
          storedFile.sourceFieldId !== asset.sourceFieldId) {
          throw new Error("ASSET_SOURCE_SCOPE_MISMATCH");
        }
        await transaction.communicationAsset.upsert({
          where: {
            deliveryId_storedFileId_role: {
              deliveryId, storedFileId: storedFile.id, role: asset.role,
            },
          },
          create: {
            deliveryId, storedFileId: storedFile.id,
            role: asset.role, displayOrder: asset.displayOrder,
          },
          update: { displayOrder: asset.displayOrder },
        });
        result.push({
          storedFileId: storedFile.id,
          reused: Boolean(existing),
          status: storedFile.processingStatus,
        });
      }
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

type AllowedField = { fieldId: string; role: CommunicationAssetRole };

const ASSET_FIELD_ALLOWLIST: Partial<Record<CommunicationScenario, readonly AllowedField[]>> = {
  [CommunicationScenario.REPAIR_COMPLETED]: [
    { fieldId: SERVICE_ORDER_ATTACHMENT_FIELDS.repairProtocol, role: CommunicationAssetRole.REPAIR_PROTOCOL },
    { fieldId: SERVICE_ORDER_ATTACHMENT_FIELDS.diagnosticProtocol, role: CommunicationAssetRole.DIAGNOSTIC_PROTOCOL },
  ],
};

export class CommunicationAssetResolver {
  constructor(
    private readonly airtable: AirtableIncrementalSource,
    private readonly store: CommunicationAssetRegistrationStore,
    private readonly log?: (message: string) => void,
  ) {}

  async resolve(delivery: CommunicationAssetDelivery): Promise<RegisteredAsset[]> {
    const fields = ASSET_FIELD_ALLOWLIST[delivery.scenario] ?? [];
    if (fields.length === 0) return [];
    const sourceHospitalRecordId = snapshotString(delivery.eventSnapshot, "sourceHospitalRecordId");
    if (!sourceHospitalRecordId) throw new Error("ASSET_HOSPITAL_SCOPE_MISSING");
    const record = await this.airtable.fetchRecord(
      AIRTABLE_TABLE_IDS.serviceOrders,
      delivery.sourceRecordId,
      fields.map((field) => field.fieldId),
    );
    const discovered = discoverAttachments(record, fields, sourceHospitalRecordId);
    const registered = await this.store.register(delivery.id, discovered);
    registered.forEach((asset, index) => {
      const source = discovered[index]!;
      this.log?.(
        `${asset.reused ? "COMMUNICATION_ASSET_REUSED" : "COMMUNICATION_ASSET_DISCOVERED"} ` +
        `storedFileId=${asset.storedFileId} deliveryId=${delivery.id} kind=${source.kind} ` +
        `role=${source.role} status=${asset.status}`,
      );
    });
    return registered;
  }
}

export function discoverAttachments(
  record: AirtableRecord,
  fields: readonly AllowedField[],
  sourceHospitalRecordId: string,
): DiscoveredAsset[] {
  const result: DiscoveredAsset[] = [];
  for (const field of fields) {
    const attachments = Array.isArray(record.fields[field.fieldId])
      ? record.fields[field.fieldId] as unknown[] : [];
    for (const value of attachments) {
      const attachment = parseAttachment(value);
      if (!attachment) continue;
      result.push({
        sourceAttachmentId: attachment.id,
        sourceRecordId: record.id,
        sourceFieldId: field.fieldId,
        sourceEntityType: CommunicationSourceEntityType.SERVICE_ORDER,
        sourceHospitalRecordId,
        kind: attachment.type.startsWith("image/") ? StoredFileKind.IMAGE : StoredFileKind.DOCUMENT,
        role: field.role,
        displayOrder: result.length,
        originalFileName: attachment.filename,
        originalMimeType: attachment.type,
        originalSizeBytes: attachment.size === null ? null : BigInt(attachment.size),
      });
    }
  }
  return result;
}

export type AirtableAttachment = {
  id: string;
  url: string;
  filename: string;
  type: string;
  size: number | null;
};

export function parseAttachment(value: unknown): AirtableAttachment | null {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.url !== "string" ||
    typeof value.filename !== "string" || typeof value.type !== "string") return null;
  const size = typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0
    ? value.size : null;
  return { id: value.id, url: value.url, filename: value.filename, type: value.type, size };
}

function snapshotString(snapshot: unknown, key: string): string | null {
  return isObject(snapshot) && typeof snapshot[key] === "string" && snapshot[key].trim()
    ? snapshot[key].trim() : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
