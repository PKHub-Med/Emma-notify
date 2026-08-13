import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  PublicAccessLinkService,
  type PublicAccessLinkRecord,
  type PublicAccessLinkStore,
} from "../access-links/public-page.js";
import { signAccessLink } from "../access-links/token.js";
import { createApp } from "./app.js";
import {
  PublicPortalAccessService,
  type PublicPortalAccessGrant,
  type PublicPortalAccessStore,
} from "../portal-access/public.js";
import { signPortalGrantToken } from "../portal-access/token.js";
import { CommunicationScenario } from "../generated/prisma/enums.js";
import {
  PublicUnsubscribeService,
  type PublicUnsubscribeStore,
} from "../communication-unsubscribe/public.js";
import { signUnsubscribeToken, type UnsubscribeTokenPayload } from "../communication-unsubscribe/token.js";
import type { HospitalPortalViewModel } from "../portal-access/view-model.js";
import type { PortalAuthorizationContext } from "../portal-access/public.js";

const secret = "test-access-link-signing-secret-with-at-least-32-bytes";
let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => error ? reject(error) : resolve()));
  server = null;
});

describe("public API", () => {
  it("keeps /health independent from Airtable configuration", async () => {
    const { baseUrl } = await startApp(new MemoryStore(null));
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("serves /d/:token publicly with privacy and indexing headers", async () => {
    const record = accessRecord();
    const { baseUrl } = await startApp(new MemoryStore(record));
    const token = signAccessLink(record, secret);
    const response = await fetch(`${baseUrl}/d/${token}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(html).toContain('<meta name="robots" content="noindex,nofollow,noarchive">');
  });

  it("serves a valid /p/:token with public-route security headers", async () => {
    const grant = portalRecord();
    const { baseUrl } = await startApp(new MemoryStore(null), grant);
    const response = await fetch(`${baseUrl}/p/${signPortalGrantToken(grant, secret)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
  });

  it("redirects expired portal tokens to /link-expired", async () => {
    const grant = portalRecord({ expiresAt: new Date(Date.now() - 1) });
    const { baseUrl } = await startApp(new MemoryStore(null), grant);
    const response = await fetch(
      `${baseUrl}/p/${signPortalGrantToken(grant, secret)}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/link-expired");
    const expiredPage = await fetch(`${baseUrl}/link-expired`);
    expect(expiredPage.status).toBe(200);
    expect(await expiredPage.text()).toContain("Ten link wygasł");
  });

  it("returns 404 for an invalid portal token", async () => {
    const { baseUrl } = await startApp(new MemoryStore(null), portalRecord());
    const response = await fetch(`${baseUrl}/p/invalid`);
    expect(response.status).toBe(404);
  });

  it("does not let query parameters change portal hospital scope", async () => {
    const grant = portalRecord({ sourceHospitalRecordId: "hospital-A" });
    let authorization: PortalAuthorizationContext | null = null;
    const { baseUrl } = await startApp(
      new MemoryStore(null),
      grant,
      new MemoryUnsubscribeStore(null),
      async (value) => {
        authorization = value;
        return emptyPortalView();
      },
    );
    const response = await fetch(
      `${baseUrl}/p/${signPortalGrantToken(grant, secret)}?hospitalId=hospital-B`,
    );
    expect(response.status).toBe(200);
    expect(authorization?.sourceHospitalRecordId).toBe("hospital-A");
  });

  it("keeps paginated search and detail endpoints inside grant scope", async () => {
    const grant = portalRecord({ sourceHospitalRecordId: "hospital-A" });
    const scopes: string[] = [];
    const { baseUrl } = await startApp(
      new MemoryStore(null), grant, new MemoryUnsubscribeStore(null),
      async () => emptyPortalView(),
      {
        listCases: async (authorization) => {
          scopes.push(authorization.sourceHospitalRecordId);
          return { items: [], nextCursor: null };
        },
        getCase: async (authorization) => {
          scopes.push(authorization.sourceHospitalRecordId);
          return null;
        },
        getDevice: async (authorization) => {
          scopes.push(authorization.sourceHospitalRecordId);
          return null;
        },
      },
    );
    const token = signPortalGrantToken(grant, secret);
    const page = await fetch(`${baseUrl}/p/${token}/data/cases?q=secret&hospitalId=hospital-B`);
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ items: [], nextCursor: null });
    expect((await fetch(`${baseUrl}/p/${token}/data/cases/case-B`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/p/${token}/data/devices/device-B`)).status).toBe(404);
    expect(scopes).toEqual(["hospital-A", "hospital-A", "hospital-A"]);
  });

  it("GET unsubscribe only displays confirmation and POST records opt-out", async () => {
    const record = unsubscribeRecord();
    const unsubscribeStore = new MemoryUnsubscribeStore(record);
    const { baseUrl } = await startApp(new MemoryStore(null), null, unsubscribeStore);
    const token = signUnsubscribeToken(record, secret);
    const get = await fetch(`${baseUrl}/u/${token}`);
    expect(get.status).toBe(200);
    expect(unsubscribeStore.optOuts).toHaveLength(0);
    const post = await fetch(`${baseUrl}/u/${token}`, { method: "POST" });
    expect(post.status).toBe(200);
    expect(unsubscribeStore.optOuts).toEqual([["recHospital", "client@example.com"]]);
  });
});

class MemoryStore implements PublicAccessLinkStore {
  constructor(private readonly record: PublicAccessLinkRecord | null) {}

  async findByPublicId(publicId: string): Promise<PublicAccessLinkRecord | null> {
    return this.record?.publicId === publicId ? this.record : null;
  }

  async recordValidOpen(): Promise<boolean> { return true; }
}

class MemoryPortalStore implements PublicPortalAccessStore {
  constructor(private readonly record: PublicPortalAccessGrant | null) {}
  async findByPublicId(publicId: string) {
    return this.record?.publicId === publicId ? this.record : null;
  }
  async recordValidOpen(): Promise<boolean> { return true; }
}

class MemoryUnsubscribeStore implements PublicUnsubscribeStore {
  optOuts: Array<[string, string]> = [];
  constructor(private readonly record: UnsubscribeTokenPayload | null) {}
  async findByPublicId(id: string) { return this.record?.publicId === id ? this.record : null; }
  async optOut(hospital: string, email: string) { this.optOuts.push([hospital, email]); }
}

async function startApp(
  store: PublicAccessLinkStore,
  portalGrant: PublicPortalAccessGrant | null = null,
  unsubscribeStore: PublicUnsubscribeStore = new MemoryUnsubscribeStore(null),
  buildPortal: (authorization: PortalAuthorizationContext) => Promise<HospitalPortalViewModel> =
    async () => emptyPortalView(),
  dataViews: {
    listCases?: (authorization: PortalAuthorizationContext) => Promise<{ items: []; nextCursor: null }>;
    getCase?: (authorization: PortalAuthorizationContext) => Promise<null>;
    getDevice?: (authorization: PortalAuthorizationContext) => Promise<null>;
  } = {},
): Promise<{ baseUrl: string }> {
  const prisma = {
    $queryRaw: async () => [{ ok: 1 }],
  } as unknown as PrismaClient;
  const app = createApp(
    prisma,
    new PublicAccessLinkService(store, secret),
    new PublicPortalAccessService(new MemoryPortalStore(portalGrant), secret),
    new PublicUnsubscribeService(unsubscribeStore, secret),
    { portalViews: {
      build: buildPortal,
      listCases: dataViews.listCases ?? (async () => ({ items: [], nextCursor: null })),
      getCase: dataViews.getCase ?? (async () => null),
      listDevices: async () => ({ items: [], nextCursor: null }),
      getDevice: dataViews.getDevice ?? (async () => null),
    } },
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function emptyPortalView(): HospitalPortalViewModel {
  return {
    hospital: { shortName: "Szpital", name: "Szpital", address: null },
    serviceProviderName: "Tiemed",
    summary: { requiresAction: 0, repairs: 0, inspections: 0 },
    initialCases: { items: [], nextCursor: null },
    focusedCase: null,
  };
}

function unsubscribeRecord(): UnsubscribeTokenPayload {
  return {
    publicId: "unsubscribepublicid00001", communicationDeliveryId: "deliveryId",
    sourceHospitalRecordId: "recHospital", normalizedEmail: "client@example.com",
    canOptOut: true, expiresAt: new Date(Date.now() + 60_000),
  };
}

function portalRecord(
  overrides: Partial<PublicPortalAccessGrant> = {},
): PublicPortalAccessGrant {
  return {
    id: "portalGrantId",
    publicId: "portalpublicid0000000001",
    communicationDeliveryId: "deliveryId",
    sourceHospitalRecordId: "recHospital",
    entryContext: {
      type: "SERVICE_ORDER",
      sourceRecordId: "recService",
      scenario: CommunicationScenario.REPAIR_RECEIVED,
    },
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    ...overrides,
  };
}

function accessRecord(): PublicAccessLinkRecord {
  return {
    id: "link-id",
    publicId: "abcdefghijklmnopqrstuvwx",
    digestId: "digest-id",
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    digest: {
      items: [{
        trackedCase: {
          caseType: "SERVICE_ORDER",
          businessNumber: "20905",
          deviceName: "Aparat USG",
          manufacturer: null,
          model: null,
          serialNumber: null,
          inventoryNumber: null,
          currentStatus: "Naprawa zakończona",
          faultDescription: null,
          inspectionDueDate: null,
          inspectionScheduledDate: null,
          inspectionBookingStatus: null,
          events: [],
        },
      }],
    },
  };
}
