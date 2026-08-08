import "dotenv/config";
import { loadBaseConfig } from "../config/base.js";
import { createPrismaClient } from "./prisma.js";

const config = loadBaseConfig(process.env);
const prisma = createPrismaClient(config.databaseUrl);

async function main(): Promise<void> {
  const digest = await prisma.digest.findFirst({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      type: true,
      status: true,
      sourceBufferId: true,
      actualRecipientEmail: true,
      resendEmailId: true,
      emailMode: true,
      itemsCount: true,
      subject: true,
      createdAt: true,
      sendAttempts: true,
      sentAt: true,
      failedAt: true,
      lastError: true,
      items: {
        orderBy: { createdAt: "asc" },
        select: { snapshot: true, changes: true },
      },
    },
  });

  if (!digest) {
    console.info(JSON.stringify({ digest: null }, null, 2));
    return;
  }

  console.info(JSON.stringify({
    digestId: digest.id,
    type: digest.type,
    status: digest.status,
    sourceBufferId: digest.sourceBufferId,
    itemsCount: digest.itemsCount,
    hasActualRecipientEmail: Boolean(digest.actualRecipientEmail),
    hasResendEmailId: Boolean(digest.resendEmailId),
    sendAttempts: digest.sendAttempts,
    sentAt: digest.sentAt,
    failedAt: digest.failedAt,
    lastErrorCode: digest.lastError,
    emailMode: digest.emailMode,
    subject: digest.subject,
    createdAt: digest.createdAt,
    items: digest.items.map((item) => {
      const snapshot = asObject(item.snapshot);
      return {
        caseType: readString(snapshot, "caseType"),
        businessNumber: readString(snapshot, "businessNumber"),
        airtableRecordId: readString(snapshot, "airtableRecordId"),
        currentStatus: readString(snapshot, "currentStatus"),
        changes: Array.isArray(item.changes) ? item.changes : [],
      };
    }),
  }, null, 2));
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

main()
  .catch(() => {
    console.error("Latest digest inspection failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
