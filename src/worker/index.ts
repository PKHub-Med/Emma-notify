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
import {
  PrismaCommunicationDeliveryStore,
  runCommunicationDeliveryPlanner,
} from "./communication-delivery.js";
import { createResendClient } from "../email/resend-client.js";
import {
  PortalAccessGrantService,
  PrismaPortalAccessGrantStore,
} from "../portal-access/service.js";
import {
  PrismaCommunicationTemplateDataSource,
} from "./communication-template-data.js";
import {
  PrismaCommunicationEmailSendStore,
  runCommunicationEmailSender,
} from "./communication-email-sender.js";
import {
  CommunicationUnsubscribeGrantService,
  PrismaUnsubscribeGrantStore,
} from "../communication-unsubscribe/service.js";
import { PrismaHospitalSyncStore, runHospitalSync } from "./hospital-sync.js";
import { runReportedAtBackfill } from "./reported-at-backfill.js";
import {
  PrismaCommunicationDeliveryCleanupStore,
  runCommunicationDeliveryCleanup,
} from "./communication-delivery-cleanup.js";
import {
  CommunicationAssetResolver,
  PrismaCommunicationAssetRegistrationStore,
  PrismaInspectionHospitalScopeVerifier,
} from "../assets/communication-assets.js";
import {
  AirtableAttachmentDownloadSource,
  PrismaAssetProcessorStore,
  runAssetProcessor,
} from "../assets/processor.js";
import {
  BoundedCommunicationAssetPreflight,
  PrismaCommunicationAssetStatusStore,
} from "../assets/preflight.js";
import { createS3ObjectStorage } from "../assets/object-storage.js";
import { PrismaDeviceSyncStore, runDeviceSync } from "./device-sync.js";
import {
  PrismaCaseHospitalScopeRepairStore,
  runCaseHospitalScopeRepair,
} from "./case-hospital-scope-repair.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const DELIVERY_PLANNER_INTERVAL_MS = 15_000;
const COMMUNICATION_EMAIL_INTERVAL_MS = 15_000;
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
const hospitalSyncStore = new PrismaHospitalSyncStore(prisma);
const deviceSyncStore = new PrismaDeviceSyncStore(prisma);
const caseHospitalScopeRepairStore = new PrismaCaseHospitalScopeRepairStore(prisma);
const communicationStore = new PrismaCommunicationEventStore(prisma);
const recipientResolutionStore = new PrismaRecipientResolutionStore(prisma);
const communicationDeliveryStore = new PrismaCommunicationDeliveryStore(prisma);
const communicationDeliveryCleanupStore = new PrismaCommunicationDeliveryCleanupStore(prisma);
const communicationEmailStore = new PrismaCommunicationEmailSendStore(prisma);
const communicationTemplateDataSource = new PrismaCommunicationTemplateDataSource(
  prisma,
  airtable,
);
const portalAccessGrants = new PortalAccessGrantService(
  new PrismaPortalAccessGrantStore(prisma),
  {
    signingSecret: config.accessLinkSigningSecret,
    publicBaseUrl: config.publicBaseUrl,
    ttlDays: config.linkTtlDays,
  },
);
const communicationUnsubscribeGrants = new CommunicationUnsubscribeGrantService(
  new PrismaUnsubscribeGrantStore(prisma),
  {
    signingSecret: config.accessLinkSigningSecret,
    publicBaseUrl: config.publicBaseUrl,
    ttlDays: config.linkTtlDays,
  },
);
const communicationEmailProvider = createResendClient(config.resendApiKey);
const assetStorage = config.communicationAssetsEnabled ? createS3ObjectStorage(config) : undefined;
const assetResolver = config.communicationAssetsEnabled
  ? new CommunicationAssetResolver(
      airtable,
      new PrismaCommunicationAssetRegistrationStore(prisma),
      (message) => console.info(message),
      new PrismaInspectionHospitalScopeVerifier(prisma),
    )
  : undefined;
const assetPreflight = assetResolver
  ? new BoundedCommunicationAssetPreflight(
      assetResolver,
      new PrismaCommunicationAssetStatusStore(prisma),
      config.communicationAssetPrepTimeoutSeconds * 1_000,
      { log: (message) => console.info(message) },
    )
  : undefined;
const assetProcessorStore = config.communicationAssetsEnabled
  ? new PrismaAssetProcessorStore(prisma) : undefined;
const assetDownloadSource = config.communicationAssetsEnabled
  ? new AirtableAttachmentDownloadSource(airtable) : undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let incrementalTimer: NodeJS.Timeout | undefined;
