import "dotenv/config";
import { loadWorkerConfig } from "../config/worker.js";
import { createPrismaClient } from "../db/prisma.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const WORKER_ID = "main";

const config = loadWorkerConfig(process.env);
const prisma = createPrismaClient(config.databaseUrl);
let heartbeatTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;

async function writeHeartbeat(): Promise<void> {
  const now = new Date();
  await prisma.workerState.update({
    where: { id: WORKER_ID },
    data: { lastHeartbeatAt: now },
  });
  console.info(`[worker] Heartbeat ${now.toISOString()}`);
}

async function start(): Promise<void> {
  await prisma.$connect();
  const now = new Date();

  await prisma.workerState.upsert({
    where: { id: WORKER_ID },
    create: {
      id: WORKER_ID,
      version: process.env.npm_package_version ?? null,
      startedAt: now,
      lastHeartbeatAt: now,
    },
    update: {
      version: process.env.npm_package_version ?? null,
      startedAt: now,
      lastHeartbeatAt: now,
    },
  });

  console.info(`[worker] Started as ${WORKER_ID} at ${now.toISOString()}`);
  heartbeatTimer = setInterval(() => {
    void writeHeartbeat().catch((error: unknown) => {
      console.error("[worker] Heartbeat failed", error);
    });
  }, HEARTBEAT_INTERVAL_MS);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[worker] Received ${signal}; shutting down`);

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await prisma.$disconnect();
  console.info("[worker] Shutdown complete");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .catch((error: unknown) => {
        console.error("[worker] Shutdown failed", error);
        process.exitCode = 1;
      })
      .finally(() => process.exit());
  });
}

start().catch(async (error: unknown) => {
  console.error("[worker] Startup failed", error);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
});
