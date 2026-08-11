import express, { type Express } from "express";
import {
  notFoundPage,
  PUBLIC_PAGE_HEADERS,
  type PublicAccessLinkService,
} from "../access-links/public-page.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  linkExpiredPage,
  portalEntryPage,
  portalNotFoundPage,
  type PublicPortalAccessService,
} from "../portal-access/public.js";
import {
  unsubscribeDonePage,
  unsubscribePage,
  type PublicUnsubscribeService,
} from "../communication-unsubscribe/public.js";

export function createApp(
  prisma: PrismaClient,
  accessLinks: PublicAccessLinkService,
  portalAccess: PublicPortalAccessService,
  unsubscribe: PublicUnsubscribeService,
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

  app.get("/p/:token", async (request, response) => {
    response.set(PUBLIC_PAGE_HEADERS);
    try {
      const result = await portalAccess.open(request.params.token ?? "");
      if (result.outcome === "NOT_FOUND") {
        response.status(404).type("html").send(portalNotFoundPage());
        return;
      }
      if (result.outcome === "INACTIVE") {
        response.redirect(302, "/link-expired");
        return;
      }
      response.status(200).type("html").send(portalEntryPage());
    } catch {
      response.status(500).type("html").send(portalNotFoundPage());
    }
  });

  app.get("/link-expired", (_request, response) => {
    response.set(PUBLIC_PAGE_HEADERS);
    response.status(200).type("html").send(linkExpiredPage());
  });

  app.get("/u/:token", async (request, response) => {
    response.set(PUBLIC_PAGE_HEADERS);
    const grant = await unsubscribe.inspect(request.params.token ?? "");
    if (!grant) { response.status(404).type("html").send(notFoundPage().html); return; }
    response.status(200).type("html").send(unsubscribePage(grant.canOptOut));
  });

  app.post("/u/:token", async (request, response) => {
    response.set(PUBLIC_PAGE_HEADERS);
    const result = await unsubscribe.confirm(request.params.token ?? "");
    if (result === "NOT_FOUND") { response.status(404).type("html").send(notFoundPage().html); return; }
    if (result === "NOT_ALLOWED") { response.status(200).type("html").send(unsubscribePage(false)); return; }
    response.status(200).type("html").send(unsubscribeDonePage());
  });

  return app;
}
