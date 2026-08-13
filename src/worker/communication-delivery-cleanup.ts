import { Prisma, type PrismaClient } from "../generated/prisma/client.js";

const CLEANUP_VERSION = "missing-hospital-scope-v1";
const WORKER_ID = "main";

export type DeliveryCleanupStats = {
  scanned: number;
  cancelledIds: string[];
  alreadyTerminal: number;
};

export interface CommunicationDeliveryCleanupStore {
  cleanupOnce(input: {
    checkpointKey: string;
    activation: Date;
    completedAt: Date;
  }): Promise<DeliveryCleanupStats | null>;
}

export class PrismaCommunicationDeliveryCleanupStore
implements CommunicationDeliveryCleanupStore {
  constructor(private readonly prisma: PrismaClient) {}

  cleanupOnce(input: {
    checkpointKey: string;
    activation: Date;
    completedAt: Date;
  }): Promise<DeliveryCleanupStats | null> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext('emma-communication-delivery-cleanup'))
      `;
      const worker = await transaction.workerState.findUniqueOrThrow({
        where: { id: WORKER_ID },
        select: { communicationDeliveryCleanupKey: true },
      });
      if (worker.communicationDeliveryCleanupKey === input.checkpointKey) return null;

      const rows = await transaction.$queryRaw<Array<{
        id: string;
        status: string;
      }>>(Prisma.sql`
        SELECT d.id, d.status::text AS status
        FROM "CommunicationDelivery" d
        JOIN "CommunicationEvent" e ON e.id = d."communicationEventId"
        WHERE d.status <> 'SENT'
          AND NULLIF(BTRIM(COALESCE(
            e."eventSnapshot"->>'sourceHospitalRecordId', ''
          )), '') IS NULL
          AND CASE
            WHEN d."scheduleReason" = 'REMINDER_0600' THEN d."scheduledFor"
            ELSE e."detectedAt"
          END < ${input.activation}
      `);
      const cancellableIds = rows
        .filter((row) => row.status !== "CANCELLED")
        .map((row) => row.id);
      if (cancellableIds.length > 0) {
        await transaction.communicationDelivery.updateMany({
          where: {
            id: { in: cancellableIds },
            status: { notIn: ["SENT", "CANCELLED"] },
          },
          data: {
            status: "CANCELLED",
            cancelReason: "MISSING_HOSPITAL_SCOPE_LEGACY",
            nextRetryAt: null,
            failedAt: null,
            lastError: null,
            sendingStartedAt: null,
          },
        });
      }
      await transaction.workerState.update({
        where: { id: WORKER_ID },
        data: {
          communicationDeliveryCleanupKey: input.checkpointKey,
          communicationDeliveryCleanupAt: input.completedAt,
        },
      });
      return {
        scanned: rows.length,
        cancelledIds: cancellableIds,
        alreadyTerminal: rows.length - cancellableIds.length,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

export async function runCommunicationDeliveryCleanup(input: {
  store: CommunicationDeliveryCleanupStore;
  activation: Date | null;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<DeliveryCleanupStats | null> {
  if (!input.activation) {
    input.log?.("COMMUNICATION_DELIVERY_CLEANUP_SKIPPED reason=SEND_NOT_BEFORE_MISSING");
    return null;
  }
  const startedAt = (input.now ?? (() => new Date()))();
  const checkpointKey = `${CLEANUP_VERSION}:${input.activation.toISOString()}`;
  const result = await input.store.cleanupOnce({
    checkpointKey,
    activation: input.activation,
    completedAt: startedAt,
  });
  if (!result) return null;
  for (const deliveryId of result.cancelledIds) {
    input.log?.(
      `COMMUNICATION_DELIVERY_CANCELLED deliveryId=${deliveryId} ` +
      "reason=MISSING_HOSPITAL_SCOPE_LEGACY",
    );
  }
  const finishedAt = (input.now ?? (() => new Date()))();
  input.log?.(
    `COMMUNICATION_DELIVERY_CLEANUP scanned=${result.scanned} ` +
    `cancelled=${result.cancelledIds.length} alreadyTerminal=${result.alreadyTerminal} ` +
    `durationMs=${Math.max(0, finishedAt.getTime() - startedAt.getTime())}`,
  );
  return result;
}
