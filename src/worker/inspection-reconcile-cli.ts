import "dotenv/config";
import { AirtableClient } from "../airtable/client.js";
import { loadWorkerConfig } from "../config/worker.js";
import { createPrismaClient } from "../db/prisma.js";
import {
  PrismaInspectionReconcileStore,
  runInspectionReconcile,
} from "./inspection-reconcile.js";

const CONFIRMATION = "INSPECTION_RECONCILE";

async function main(): Promise<void> {
  const confirmation = process.argv.find((argument) =>
    argument.startsWith("--confirm-first-run="))?.split("=", 2)[1];
  if (confirmation !== CONFIRMATION) {
    throw new Error(
      `Explicit approval required: --confirm-first-run=${CONFIRMATION}`,
    );
  }

  const config = loadWorkerConfig(process.env);
  const prisma = createPrismaClient(config.databaseUrl);
  const airtable = new AirtableClient({
    baseId: config.airtableBaseId,
    personalAccessToken: config.airtablePat,
  });
  try {
    await runInspectionReconcile({
      airtable,
      store: new PrismaInspectionReconcileStore(prisma),
      log: (message) => console.info(message),
    });
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "INSPECTION_RECONCILE_FAILED");
  process.exitCode = 1;
});
