import {
  Prisma,
  type PrismaClient,
} from "../generated/prisma/client.js";
import {
  BufferStatus,
  EventType,
  SyncEntityType,
  SyncStatus,
} from "../generated/prisma/enums.js";
import type { MappedCase } from "../airtable/mappers.js";
import type { ResolvedRecipient } from "../airtable/recipient.js";
import {
  calculateSendAfter,
  normalizeStatus,
} from "./notification-domain.js";
import {
  PrismaBaselineStore,
  synchronizeCaseDeviceRelations,
} from "./baseline-store.js";

export type IncrementalEntityType =
  | typeof SyncEntityType.SERVICE_ORDER
  | typeof SyncEntityType.INSPECTION;

export type StoredCase = {
  id: string;
  currentStatus: string | null;
};

export type StatusChangeCommand = {
  trackedCaseId: string;
  mappedCase: MappedCase;
  eventType:
    | typeof EventType.SERVICE_STATUS_CHANGED
    | typeof EventType.INSPECTION_STATUS_CHANGED;
  oldStatus: string | null;
  newStatus: string | null;
  fingerprint: string;
  detectedAt: Date;
  quietMinutes: number;
};

export type StatusChangeResult = {
  duplicate: boolean;
  withoutRecipient: boolean;
  buffersCreated: number;
  buffersReset: number;
  bufferItemsCreated: number;
};

export interface IncrementalStore {
  getCheckpoint(entityType: IncrementalEntityType): Promise<Date | null>;
  markRunning(entityType: IncrementalEntityType, at: Date): Promise<void>;
  markSuccessful(entityType: IncrementalEntityType, at: Date): Promise<void>;
  markFailed(entityType: IncrementalEntityType, at: Date): Promise<void>;
  findCase(mappedCase: MappedCase): Promise<StoredCase | null>;
  upsertCaseWithoutEvent(mappedCase: MappedCase, seenAt: Date): Promise<string>;
  syncRecipients(
    trackedCaseId: string,
    recipients: readonly ResolvedRecipient[],
    seenAt: Date,
  ): Promise<void>;
  processStatusChange(command: StatusChangeCommand): Promise<StatusChangeResult>;
  markExpiredBuffersReady(now: Date): Promise<number>;
  setWorkerLastSync(at: Date): Promise<void>;
}

export class PrismaIncrementalStore implements IncrementalStore {
  private readonly baselineStore: PrismaBaselineStore;

  constructor(private readonly prisma: PrismaClient) {
    this.baselineStore = new PrismaBaselineStore(prisma);
  }

  async getCheckpoint(entityType: IncrementalEntityType): Promise<Date | null> {
    const state = await this.prisma.syncState.findUnique({
      where: { source_entityType: { source: "AIRTABLE", entityType } },
      select: { baselineCompletedAt: true, lastSuccessfulSyncAt: true },
    });
    if (!state?.baselineCompletedAt) return null;
    return state.lastSuccessfulSyncAt ?? state.baselineCompletedAt;
  }

  async markRunning(entityType: IncrementalEntityType, at: Date): Promise<void> {
    await this.prisma.syncState.update({
      where: { source_entityType: { source: "AIRTABLE", entityType } },
      data: { status: SyncStatus.RUNNING, lastAttemptAt: at, lastError: null },
    });
  }

  async markSuccessful(entityType: IncrementalEntityType, at: Date): Promise<void> {
    await this.prisma.syncState.update({
      where: { source_entityType: { source: "AIRTABLE", entityType } },
      data: {
        status: SyncStatus.IDLE,
        lastSuccessfulSyncAt: at,
        lastError: null,
      },
    });
  }

  async markFailed(entityType: IncrementalEntityType, at: Date): Promise<void> {
    await this.prisma.syncState.update({
      where: { source_entityType: { source: "AIRTABLE", entityType } },
      data: {
        status: SyncStatus.ERROR,
        lastAttemptAt: at,
        lastError: "Incremental synchronization failed",
      },
    });
  }

  async findCase(mappedCase: MappedCase): Promise<StoredCase | null> {
    return this.prisma.trackedCase.findUnique({
      where: {
        caseType_airtableRecordId: {
          caseType: mappedCase.caseType,
          airtableRecordId: mappedCase.airtableRecordId,
        },
      },
      select: { id: true, currentStatus: true },
    });
  }

  async upsertCaseWithoutEvent(mappedCase: MappedCase, seenAt: Date): Promise<string> {
    return this.baselineStore.upsertCase(mappedCase, seenAt);
  }

  async syncRecipients(
    trackedCaseId: string,
    recipients: readonly ResolvedRecipient[],
    seenAt: Date,
  ): Promise<void> {
    await this.baselineStore.syncRecipients(trackedCaseId, recipients, seenAt);
  }

