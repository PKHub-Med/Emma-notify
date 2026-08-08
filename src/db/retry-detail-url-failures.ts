import "dotenv/config";
import { loadBaseConfig } from "../config/base.js";
import { DigestStatus, DigestType } from "../generated/prisma/enums.js";
import { createPrismaClient } from "./prisma.js";

const config = loadBaseConfig(process.env);
const prisma = createPrismaClient(config.databaseUrl);

async function main(): Promise<void> {
  const result = await prisma.$transaction(async (transaction) => {
    const candidates = await transaction.digest.findMany({
      where: {
        type: DigestType.CASE_DIGEST,
        status: DigestStatus.FAILED,
        lastError: "DETAIL_URL_NOT_AVAILABLE",
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const ids = candidates.map((candidate) => candidate.id);
    if (ids.length === 0) return { count: 0, ids };
    const updated = await transaction.digest.updateMany({
      where: {
        id: { in: ids },
        type: DigestType.CASE_DIGEST,
        status: DigestStatus.FAILED,
        lastError: "DETAIL_URL_NOT_AVAILABLE",
      },
      data: {
        status: DigestStatus.CREATED,
        failedAt: null,
        nextRetryAt: null,
        lastError: null,
      },
    });
    return { count: updated.count, ids };
  });
  console.info(JSON.stringify(result, null, 2));
}

main()
  .catch(() => {
    console.error("Retrying DETAIL_URL failures failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
