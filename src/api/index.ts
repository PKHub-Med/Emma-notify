import "dotenv/config";
import type { Server } from "node:http";
import { loadConfig } from "../config/config.js";
import { createPrismaClient } from "../db/prisma.js";
import { createApp } from "./app.js";

const config = loadConfig(process.env);
const prisma = createPrismaClient(config.databaseUrl);
const app = createApp(prisma);

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
