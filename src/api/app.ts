import express, { type Express } from "express";
import { randomBytes } from "node:crypto";
import {
  notFoundPage,
  PUBLIC_PAGE_HEADERS,
  type PublicAccessLinkService,
} from "../access-links/public-page.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  linkExpiredPage,
  portalNotFoundPage,
  type PublicPortalAccessService,
} from "../portal-access/public.js";
import { portalPageHeaders, renderHospitalPortal } from "../portal-access/portal-page.js";
import {
  HospitalPortalViewModelService,
  InvalidPortalCursorError,
  PrismaHospitalPortalStore,
} from "../portal-access/view-model.js";
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
  options: {
    portalViews?: Pick<HospitalPortalViewModelService,
      "build" | "listCases" | "getCase" | "listDevices" | "getDevice">;
    serviceName?: string;
  } = {},
): Express {
  const app = express();
  const portalViews = options.portalViews ?? new HospitalPortalViewModelService(
    new PrismaHospitalPortalStore(prisma),
    options.serviceName,
  );

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
    try {
      const result = await portalAccess.open(request.params.token ?? "");
      if (result.outcome === "NOT_FOUND") {
        response.set(PUBLIC_PAGE_HEADERS);
        response.status(404).type("html").send(portalNotFoundPage());
        return;
      }
      if (result.outcome === "INACTIVE") {
        response.set(PUBLIC_PAGE_HEADERS);
        response.redirect(302, "/link-expired");
        return;
      }
      const view = await portalViews.build(result.authorization);
      const nonce = randomBytes(18).toString("base64url");
      response.set(portalPageHeaders(nonce));
      const dataBasePath = `/p/${encodeURIComponent(request.params.token ?? "")}`;
      response.status(200).type("html").send(
        renderHospitalPortal(view, nonce, new Date(), dataBasePath),
      );
    } catch {
      response.set(PUBLIC_PAGE_HEADERS);
      response.status(500).type("html").send(portalNotFoundPage());
    }
  });

  app.get("/p/:token/data/cases", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    const filter = stringQuery(request.query.filter);
    const hasCursor = request.query.cursor !== undefined;
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      const cursor = cursorQuery(request.query.cursor);
      const query = stringQuery(request.query.q);
      const limit = numberQuery(request.query.limit);
      const page = await portalViews.listCases(authorization, {
        ...(filter ? { filter } : {}), ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}),
      });
      response.status(200).json(page);
    } catch (error: unknown) {
      sendPortalDataError(response, error, "cases", filter, hasCursor);
    }
  });

  app.get("/p/:token/data/cases/:caseId", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      const item = await portalViews.getCase(authorization, request.params.caseId ?? "");
      if (!item) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      response.status(200).json(item);
    } catch (error: unknown) {
      sendPortalDataError(response, error, "case-detail", undefined, false);
    }
  });

  app.get("/p/:token/data/devices", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    const hasCursor = request.query.cursor !== undefined;
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      const cursor = cursorQuery(request.query.cursor);
      const query = stringQuery(request.query.q);
      const limit = numberQuery(request.query.limit);
      const page = await portalViews.listDevices(authorization, {
        ...(query ? { query } : {}), ...(cursor ? { cursor } : {}),
        ...(limit ? { limit } : {}),
      });
      response.status(200).json(page);
    } catch (error: unknown) {
      sendPortalDataError(response, error, "devices", undefined, hasCursor);
    }
  });

  app.get("/p/:token/data/devices/:deviceId", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      const item = await portalViews.getDevice(authorization, request.params.deviceId ?? "");
      if (!item) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      response.status(200).json(item);
    } catch (error: unknown) {
      sendPortalDataError(response, error, "device-detail", undefined, false);
    }
  });

  app.get("/p/:token/data/documents", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
    if (!authorization) { response.status(404).json({ error: "NOT_FOUND" }); return; }
    response.status(200).json({ items: [], nextCursor: null });
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

const PORTAL_DATA_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
} as const;

async function authorizePortalData(
  portalAccess: PublicPortalAccessService,
  token: string,
) {
  const result = await portalAccess.authorizeData(token);
  return result.outcome === "VALID" ? result.authorization : null;
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberQuery(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function cursorQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  throw new InvalidPortalCursorError();
}

function sendPortalDataError(
  response: import("express").Response,
  error: unknown,
  endpoint: string,
  filter: string | undefined,
  hasCursor: boolean,
): void {
  const invalidCursor = error instanceof InvalidPortalCursorError;
  const status = invalidCursor ? 400 : 500;
  const errorCode = invalidCursor ? error.code : "INTERNAL_ERROR";
  const safeFilter = ["ALL", "ACTION", "REPAIR", "INSPECTION"].includes(
    filter?.toUpperCase() ?? "",
  ) ? filter!.toUpperCase() : "ALL";
  console.error(
    `PORTAL_DATA_REQUEST_FAILED endpoint=${endpoint} filter=${safeFilter} hasCursor=${hasCursor} status=${status} errorCode=${errorCode}`,
  );
  response.status(status).json({ error: errorCode });
}