  async processStatusChange(command: StatusChangeCommand): Promise<StatusChangeResult> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (transaction) =>
          this.processInTransaction(transaction, command));
      } catch (error: unknown) {
        if (!isUniqueConstraintError(error)) throw error;
        const duplicate = await this.prisma.caseEvent.findUnique({
          where: { eventFingerprint: command.fingerprint },
          select: { id: true },
        });
        if (duplicate) return duplicateResult();
        if (attempt === 3) throw error;
      }
    }
    return duplicateResult();
  }

  async markExpiredBuffersReady(now: Date): Promise<number> {
    const result = await this.prisma.notificationBuffer.updateMany({
      where: {
        status: BufferStatus.OPEN,
        sendAfter: { lte: now },
      },
      data: {
        status: BufferStatus.READY,
        activeRecipientKey: null,
      },
    });
    return result.count;
  }

  async setWorkerLastSync(at: Date): Promise<void> {
    await this.baselineStore.setWorkerLastSync(at);
  }

  private async processInTransaction(
    transaction: Prisma.TransactionClient,
    command: StatusChangeCommand,
  ): Promise<StatusChangeResult> {
    const currentCase = await transaction.trackedCase.findUniqueOrThrow({
      where: { id: command.trackedCaseId },
      select: { currentStatus: true },
    });
    if (
      normalizeStatus(currentCase.currentStatus) === normalizeStatus(command.newStatus)
    ) {
      return duplicateResult();
    }

    await transaction.caseEvent.create({
      data: {
        trackedCaseId: command.trackedCaseId,
        eventType: command.eventType,
        fieldName: "STATUS",
        oldValue: command.oldStatus ?? Prisma.JsonNull,
        newValue: command.newStatus ?? Prisma.JsonNull,
        triggersNotification: true,
        visibleToCustomer: true,
        eventFingerprint: command.fingerprint,
        sourceModifiedAt: command.mappedCase.sourceModifiedAt,
        detectedAt: command.detectedAt,
      },
    });

    await transaction.trackedCase.update({
      where: { id: command.trackedCaseId },
      data: mappedCaseUpdate(command.mappedCase, command.detectedAt),
    });
    await synchronizeCaseDeviceRelations(transaction, {
      trackedCaseId: command.trackedCaseId,
      deviceAirtableIds: command.mappedCase.deviceAirtableIds,
    });
    if (command.mappedCase.caseType === "SERVICE_ORDER") {
      await transaction.trackedCase.update({
        where: { id: command.trackedCaseId },
        data: {
          sourceHospitalRecordId: command.mappedCase.sourceHospitalRecordId,
        },
      });
    }

    const recipients = await transaction.caseRecipient.findMany({
      where: {
        trackedCaseId: command.trackedCaseId,
        eligible: true,
        normalizedEmail: { not: null },
      },
      select: { name: true, email: true, normalizedEmail: true },
    });
    const uniqueRecipients = new Map(
      recipients
        .filter((recipient) => recipient.normalizedEmail !== null)
        .map((recipient) => [recipient.normalizedEmail!, recipient]),
    );

    let buffersCreated = 0;
    let buffersReset = 0;
    let bufferItemsCreated = 0;
    const sendAfter = calculateSendAfter(command.detectedAt, command.quietMinutes);

    for (const [normalizedEmail, recipient] of uniqueRecipients) {
      let buffer = await transaction.notificationBuffer.findUnique({
        where: { activeRecipientKey: normalizedEmail },
        select: { id: true },
      });

      if (buffer) {
        const reset = await transaction.notificationBuffer.updateMany({
          where: { id: buffer.id, status: BufferStatus.OPEN },
          data: { lastTriggerAt: command.detectedAt, sendAfter },
        });
        if (reset.count > 0) {
          buffersReset += 1;
        } else {
          buffer = null;
        }
      }

      if (!buffer) {
        buffer = await transaction.notificationBuffer.create({
          data: {
            recipientName: recipient.name,
            recipientEmail: recipient.email ?? normalizedEmail,
            normalizedEmail,
            status: BufferStatus.OPEN,
            firstTriggerAt: command.detectedAt,
            lastTriggerAt: command.detectedAt,
            sendAfter,
            activeRecipientKey: normalizedEmail,
          },
          select: { id: true },
        });
        buffersCreated += 1;
      }

      const existingItem = await transaction.bufferItem.findUnique({
        where: {
          bufferId_trackedCaseId: {
            bufferId: buffer.id,
            trackedCaseId: command.trackedCaseId,
          },
        },
        select: { id: true },
      });
      await transaction.bufferItem.upsert({
        where: {
          bufferId_trackedCaseId: {
            bufferId: buffer.id,
            trackedCaseId: command.trackedCaseId,
          },
        },
        create: {
          bufferId: buffer.id,
          trackedCaseId: command.trackedCaseId,
          firstEventAt: command.detectedAt,
          lastEventAt: command.detectedAt,
        },
        update: { lastEventAt: command.detectedAt },
      });
      if (!existingItem) bufferItemsCreated += 1;
    }

    return {
      duplicate: false,
      withoutRecipient: uniqueRecipients.size === 0,
      buffersCreated,
      buffersReset,
      bufferItemsCreated,
    };
  }
}

function mappedCaseUpdate(mappedCase: MappedCase, seenAt: Date) {
  const {
    contactRecordIds: _contactRecordIds,
    invalidDueDate: _invalidDueDate,
    caseType: _caseType,
    airtableRecordId: _airtableRecordId,
    deviceAirtableIds: _deviceAirtableIds,
    sourceHospitalRecordId: _sourceHospitalRecordId,
    sourceSnapshot,
    ...data
  } = mappedCase;
  return {
    ...data,
    sourceSnapshot: sourceSnapshot as Prisma.InputJsonObject,
    lastSeenAt: seenAt,
    active: true,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

function duplicateResult(): StatusChangeResult {
  return {
    duplicate: true,
    withoutRecipient: false,
    buffersCreated: 0,
    buffersReset: 0,
    bufferItemsCreated: 0,
  };
}
