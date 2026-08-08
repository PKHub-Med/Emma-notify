import express, { type Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";

export function createApp(prisma: PrismaClient): Express {
  const app = express();

  app.get("/health", async (_request, response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      response.status(200).json({
        status: "ok",
        service: "emma-notify-api",
      });
    } catch (error: unknown) {
      console.error("[api] Database health check failed", error);
      response.status(503).json({
        status: "unavailable",
        service: "emma-notify-api",
      });
    }
  });

  return app;
}
