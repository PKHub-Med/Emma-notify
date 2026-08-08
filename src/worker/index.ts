import "dotenv/config";
import { AirtableClient } from "../airtable/client.js";
import { loadWorkerConfig } from "../config/worker.js";
import { createPrismaClient } from "../db/prisma.js";
import { createResendClient } from "../email/resend-client.js";
import { PrismaDigestSendStore, runEmailLoop } from "../email/sender.js";
import { runBaseline } from "./baseline.js";
import { PrismaBaselineStore } from "./baseline-store.js";
import { runDigestLoop } from "./digest-loop.js";
import { PrismaDigestStore } from "./digest-store.js";
import { runIncrementalSync } from "./incremental-sync.js";
import { PrismaIncrementalStore } from "./incremental-store.js";
import { runWatchdog } from "./watchdog.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 15_000;
const DIGEST_INTERVAL_MS = 15_000;
const EMAIL_INTERVAL_MS = 15_000;
const WORKER_ID = "main";

const config = loadWorkerConfig(process.env);
const prisma = createPrismaClient(config.databaseUrl);
const airtable = new AirtableClient({
  baseId: config.airtableBaseId,
  personalAccessToken: config.airtablePat,
});
const baselineStore = new PrismaBaselineStore(prisma);
const incrementalStore = new PrismaIncrementalStore(prisma);
const digestStore = new PrismaDigestStore(prisma);
const digestSendStore = new PrismaDigestSendStore(prisma);
const emailProvider = createResendClient(config.resendApiKey);
let heartbeatTimer: NodeJS.Timeout | undefined;
let incrementalTimer: NodeJS.Timeout | undefined;
let watchdogTimer: NodeJS.Timeout | undefined;
let digestTimer: NodeJS.Timeout | undefined;
let emailTimer: NodeJS.Timeout | undefined;
let incrementalRunning = false;
let watchdogRunning = false;
let digestRunning = false;
let emailRunning = false;
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
    startIncrementalLoops();
  } catch {
    console.error("[baseline] failed; worker will continue heartbeat");
  }
}

function startIncrementalLoops(): void {
  incrementalTimer = setInterval(() => {
    void pollIncremental();
  }, config.airtablePollSeconds * 1_000);
  watchdogTimer = setInterval(() => {
    void pollWatchdog();
  }, WATCHDOG_INTERVAL_MS);
  digestTimer = setInterval(() => {
    void pollDigests();
  }, DIGEST_INTERVAL_MS);
  emailTimer = setInterval(() => {
    void pollEmail();
  }, EMAIL_INTERVAL_MS);
  void pollIncremental();
  void pollWatchdog();
  void pollDigests();
  void pollEmail();
}

async function pollEmail(): Promise<void> {
  if (emailRunning || shuttingDown) return;
  emailRunning = true;
  try {
    await runEmailLoop({
      store: digestSendStore,
      provider: emailProvider,
      config: {
        mode: config.emailMode,
        testEmail: config.testEmail,
        productionEmailsEnabled: config.productionEmailsEnabled,
        resendApiKey: config.resendApiKey,
        emailFrom: config.emailFrom,
      },
      log: (message) => console.info(message),
    });
  } catch {
    console.error("[email] loop failed; eligible digests will retry");
  } finally {
    emailRunning = false;
  }
}

async function pollDigests(): Promise<void> {
  if (digestRunning || shuttingDown) return;
  digestRunning = true;
  try {
    await runDigestLoop({
      store: digestStore,
      emailMode: config.emailMode,
      log: (message) => console.info(message),
    });
  } catch {
    console.error("[digest] loop failed; READY buffers will retry");
  } finally {
    digestRunning = false;
  }
}

async function pollIncremental(): Promise<void> {
  if (incrementalRunning || shuttingDown) return;
  incrementalRunning = true;
  try {
    await runIncrementalSync({
      airtable,
      store: incrementalStore,
      options: {
        overlapSeconds: config.airtableSyncOverlapSeconds,
        quietMinutes: config.digestQuietMinutes,
      },
      log: (message) => console.info(message),
    });
  } catch {
    console.error("[incremental-sync] failed; next poll will retry");
  } finally {
    incrementalRunning = false;
  }
}

async function pollWatchdog(): Promise<void> {
  if (watchdogRunning || shuttingDown) return;
  watchdogRunning = true;
  try {
    await runWatchdog(incrementalStore, new Date(), (message) =>
      console.info(message));
  } catch {
    console.error("[watchdog] failed; next check will retry");
  } finally {
    watchdogRunning = false;
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[worker] Received ${signal}; shutting down`);

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (incrementalTimer) clearInterval(incrementalTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  if (digestTimer) clearInterval(digestTimer);
  if (emailTimer) clearInterval(emailTimer);
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
