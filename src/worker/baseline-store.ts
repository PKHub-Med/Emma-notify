import {
  Prisma,
  type PrismaClient,
} from "../generated/prisma/client.js";
import {
  SyncEntityType,
  SyncStatus,
} from "../generated/prisma/enums.js";
import type { MappedCase } from "../airtable/mappers.js";
import type { ResolvedRecipient } from "../airtable/recipient.js";

export type BaselineEntityType =
  | typeof SyncEntityType.CONTACT
  | typeof SyncEntityType.SERVICE_ORDER
  | typeof SyncEntityType.INSPECTION;

export type BaselineSafetyCounts = {
  caseEvents: number;
  notificationBuffers: number;
  bufferItems: number;
};

export interface BaselineStore {
  getCompletionState(entityTypes: readonly BaselineEntityType[]): Promise<boolean[]>;
  markRunning(entityTypes: readonly BaselineEntityType[], at: Date): Promise<void>;
  upsertCase(mappedCase: MappedCase, seenAt: Date): Promise<string>;
  syncRecipients(
    trackedCaseId: string,
    recipients: readonly ResolvedRecipient[],
    seenAt: Date,
  ): Promise<void>;
  getSafetyCounts(): Promise<BaselineSafetyCounts>;
  markCompleted(entityTypes: readonly BaselineEntityType[], at: Date): Promise<void>;
  markFailed(entityTypes: readonly BaselineEntityType[], at: Date): Promise<void>;
  setWorkerLastSync(at: Date): Promise<void>;
}

export class PrismaBaselineStore implements BaselineStore {
  constructor(private readonly prisma: PrismaClient) {}

  async getCompletionState(
    entityTypes: readonly BaselineEntityType[],
  ): Promise<boolean[]> {
    const states = await Promise.all(
      entityTypes.map((entityType) =>
        this.prisma.syncState.upsert({
          where: {
            source_entityType: { source: "AIRTABLE", entityType },
          },
          create: {
            source: "AIRTABLE",
            entityType,
            status: SyncStatus.IDLE,
          },
          update: {},
          select: { baselineCompletedAt: true },
        }),
      ),
    );
    return states.map((state) => state.baselineCompletedAt !== null);
  }

  async markRunning(
    entityTypes: readonly BaselineEntityType[],
    at: Date,
  ): Promise<void> {
    await Promise.all(
      entityTypes.map((entityType) =>
        this.prisma.syncState.update({
          where: {
            source_entityType: { source: "AIRTABLE", entityType },
          },
          data: {
            status: SyncStatus.RUNNING,
            lastAttemptAt: at,
            lastError: null,
          },
        }),
      ),
    );
  }

  async upsertCase(mappedCase: MappedCase, seenAt: Date): Promise<string> {
    const {
      contactRecordIds: _contactRecordIds,
      invalidDueDate: _invalidDueDate,
      sourceSnapshot,
      ...caseData
    } = mappedCase;
    const data = {
      ...caseData,
      sourceSnapshot: sourceSnapshot as Prisma.InputJsonObject,
      lastSeenAt: seenAt,
      active: true,
    };
    const trackedCase = await this.prisma.trackedCase.upsert({
      where: {
        caseType_airtableRecordId: {
          caseType: mappedCase.caseType,
          airtableRecordId: mappedCase.airtableRecordId,
        },
      },
      create: data,
      update: data,
      select: { id: true },
    });
    return trackedCase.id;
  }

  async syncRecipients(
    trackedCaseId: string,
    recipients: readonly ResolvedRecipient[],
    seenAt: Date,
  ): Promise<void> {
    await Promise.all(
      recipients.map((recipient) =>
        this.prisma.caseRecipient.upsert({
          where: {
            trackedCaseId_airtableContactRecordId: {
              trackedCaseId,
              airtableContactRecordId: recipient.airtableContactRecordId,
            },
          },
          create: {
            trackedCaseId,
            ...recipient,
            firstSeenAt: seenAt,
            lastSeenAt: seenAt,
          },
          update: {
            name: recipient.name,
            email: recipient.email,
            normalizedEmail: recipient.normalizedEmail,
            eligible: recipient.eligible,
            eligibilityReason: recipient.eligibilityReason,
            resolutionSource: recipient.resolutionSource,
            lastSeenAt: seenAt,
          },
        }),
      ),
    );

    await this.prisma.caseRecipient.deleteMany({
      where: {
        trackedCaseId,
        ...(recipients.length > 0
          ? {
              airtableContactRecordId: {
                notIn: recipients.map((recipient) => recipient.airtableContactRecordId),
              },
            }
          : {}),
      },
    });
  }

  async getSafetyCounts(): Promise<BaselineSafetyCounts> {
    const [caseEvents, notificationBuffers, bufferItems] = await Promise.all([
      this.prisma.caseEvent.count(),
      this.prisma.notificationBuffer.count(),
      this.prisma.bufferItem.count(),
    ]);
    return { caseEvents, notificationBuffers, bufferItems };
  }

  async markCompleted(
    entityTypes: readonly BaselineEntityType[],
    at: Date,
  ): Promise<void> {
    await Promise.all(
      entityTypes.map((entityType) =>
        this.prisma.syncState.update({
          where: {
            source_entityType: { source: "AIRTABLE", entityType },
          },
          data: {
            status: SyncStatus.IDLE,
            lastSuccessfulSyncAt: at,
            baselineCompletedAt: at,
            lastError: null,
          },
        }),
      ),
    );
  }

  async markFailed(
    entityTypes: readonly BaselineEntityType[],
    at: Date,
  ): Promise<void> {
    await Promise.all(
      entityTypes.map((entityType) =>
        this.prisma.syncState.update({
          where: {
            source_entityType: { source: "AIRTABLE", entityType },
          },
          data: {
            status: SyncStatus.ERROR,
            lastAttemptAt: at,
            lastError: "Baseline synchronization failed",
          },
        }),
      ),
    );
  }

  async setWorkerLastSync(at: Date): Promise<void> {
    await this.prisma.workerState.update({
      where: { id: "main" },
      data: { lastSyncAt: at },
    });
  }
}