let taskTimer: NodeJS.Timeout | undefined;
let taskReconcileTimer: NodeJS.Timeout | undefined;
let reminderEligibilityTimer: NodeJS.Timeout | undefined;
let hospitalTimer: NodeJS.Timeout | undefined;
let deviceTimer: NodeJS.Timeout | undefined;
let deviceReconcileTimer: NodeJS.Timeout | undefined;
let recipientResolutionTimer: NodeJS.Timeout | undefined;
let deliveryPlannerTimer: NodeJS.Timeout | undefined;
let communicationEmailTimer: NodeJS.Timeout | undefined;
let assetProcessorTimer: NodeJS.Timeout | undefined;
let incrementalRunning = false;
let taskRunning = false;
let hospitalRunning = false;
let deviceRunning = false;
let recipientResolutionRunning = false;
let deliveryPlannerRunning = false;
let communicationEmailRunning = false;
let assetProcessorRunning = false;
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
  await runCommunicationDeliveryCleanup({
    store: communicationDeliveryCleanupStore,
    activation: config.communicationSendNotBefore,
    log: (message) => console.info(message),
  });
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
    try {
      await runCaseHospitalScopeRepair({
        store: caseHospitalScopeRepairStore,
        airtable,
        log: (message) => console.info(message),
      });
    } catch {
      console.error("[case-hospital-scope-repair] failed; retry on next restart");
      throw new Error("Case hospital scope repair failed");
    }
    await runServiceCommunicationBaseline({
      airtable,
      caseStore: incrementalStore,
      communicationStore,
      log: (message) => console.info(message),
    });
    await runReportedAtBackfill({
      prisma,
      airtable,
      log: (message) => console.info(message),
    }).catch(() => console.error("[reported-at-backfill] failed; retry on next restart"));
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
  }, config.airtableTaskPollSeconds * 1_000);
  taskReconcileTimer = setInterval(() => {
    void pollTasks("RECONCILE");
  }, config.airtableTaskReconcileSeconds * 1_000);
  reminderEligibilityTimer = setInterval(() => {
    void pollTasks("REMINDER_ELIGIBILITY");
  }, config.airtableReminderCheckSeconds * 1_000);
  hospitalTimer = setInterval(() => {
    void pollHospitals();
  }, config.airtableHospitalPollSeconds * 1_000);
  deviceTimer = setInterval(() => {
    void pollDevices();
  }, config.airtableDevicePollSeconds * 1_000);
  deviceReconcileTimer = setInterval(() => {
    void pollDevices("RECONCILE");
  }, config.airtableDeviceReconcileSeconds * 1_000);
  recipientResolutionTimer = setInterval(() => {
    void pollRecipientResolution();
  }, config.airtablePollSeconds * 1_000);
  deliveryPlannerTimer = setInterval(() => {
    void pollDeliveryPlanner();
  }, DELIVERY_PLANNER_INTERVAL_MS);
  communicationEmailTimer = setInterval(() => {
    void pollCommunicationEmail();
  }, COMMUNICATION_EMAIL_INTERVAL_MS);
  if (config.communicationAssetsEnabled) {
    assetProcessorTimer = setInterval(() => {
      void pollAssetProcessor();
    }, config.assetProcessorSeconds * 1_000);
  }
  void pollIncremental();
  void pollTasks().then(() => pollTasks("REMINDER_ELIGIBILITY"));
  void pollHospitals();
  void pollDevices();
  void pollRecipientResolution();
  void pollDeliveryPlanner();
  if (config.communicationAssetsEnabled) void pollAssetProcessor();
  void pollCommunicationEmail();
}

async function pollAssetProcessor(): Promise<void> {
  if (assetProcessorRunning || shuttingDown || !assetProcessorStore ||
    !assetDownloadSource || !assetStorage) return;
  assetProcessorRunning = true;
  try {
    await runAssetProcessor({
      store: assetProcessorStore,
      source: assetDownloadSource,
      storage: assetStorage,
      config: {
        maxSourceBytes: config.assetMaxImageSourceBytes,
        maxDocumentSourceBytes: config.assetMaxDocumentSourceBytes,
        maxImagePixels: config.assetMaxImagePixels,
        portalMaxDimension: config.assetPortalMaxDimension,
        thumbMaxDimension: config.assetThumbMaxDimension,
        portalWebpQuality: config.assetPortalWebpQuality,
        thumbWebpQuality: config.assetThumbWebpQuality,
        concurrency: config.assetProcessorConcurrency,
      },
      log: (message) => console.info(message),
    });
  } catch {
    console.error("COMMUNICATION_ASSET_PROCESSOR_FAILED status=FAILED errorCode=BATCH_ERROR");
  } finally {
    assetProcessorRunning = false;
  }
}

