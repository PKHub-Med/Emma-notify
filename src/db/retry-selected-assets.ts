import "dotenv/config";
import { loadWorkerConfig } from "../config/worker.js";
import { createPrismaClient } from "./prisma.js";
import { scheduleSelectedFailedAssetRetry } from "../assets/case-attachment-sync.js";

if (process.env.ASSET_RETRY_APPROVED !== "true") {
  throw new Error("ASSET_RETRY_APPROVED=true is required");
}
const ids = (process.env.ASSET_RETRY_STORED_FILE_IDS ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean);
if (ids.length === 0 || ids.length > 25) throw new Error("Provide 1-25 explicit StoredFile IDs");
const config = loadWorkerConfig(process.env);
const prisma = createPrismaClient(config.databaseUrl);
try {
  const count = await scheduleSelectedFailedAssetRetry({ prisma, storedFileIds: ids, maxFiles: 25 });
  console.info(`ASSET_RETRY_SELECTED status=SUCCEEDED requested=${ids.length} scheduled=${count}`);
} finally {
  await prisma.$disconnect();
}
