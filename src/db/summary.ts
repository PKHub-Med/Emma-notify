import "dotenv/config";
import { CaseType } from "../generated/prisma/enums.js";
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
    bufferItems,
    worker,
  ] = await Promise.all([
    prisma.trackedCase.count(),
    prisma.trackedCase.count({ where: { caseType: CaseType.SERVICE_ORDER } }),
    prisma.trackedCase.count({ where: { caseType: CaseType.INSPECTION } }),
    prisma.caseRecipient.count(),
    prisma.caseRecipient.count({ where: { eligible: true } }),
    prisma.caseEvent.count(),
    prisma.notificationBuffer.count(),
    prisma.bufferItem.count(),
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
        bufferItems,
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