async function pollHospitals(): Promise<void> {
  if (hospitalRunning || shuttingDown) return;
  hospitalRunning = true;
  try {
    await runHospitalSync({
      airtable,
      store: hospitalSyncStore,
      log: (message) => console.info(message),
    });
  } catch {
    console.error("[hospital-sync] failed; next poll will retry");
  } finally {
    hospitalRunning = false;
  }
}

async function pollDevices(requestedMode: "AUTO" | "RECONCILE" = "AUTO"): Promise<void> {
  if (deviceRunning || shuttingDown) return;
  deviceRunning = true;
  try {
    await runDeviceSync({
      airtable,
      store: deviceSyncStore,
      requestedMode,
      overlapSeconds: config.airtableSyncOverlapSeconds,
      log: (message) => console.info(message),
    });
  } catch {
    console.error("DEVICE_SYNC_FAILED mode=" + requestedMode);
  } finally {
    deviceRunning = false;
  }
}

async function pollCommunicationEmail(): Promise<void> {
  if (communicationEmailRunning || shuttingDown) return;
  communicationEmailRunning = true;
  try {
    await runCommunicationEmailSender({
      store: communicationEmailStore,
      provider: communicationEmailProvider,
      grants: portalAccessGrants,
      unsubscribeGrants: communicationUnsubscribeGrants,
      dataSource: communicationTemplateDataSource,
      config: {
        communicationEmailsEnabled: config.communicationEmailsEnabled,
        communicationAssetsEnabled: config.communicationAssetsEnabled,
        communicationSendNotBefore: config.communicationSendNotBefore,
        mode: config.emailMode,
        testEmail: config.testEmail,
        productionEmailsEnabled: config.productionEmailsEnabled,
        resendApiKey: config.resendApiKey,
        replyTo: config.emailReplyTo,
        timeZone: config.communicationTimezone,
        officeContact: {
          name: config.tiemedOfficeName,
          phone: config.tiemedOfficePhone,
          email: config.tiemedOfficeEmail,
        },
        tiemedFallbackEmail: config.tiemedFallbackEmail,
      },
      ...(assetPreflight ? { assetPreflight } : {}),
      log: (message) => console.info(message),
    });
  } catch {
    console.error("[communication-email] sender failed; next poll will retry");
  } finally {
    communicationEmailRunning = false;
  }
}

async function pollDeliveryPlanner(): Promise<void> {
  if (deliveryPlannerRunning || shuttingDown) return;
  deliveryPlannerRunning = true;
  try {
    await runCommunicationDeliveryPlanner({
      store: communicationDeliveryStore,
      timeZone: config.communicationTimezone,
      log: (message) => console.info(message),
    });
  } catch {
    console.error("[communication-delivery] planner failed; next poll will retry");
  } finally {
    deliveryPlannerRunning = false;
  }
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

async function pollTasks(
  requestedMode: "AUTO" | "RECONCILE" | "REMINDER_ELIGIBILITY" = "AUTO",
): Promise<void> {
  if (taskRunning || shuttingDown) return;
  taskRunning = true;
  try {
    await runTaskSync({
      airtable,
      store: taskSyncStore,
      communicationStore,
      overlapSeconds: config.airtableSyncOverlapSeconds,
      requestedMode,
      timeZone: config.communicationTimezone,
      log: (message) => console.info(message),
    });
  } catch {
    // runTaskSync emits the safe, stage-aware failure log. The timer remains alive.
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
    // runIncrementalSync emits the safe, stage-aware failure log. The timer remains alive.
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
  if (taskReconcileTimer) clearInterval(taskReconcileTimer);
  if (reminderEligibilityTimer) clearInterval(reminderEligibilityTimer);
  if (hospitalTimer) clearInterval(hospitalTimer);
  if (deviceTimer) clearInterval(deviceTimer);
  if (deviceReconcileTimer) clearInterval(deviceReconcileTimer);
  if (recipientResolutionTimer) clearInterval(recipientResolutionTimer);
  if (deliveryPlannerTimer) clearInterval(deliveryPlannerTimer);
  if (communicationEmailTimer) clearInterval(communicationEmailTimer);
  if (assetProcessorTimer) clearInterval(assetProcessorTimer);
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
