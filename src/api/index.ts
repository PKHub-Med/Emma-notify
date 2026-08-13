import "dotenv/config";
import type { Server } from "node:http";
import {
  PrismaPublicAccessLinkStore,
  PublicAccessLinkService,
} from "../access-links/public-page.js";
import { loadApiConfig } from "../config/api.js";
import { createPrismaClient } from "../db/prisma.js";
import { createApp } from "./app.js";
import {
  PrismaPublicPortalAccessStore,
  PublicPortalAccessService,
} from "../portal-access/public.js";
import {
  PrismaPublicUnsubscribeStore,
  PublicUnsubscribeService,
} from "../communication-unsubscribe/public.js";
import {
  HospitalPortalViewModelService,
  PrismaHospitalPortalStore,
} from "../portal-access/view-model.js";
import { createS3ObjectStorage } from "../assets/object-storage.js";
import { PrismaPublicAssetStore, StoredPublicFileService } from "../assets/public-files.js";

const config = loadApiConfig(process.env);
const prisma = createPrismaClient(config.databaseUrl);
const accessLinks = new PublicAccessLinkService(
  new PrismaPublicAccessLinkStore(prisma),
  config.accessLinkSigningSecret,
);
const portalAccess = new PublicPortalAccessService(
  new PrismaPublicPortalAccessStore(prisma),
  config.accessLinkSigningSecret,
);
const unsubscribe = new PublicUnsubscribeService(
  new PrismaPublicUnsubscribeStore(prisma),
  config.accessLinkSigningSecret,
);
const publicFiles = config.communicationAssetsEnabled
  ? new StoredPublicFileService(
      new PrismaPublicAssetStore(prisma),
      createS3ObjectStorage(config),
      config.assetSignedUrlSeconds,
    )
  : undefined;
const app = createApp(prisma, accessLinks, portalAccess, unsubscribe, {
  portalViews: new HospitalPortalViewModelService(
    new PrismaHospitalPortalStore(prisma),
    config.serviceName,
    config.portalPageSize,
  ),
  serviceName: config.serviceName,
  ...(publicFiles ? { publicFiles } : {}),
});

let server: Server | undefined;
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[api] Received ${signal}; shutting down`);

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
  }

  await prisma.$disconnect();
  console.info("[api] Shutdown complete");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .catch((error: unknown) => {
        console.error("[api] Shutdown failed", error);
        process.exitCode = 1;
      })
      .finally(() => process.exit());
  });
}

server = app.listen(config.port, () => {
  console.info(`[api] Listening on port ${config.port}`);
});
