import express, { type Express } from "express";
import {
  notFoundPage,
  PUBLIC_PAGE_HEADERS,
  type PublicAccessLinkService,
} from "../access-links/public-page.js";
import type { PrismaClient } from "../generated/prisma/client.js";

export function createApp(
  prisma: PrismaClient,
  accessLinks: PublicAccessLinkService,
): Express {
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

  app.get("/d/:token", async (request, response) => {
    response.set(PUBLIC_PAGE_HEADERS);
    try {
      const result = await accessLinks.open(request.params.token ?? "");
      response.status(result.status).type("html").send(result.html);
    } catch {
      response.status(500).type("html").send(notFoundPage().html);
    }
  });

  return app;
}
