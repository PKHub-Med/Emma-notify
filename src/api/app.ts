import express, { type Express } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
import { PrismaPortalAccessPolicy } from "../portal-access/policy.js";
import {
  PortalRefreshService,
  PrismaPortalRefreshRequestStore,
} from "../portal-access/refresh.js";
import {
  unsubscribeDonePage,
  unsubscribePage,
  type PublicUnsubscribeService,
} from "../communication-unsubscribe/public.js";
import type { PublicAssetVariant, PublicFileService } from "../assets/public-files.js";
import type {
  AnalyticsFilters,
  PortalAnalyticsInput,
  PortalAnalyticsWriter,
  PrismaAnalyticsAdminService,
} from "../analytics/service.js";
import {
  ANALYTICS_HEADERS,
  analyticsDashboardPage,
} from "../analytics/dashboard-page.js";

export function createApp(
  prisma: PrismaClient,
  accessLinks: PublicAccessLinkService,
  portalAccess: PublicPortalAccessService,
  unsubscribe: PublicUnsubscribeService,
  options: {
    portalViews?: Pick<HospitalPortalViewModelService,
      "build" | "listCases" | "getCase" | "listDevices" | "getDevice" | "listDocuments">;
    portalRefresh?: Pick<PortalRefreshService, "request" | "status">;
    serviceName?: string;
    publicFiles?: PublicFileService;
    analytics?: PortalAnalyticsWriter;
    analyticsAdmin?: Pick<PrismaAnalyticsAdminService,
      "summary" | "hospitals" | "hospital" | "deliveries" | "activity">;
    analyticsAuth?: { enabled: boolean; user: string | null; password: string | null };
  } = {},
): Express {
  const app = express();
  app.use("/api/portal", express.json({ limit: "8kb", strict: true }));
  const portalViews = options.portalViews ?? new HospitalPortalViewModelService(
    new PrismaHospitalPortalStore(prisma),
    options.serviceName,
  );
  const portalRefresh = options.portalRefresh ?? new PortalRefreshService(
    new PrismaPortalRefreshRequestStore(prisma),
    new HospitalPortalViewModelService(
      new PrismaHospitalPortalStore(prisma),
      options.serviceName,
      30,
      new PrismaPortalAccessPolicy(prisma),
    ),
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
    try {
      const portalResult = await portalAccess.open(request.params.token ?? "");
      if (portalResult.outcome === "VALID") {
        await safeLinkClick(options.analytics, portalResult.authorization);
        const view = await portalViews.build(portalResult.authorization);
        const nonce = randomBytes(18).toString("base64url");
        response.set(portalPageHeaders(nonce));
        const dataBasePath = `/p/${encodeURIComponent(request.params.token ?? "")}`;
        response.status(200).type("html").send(
          renderHospitalPortal(view, nonce, new Date(), dataBasePath),
        );
        return;
      }
      if (portalResult.outcome === "INACTIVE") {
        response.set(PUBLIC_PAGE_HEADERS);
        response.redirect(302, "/link-expired");
        return;
      }
      response.set(PUBLIC_PAGE_HEADERS);
      const result = await accessLinks.open(request.params.token ?? "");
      response.status(result.status).type("html").send(result.html);
    } catch {
      response.set(PUBLIC_PAGE_HEADERS);
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
      await safeLinkClick(options.analytics, result.authorization);
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
    const query = stringQuery(request.query.q);
    const hasCursor = request.query.cursor !== undefined;
    const hasQuery = Boolean(query?.trim());
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      const cursor = cursorQuery(request.query.cursor);
      const limit = numberQuery(request.query.limit);
      const page = await portalViews.listCases(authorization, {
        ...(filter ? { filter } : {}), ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}),
      });
      response.status(200).json(page);
    } catch (error: unknown) {
      sendPortalDataError(response, error, "cases", filter, hasCursor, hasQuery);
    }
  });

  app.post("/p/:token/data/refresh", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      const refresh = await portalRefresh.request(authorization);
      response.status(202).json(refresh);
    } catch {
      console.error("PORTAL_REFRESH_REQUEST_FAILED errorCode=INTERNAL_ERROR status=500");
      response.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

  app.get("/p/:token/data/refresh/:requestId", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      const refresh = await portalRefresh.status(
        authorization,
        request.params.requestId ?? "",
      );
      if (!refresh) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      response.status(200).json(refresh);
    } catch {
      console.error("PORTAL_REFRESH_STATUS_FAILED errorCode=INTERNAL_ERROR status=500");
      response.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

  app.post("/api/portal/:token/analytics", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      const input = portalAnalyticsInput(request.body);
      if (!input) { response.status(400).json({ error: "INVALID_ANALYTICS_EVENT" }); return; }
      if (options.analytics) await options.analytics.recordPortalEvent(authorization, input);
      response.status(204).send();
    } catch {
      console.error("PORTAL_ANALYTICS_WRITE_FAILED errorCode=INTERNAL_ERROR status=500");
      response.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

  app.get("/p/:token/data/cases/:caseId", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    const hasCaseId = Boolean(request.params.caseId);
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization) {
        sendPortalDetailError(response, "CASE_DETAIL", hasCaseId, "NOT_FOUND", 404);
        return;
      }
      const item = await portalViews.getCase(authorization, request.params.caseId ?? "");
      if (!item) {
        sendPortalDetailError(response, "CASE_DETAIL", hasCaseId, "NOT_FOUND", 404);
        return;
      }
      response.status(200).json(item);
    } catch (error: unknown) {
      const invalidCursor = error instanceof InvalidPortalCursorError;
      sendPortalDetailError(
        response,
        "CASE_DETAIL",
        hasCaseId,
        invalidCursor ? error.code : "INTERNAL_ERROR",
        invalidCursor ? 400 : 500,
      );
    }
  });

  app.get("/p/:token/data/devices", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    const query = stringQuery(request.query.q);
    const hasCursor = request.query.cursor !== undefined;
    const hasQuery = Boolean(query?.trim());
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      const cursor = cursorQuery(request.query.cursor);
      const limit = numberQuery(request.query.limit);
      const page = await portalViews.listDevices(authorization, {
        ...(query ? { query } : {}), ...(cursor ? { cursor } : {}),
        ...(limit ? { limit } : {}),
      });
      response.status(200).json(page);
    } catch (error: unknown) {
      sendPortalDataError(response, error, "devices", undefined, hasCursor, hasQuery);
    }
  });

  app.get("/p/:token/data/devices/:deviceId", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    const hasCursor = request.query.cursor !== undefined;
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      const cursor = cursorQuery(request.query.cursor);
      const limit = numberQuery(request.query.limit);
      const item = await portalViews.getDevice(
        authorization,
        request.params.deviceId ?? "",
        { ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) },
      );
      if (!item) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      response.status(200).json(item);
    } catch (error: unknown) {
      sendPortalDataError(response, error, "device-detail", undefined, hasCursor, false);
    }
  });

  app.get("/p/:token/data/documents", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    const query = stringQuery(request.query.q);
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      response.status(200).json(await portalViews.listDocuments(authorization, {
        ...(query ? { query } : {}),
      }));
    } catch (error: unknown) {
      sendPortalDataError(response, error, "documents", undefined, false, Boolean(query?.trim()));
    }
  });

  app.get("/p/:token/files/:assetId", async (request, response) => {
    response.set(PORTAL_DATA_HEADERS);
    try {
      const authorization = await authorizePortalData(portalAccess, request.params.token ?? "");
      if (!authorization || !options.publicFiles) {
        logPortalFileDenied(
          Boolean(request.params.assetId),
          fileVariant(request.query.variant) ?? "document",
          authorization ? "FILE_SERVICE_UNAVAILABLE" : "ACCESS_POLICY_DENIED",
        );
        response.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      const variant = fileVariant(request.query.variant);
      if (!variant) {
        logPortalFileDenied(Boolean(request.params.assetId), "document", "VARIANT_NOT_FOUND", 400);
        response.status(400).json({ error: "INVALID_VARIANT" });
        return;
      }
      const resolution = options.publicFiles.resolve
        ? await options.publicFiles.resolve(
            authorization,
            request.params.assetId ?? "",
            variant,
          )
        : {
            url: await options.publicFiles.signedUrl(
              authorization,
              request.params.assetId ?? "",
              variant,
            ),
            reason: "ACCESS_POLICY_DENIED" as const,
          };
      const { url } = resolution;
      if (!url) {
        logPortalFileDenied(
          Boolean(request.params.assetId), variant,
          resolution.reason ?? "ACCESS_POLICY_DENIED",
        );
        response.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      response.redirect(302, url);
    } catch {
      console.error("PORTAL_FILE_REQUEST_FAILED endpoint=files status=500");
      response.status(500).json({ error: "INTERNAL_ERROR" });
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

  const analyticsGuard = analyticsBasicAuth(options.analyticsAuth);
  app.get("/ops/analytics", analyticsGuard, (_request, response) => {
    const nonce = randomBytes(18).toString("base64url");
    response.set(ANALYTICS_HEADERS);
    response.set("Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
      "connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.status(200).type("html").send(analyticsDashboardPage(nonce));
  });
  app.get("/api/ops/analytics/summary", analyticsGuard, analyticsApi(async (filters) =>
    options.analyticsAdmin?.summary(filters)));
  app.get("/api/ops/analytics/hospitals", analyticsGuard, analyticsApi(async (filters) =>
    options.analyticsAdmin?.hospitals(filters)));
  app.get("/api/ops/analytics/hospitals/:hospitalId", analyticsGuard, analyticsApi(async (filters, request) =>
    options.analyticsAdmin?.hospital(filters,
      typeof request.params.hospitalId === "string" ? request.params.hospitalId : "")));
  app.get("/api/ops/analytics/deliveries", analyticsGuard, analyticsApi(async (filters) =>
    options.analyticsAdmin?.deliveries(filters)));
  app.get("/api/ops/analytics/activity", analyticsGuard, analyticsApi(async (filters) =>
    options.analyticsAdmin?.activity(filters)));

  return app;
}

async function safeLinkClick(
  analytics: PortalAnalyticsWriter | undefined,
  authorization: import("../portal-access/public.js").PortalAuthorizationContext,
): Promise<void> {
  if (!analytics) return;
  try {
    await analytics.recordLinkClick(authorization);
  } catch {
    console.error("PORTAL_ANALYTICS_WRITE_FAILED eventType=EMAIL_LINK_CLICK errorCode=INTERNAL_ERROR");
  }
}

function portalAnalyticsInput(value: unknown): PortalAnalyticsInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set(["eventType", "sessionId", "screen", "entityType", "entityRecordId"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (!(["PORTAL_VIEW_CONFIRMED", "SCREEN_VIEW", "UPGRADE_CLICK"] as unknown[]).includes(body.eventType)) return null;
  if (typeof body.sessionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.sessionId)) return null;
  if (body.screen !== undefined && (typeof body.screen !== "string" ||
      body.screen.length < 1 || body.screen.length > 64 || !/^[a-z0-9_-]+$/i.test(body.screen))) return null;
  if (body.eventType === "SCREEN_VIEW" && typeof body.screen !== "string") return null;
  if (body.entityType !== undefined && body.entityType !== "CASE" && body.entityType !== "DEVICE") return null;
  if (body.entityRecordId !== undefined && (typeof body.entityRecordId !== "string" ||
      body.entityRecordId.length < 1 || body.entityRecordId.length > 128)) return null;
  return {
    eventType: body.eventType as PortalAnalyticsInput["eventType"],
    sessionId: body.sessionId,
    ...(typeof body.screen === "string" ? { screen: body.screen } : {}),
    ...(body.entityType === "CASE" || body.entityType === "DEVICE" ? { entityType: body.entityType } : {}),
    ...(typeof body.entityRecordId === "string" ? { entityRecordId: body.entityRecordId } : {}),
  };
}

function analyticsBasicAuth(configuration: { enabled: boolean; user: string | null; password: string | null } | undefined) {
  return (request: import("express").Request, response: import("express").Response,
    next: import("express").NextFunction): void => {
    response.set(ANALYTICS_HEADERS);
    if (!configuration?.enabled || !configuration.user || !configuration.password) {
      response.status(404).type("text").send("Not found"); return;
    }
    const header = request.headers.authorization;
    const encoded = header?.startsWith("Basic ") ? header.slice(6) : "";
    let supplied = "";
    try { supplied = Buffer.from(encoded, "base64").toString("utf8"); } catch { supplied = ""; }
    const expected = `${configuration.user}:${configuration.password}`;
    const left = Buffer.from(supplied); const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      response.set("WWW-Authenticate", 'Basic realm="EMMA Analytics", charset="UTF-8"');
      response.status(401).type("text").send("Authentication required"); return;
    }
    next();
  };
}

function analyticsApi(
  handler: (filters: AnalyticsFilters, request: import("express").Request) => Promise<unknown>,
) {
  return async (request: import("express").Request, response: import("express").Response) => {
    response.set(ANALYTICS_HEADERS);
    try {
      const filters = analyticsFilters(request.query);
      if (!filters) { response.status(400).json({ error: "INVALID_FILTERS" }); return; }
      const result = await handler(filters, request);
      if (!result) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      response.status(200).json(result);
    } catch {
      console.error("ANALYTICS_DASHBOARD_QUERY_FAILED errorCode=INTERNAL_ERROR status=500");
      response.status(500).json({ error: "INTERNAL_ERROR" });
    }
  };
}

function analyticsFilters(query: import("express").Request["query"]): AnalyticsFilters | null {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 86_400_000);
  const from = typeof query.from === "string" ? new Date(`${query.from}T00:00:00.000Z`) : defaultFrom;
  const to = typeof query.to === "string" ? new Date(`${query.to}T23:59:59.999Z`) : now;
  const mode = typeof query.mode === "string" ? query.mode : "PRODUCTION";
  const scenario = typeof query.scenario === "string" && query.scenario ? query.scenario : undefined;
  const hospitalId = typeof query.hospitalId === "string" && query.hospitalId ? query.hospitalId : undefined;
  const scenarios = new Set(["REPAIR_RECEIVED", "REPAIR_DELAYED_PARTS", "REPAIR_COMPLETED",
    "INSPECTION_DATE_PROPOSED", "INSPECTION_DATE_CONFIRMED", "INSPECTION_REMINDER", "INSPECTION_COMPLETED"]);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to ||
      !["PRODUCTION", "TEST", "ALL"].includes(mode) ||
      (scenario && !scenarios.has(scenario)) || (hospitalId && hospitalId.length > 128)) return null;
  return { from, to, mode: mode as AnalyticsFilters["mode"],
    ...(scenario ? { scenario } : {}), ...(hospitalId ? { hospitalId } : {}) };
}

function fileVariant(value: unknown): PublicAssetVariant | null {
  if (value === undefined) return "document";
  if (value === "portal" || value === "thumb" || value === "document") return value;
  return null;
}

function logPortalFileDenied(
  hasAssetId: boolean,
  variant: PublicAssetVariant,
  reason: import("../assets/public-files.js").PublicAssetDenialReason,
  status = 404,
): void {
  console.warn(
    `PORTAL_FILE_REQUEST_DENIED hasAssetId=${hasAssetId} variant=${variant} ` +
    `reason=${reason} status=${status}`,
  );
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
  hasQuery: boolean,
): void {
  const invalidCursor = error instanceof InvalidPortalCursorError;
  const status = invalidCursor ? 400 : 500;
  const errorCode = invalidCursor ? error.code : "INTERNAL_ERROR";
  const safeFilter = ["ALL", "ACTION", "REPAIR", "INSPECTION"].includes(
    filter?.toUpperCase() ?? "",
  ) ? filter!.toUpperCase() : "ALL";
  console.error(
    `PORTAL_DATA_REQUEST_FAILED endpoint=${endpoint} filter=${safeFilter} ` +
    `hasCursor=${hasCursor} hasQuery=${hasQuery} errorCode=${errorCode} status=${status}`,
  );
  response.status(status).json({ error: errorCode });
}

function sendPortalDetailError(
  response: import("express").Response,
  endpoint: "CASE_DETAIL",
  hasCaseId: boolean,
  errorCode: string,
  status: number,
): void {
  console.error(
    `PORTAL_DATA_REQUEST_FAILED endpoint=${endpoint} hasCaseId=${hasCaseId} ` +
    `errorCode=${errorCode} status=${status}`,
  );
  response.status(status).json({ error: errorCode });
}
