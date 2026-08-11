import "dotenv/config";
import { AirtableClient } from "../airtable/client.js";
import { loadWorkerConfig } from "../config/worker.js";
import { createPrismaClient } from "../db/prisma.js";
import { runBaseline } from "./baseline.js";
import { PrismaBaselineStore } from "./baseline-store.js";
import { runIncrementalSync } from "./incremental-sync.js";
import { PrismaIncrementalStore } from "./incremental-store.js";
import { PrismaCommunicationEventStore } from "./communication-event.js";
import { runServiceCommunicationBaseline } from "./service-communication-baseline.js";
import { PrismaTaskSyncStore, runTaskSync } from "./task-sync.js";
import {
  PrismaRecipientResolutionStore,
  resolvePendingCommunicationRecipients,
} from "./recipient-resolution.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const WORKER_ID = "main";

const config = loadWorkerConfig(process.env);
const prisma = createPrismaClient(config.databaseUrl);
const airtable = new AirtableClient({
  baseId: config.airtableBaseId,
  personalAccessToken: config.airtablePat,
});
const baselineStore = new PrismaBaselineStore(prisma);
const incrementalStore = new PrismaIncrementalStore(prisma);
const taskSyncStore = new PrismaTaskSyncStore(prisma);
const communicationStore = new PrismaCommunicationEventStore(prisma);
const recipientResolutionStore = new PrismaRecipientResolutionStore(prisma);
let heartbeatTimer: NodeJS.Timeout | undefined;
let incrementalTimer: NodeJS.Timeout | undefined;
let taskTimer: NodeJS.Timeout | undefined;
let recipientResolutionTimer: NodeJS.Timeout | undefined;
let incrementalRunning = false;
let taskRunning = false;
let recipientResolutionRunning = false;
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

  try {
    await runBaseline({
      airtable,
      store: baselineStore,
      log: (message) => console.info(message),
    });
    await runServiceCommunicationBaseline({
      airtable,
      caseStore: incrementalStore,
      communicationStore,
      log: (message) => console.info(message),
    });
    startPollingLoops();
  } catch {
    console.error("[baseline] failed; worker will continue heartbeat");
  }
}

function startPollingLoops(): void {
  incrementalTimer = setInterval(() => {
    void pollIncremental();
  }, config.airtablePollSeconds * 1_000);
  taskTimer = setInterval(() => {
    void pollTasks();
  }, config.airtablePollSeconds * 1_000);
  recipientResolutionTimer = setInterval(() => {
    void pollRecipientResolution();
  }, config.airtablePollSeconds * 1_000);
  void pollIncremental();
  void pollTasks();
  void pollRecipientResolution();
}

async function pollRecipientResolution(): Promise<void> {
  if (recipientResolutionRunning || shuttingDown) return;
  recipientResolutionRunning = true;
  try {
    await resolvePendingCommunicationRecipients({
      airtable,
      store: recipientResolutionStore,
      tiemedFallbackEmail: config.tiemedFallbackEmail,
      log: (message) => console.info(message),
    });
  } catch {
    console.error("COMMUNICATION_RECIPIENT_RESOLUTION_FAILED eventId=BATCH reason=INTERNAL_ERROR");
  } finally {
    recipientResolutionRunning = false;
  }
}

async function pollTasks(): Promise<void> {
  if (taskRunning || shuttingDown) return;
  taskRunning = true;
  try {
    await runTaskSync({
      airtable,
      store: taskSyncStore,
      communicationStore,
      log: (message) => console.info(message),
    });
  } catch {
    console.error("[task-sync] failed; next poll will retry");
  } finally {
    taskRunning = false;
  }
}

async function pollIncremental(): Promise<void> {
  if (incrementalRunning || shuttingDown) return;
  incrementalRunning = true;
  try {
    await runIncrementalSync({
      airtable,
      store: incrementalStore,
      communicationStore,
      options: {
        overlapSeconds: config.airtableSyncOverlapSeconds,
        quietMinutes: config.digestQuietMinutes,
        legacyNotificationsEnabled: false,
      },
      log: (message) => console.info(message),
    });
  } catch {
    console.error("[incremental-sync] failed; next poll will retry");
  } finally {
    incrementalRunning = false;
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[worker] Received ${signal}; shutting down`);

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (incrementalTimer) clearInterval(incrementalTimer);
  if (taskTimer) clearInterval(taskTimer);
  if (recipientResolutionTimer) clearInterval(recipientResolutionTimer);
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
