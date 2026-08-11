import "dotenv/config";
import {
  BufferStatus,
  CaseType,
  DigestStatus,
  CommunicationRecipientResolutionStatus,
} from "../generated/prisma/enums.js";
import { loadBaseConfig } from "../config/base.js";
import { createPrismaClient } from "./prisma.js";

const config = loadBaseConfig(process.env);
const prisma = createPrismaClient(config.databaseUrl);

async function main(): Promise<void> {
  const [
    trackedCases,
    serviceOrders,
    inspections,
    caseRecipients,
    eligibleCaseRecipients,
    caseEvents,
    notificationBuffers,
    openBuffers,
    readyBuffers,
    closedBuffers,
    bufferItems,
    digests,
    createdDigests,
    sendingDigests,
    sentDigests,
    failedDigests,
    digestItems,
    communicationCursors,
    communicationEvents,
    unprocessedCommunicationEvents,
    latestCommunicationEvent,
    communicationEventRecipients,
    readyCommunicationRecipients,
    fallbackCommunicationRecipients,
    failedCommunicationRecipients,
    recipientResolvedEvents,
    recipientUnresolvedEvents,
    latestEvent,
    worker,
  ] = await Promise.all([
    prisma.trackedCase.count(),
    prisma.trackedCase.count({ where: { caseType: CaseType.SERVICE_ORDER } }),
    prisma.trackedCase.count({ where: { caseType: CaseType.INSPECTION } }),
    prisma.caseRecipient.count(),
    prisma.caseRecipient.count({ where: { eligible: true } }),
    prisma.caseEvent.count(),
    prisma.notificationBuffer.count(),
    prisma.notificationBuffer.count({ where: { status: BufferStatus.OPEN } }),
    prisma.notificationBuffer.count({ where: { status: BufferStatus.READY } }),
    prisma.notificationBuffer.count({ where: { status: BufferStatus.CLOSED } }),
    prisma.bufferItem.count(),
    prisma.digest.count(),
    prisma.digest.count({ where: { status: DigestStatus.CREATED } }),
    prisma.digest.count({ where: { status: DigestStatus.SENDING } }),
    prisma.digest.count({ where: { status: DigestStatus.SENT } }),
    prisma.digest.count({ where: { status: DigestStatus.FAILED } }),
    prisma.digestItem.count(),
    prisma.communicationCursor.count(),
    prisma.communicationEvent.count(),
    prisma.communicationEvent.count({ where: { processedAt: null } }),
    prisma.communicationEvent.findFirst({
      orderBy: { detectedAt: "desc" },
      select: {
        scenario: true,
        sourceEntityType: true,
        sourceRecordId: true,
        detectedAt: true,
      },
    }),
    prisma.communicationEventRecipient.count(),
    prisma.communicationEventRecipient.count({
      where: { resolutionStatus: CommunicationRecipientResolutionStatus.READY },
    }),
    prisma.communicationEventRecipient.count({
      where: { resolutionStatus: CommunicationRecipientResolutionStatus.FALLBACK },
    }),
    prisma.communicationEventRecipient.count({
      where: { resolutionStatus: CommunicationRecipientResolutionStatus.FAILED },
    }),
    prisma.communicationEvent.count({ where: { recipientsResolvedAt: { not: null } } }),
    prisma.communicationEvent.count({ where: { recipientsResolvedAt: null } }),
    prisma.caseEvent.findFirst({
      orderBy: { detectedAt: "desc" },
      select: { detectedAt: true },
    }),
    prisma.workerState.findUnique({
      where: { id: "main" },
      select: { lastHeartbeatAt: true, lastSyncAt: true },
    }),
  ]);

  console.info(
    JSON.stringify(
      {
        trackedCases,
        serviceOrders,
        inspections,
        caseRecipients,
        eligibleCaseRecipients,
        caseEvents,
        notificationBuffers,
        openBuffers,
        readyBuffers,
        closedBuffers,
        bufferItems,
        digests,
        createdDigests,
        sendingDigests,
        sentDigests,
        failedDigests,
        digestItems,
        communicationCursors,
        communicationEvents,
        unprocessedCommunicationEvents,
        latestCommunicationEvent,
        communicationEventRecipients,
        readyCommunicationRecipients,
        fallbackCommunicationRecipients,
        failedCommunicationRecipients,
        recipientResolvedEvents,
        recipientUnresolvedEvents,
        latestEventDetectedAt: latestEvent?.detectedAt ?? null,
        workerLastHeartbeatAt: worker?.lastHeartbeatAt ?? null,
        workerLastSyncAt: worker?.lastSyncAt ?? null,
      },
      null,
      2,
    ),
  );
}

main()
  .catch(() => {
    console.error("Database summary failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
