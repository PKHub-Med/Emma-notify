import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  BufferStatus,
  DigestStatus,
  DigestType,
} from "../generated/prisma/enums.js";
import {
  buildCaseSnapshot,
  buildDigestChanges,
  buildDigestSubject,
} from "./digest-domain.js";

export type DigestCreationResult =
  | { outcome: "CREATED"; digestId: string; itemsCount: number }
  | { outcome: "ALREADY_EXISTS"; digestId: string }
  | { outcome: "NOT_READY" };

export interface DigestStore {
  findReadyBufferIds(limit: number): Promise<string[]>;
  createDigestFromBuffer(
    bufferId: string,
    emailMode: "TEST" | "PRODUCTION",
  ): Promise<DigestCreationResult>;
}

export class PrismaDigestStore implements DigestStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findReadyBufferIds(limit: number): Promise<string[]> {
    const buffers = await this.prisma.notificationBuffer.findMany({
      where: { status: BufferStatus.READY },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true },
    });
    return buffers.map((buffer) => buffer.id);
  }

  async createDigestFromBuffer(
    bufferId: string,
    emailMode: "TEST" | "PRODUCTION",
  ): Promise<DigestCreationResult> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const buffer = await transaction.notificationBuffer.findUnique({
              where: { id: bufferId },
              select: {
                id: true,
                status: true,
                recipientName: true,
                recipientEmail: true,
                normalizedEmail: true,
                items: {
                  orderBy: { createdAt: "asc" },
                  select: {
                    trackedCaseId: true,
                    firstEventAt: true,
                    lastEventAt: true,
                    trackedCase: {
                      select: {
                        caseType: true,
                        airtableRecordId: true,
                        businessNumber: true,
                        clientOrderNumber: true,
                        caseSubtype: true,
                        caseLocation: true,
                        hospitalName: true,
                        devices: {
                          orderBy: { deviceAirtableId: "asc" },
                          select: { deviceAirtableId: true },
                        },
                        deviceName: true,
                        manufacturer: true,
                        model: true,
                        serialNumber: true,
                        inventoryNumber: true,
                        currentStatus: true,
                        faultDescription: true,
                        inspectionDueDate: true,
                        inspectionScheduledDate: true,
                        inspectionBookingStatus: true,
                        sourceModifiedAt: true,
                      },
                    },
                  },
                },
              },
            });

            if (!buffer || buffer.status !== BufferStatus.READY) {
              return { outcome: "NOT_READY" };
            }

            const existing = await transaction.digest.findUnique({
              where: { sourceBufferId: buffer.id },
              select: { id: true },
            });
            if (existing) {
              await closeReadyBuffer(transaction, buffer.id);
              return { outcome: "ALREADY_EXISTS", digestId: existing.id };
            }

            const digest = await transaction.digest.create({
              data: {
                type: DigestType.CASE_DIGEST,
                status: DigestStatus.CREATED,
                sourceBufferId: buffer.id,
                intendedRecipientName: buffer.recipientName,
                intendedRecipientEmail: buffer.recipientEmail,
                normalizedRecipientEmail: buffer.normalizedEmail,
                emailMode,
                itemsCount: buffer.items.length,
                subject: buildDigestSubject(buffer.items.length),
              },
              select: { id: true },
            });

            for (const item of buffer.items) {
              const events = await transaction.caseEvent.findMany({
                where: {
                  trackedCaseId: item.trackedCaseId,
                  triggersNotification: true,
                  detectedAt: {
                    gte: item.firstEventAt,
                    lte: item.lastEventAt,
                  },
                },
                orderBy: { detectedAt: "asc" },
                select: {
                  eventType: true,
                  fieldName: true,
                  oldValue: true,
                  newValue: true,
                  detectedAt: true,
                },
              });
              const snapshot = buildCaseSnapshot({
                ...item.trackedCase,
                deviceAirtableId: item.trackedCase.devices.length === 1
                  ? item.trackedCase.devices[0]!.deviceAirtableId
                  : null,
              });
              const changes = buildDigestChanges(events);

              await transaction.digestItem.create({
                data: {
                  digestId: digest.id,
                  trackedCaseId: item.trackedCaseId,
                  snapshot: snapshot as Prisma.InputJsonObject,
                  changes: changes as Prisma.InputJsonArray,
                  firstEventAt: item.firstEventAt,
                  lastEventAt: item.lastEventAt,
                },
              });
            }

            await closeReadyBuffer(transaction, buffer.id);
            return {
              outcome: "CREATED",
              digestId: digest.id,
              itemsCount: buffer.items.length,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error: unknown) {
        const existing = await this.prisma.digest.findUnique({
          where: { sourceBufferId: bufferId },
          select: { id: true },
        });
        if (existing) {
          return { outcome: "ALREADY_EXISTS", digestId: existing.id };
        }
        if (isRetryableTransactionError(error) && attempt < 3) continue;
        throw error;
      }
    }
    throw new Error("Digest transaction retry limit reached");
  }
}

async function closeReadyBuffer(
  transaction: Prisma.TransactionClient,
  bufferId: string,
): Promise<void> {
  const closed = await transaction.notificationBuffer.updateMany({
    where: { id: bufferId, status: BufferStatus.READY },
    data: { status: BufferStatus.CLOSED, activeRecipientKey: null },
  });
  if (closed.count !== 1) {
    throw new Error("Ready notification buffer could not be closed");
  }
}

function isRetryableTransactionError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"
  );
}
