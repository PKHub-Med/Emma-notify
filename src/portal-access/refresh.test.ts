import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "../generated/prisma/client.js";
import { PortalAccessLevel, PortalRefreshStatus } from "../generated/prisma/enums.js";
import type { PortalAuthorizationContext } from "./public.js";
import {
  PortalRefreshService,
  PrismaPortalRefreshRequestStore,
  type PortalRefreshRequestStore,
} from "./refresh.js";
import type { PortalRefreshScopeRecordIds } from "./view-model.js";

describe("portal refresh requests", () => {
  it("keeps AIRTABLE_PAT out of the API process", () => {
    const apiSources = [
      "src/api/index.ts",
      "src/api/app.ts",
      "src/config/api.ts",
      "src/portal-access/refresh.ts",
    ].map((path) => readFileSync(path, "utf8")).join("\n");
    expect(apiSources).not.toContain("AIRTABLE_PAT");
    expect(readFileSync("src/config/worker.ts", "utf8")).toContain("AIRTABLE_PAT");
  });

  it("deduplicates double clicks to one active request for the grant and hospital", async () => {
    const store = new MemoryRefreshStore();
    const resolver = { resolveRefreshScope: vi.fn().mockResolvedValue(refreshScope()) };
    const service = new PortalRefreshService(store, resolver, () =>
      new Date("2026-09-12T10:00:00Z"));

    const [first, second] = await Promise.all([
      service.request(auth("grant-A", "hospital-A", "delivery-A")),
      service.request(auth("grant-A", "hospital-A", "delivery-A")),
    ]);

    expect(first.requestId).toBe(second.requestId);
    expect(store.requests).toHaveLength(1);
    expect(resolver.resolveRefreshScope).toHaveBeenCalledTimes(2);
  });

  it("does not expose a request to a token from another hospital or grant", async () => {
    const store = new MemoryRefreshStore();
    const service = new PortalRefreshService(
      store,
      { resolveRefreshScope: async () => refreshScope() },
    );
    const owner = auth("grant-A", "hospital-A", "delivery-A");
    const request = await service.request(owner);

    await expect(service.status(owner, request.requestId)).resolves.toMatchObject({
      requestId: request.requestId,
    });
    await expect(service.status(
      auth("grant-B", "hospital-B", "delivery-B"),
      request.requestId,
    )).resolves.toBeNull();
  });

  it("fails closed if the resolved policy scope does not match the token hospital", async () => {
    const store = new MemoryRefreshStore();
    const mismatched = refreshScope();
    mismatched.scope.hospitalId = "hospital-B";
    const service = new PortalRefreshService(
      store,
      { resolveRefreshScope: async () => mismatched },
    );
    await expect(service.request(
      auth("grant-A", "hospital-A", "delivery-A"),
    )).rejects.toThrow("PORTAL_REFRESH_SCOPE_MISMATCH");
    expect(store.requests).toEqual([]);
  });

  it.each([PortalAccessLevel.COMMUNICATION, PortalAccessLevel.FULL])(
    "stores the server-resolved %s scope and all record categories",
    async (accessLevel) => {
      const store = new MemoryRefreshStore();
      const scope = refreshScope(accessLevel);
      const service = new PortalRefreshService(
        store,
        { resolveRefreshScope: async () => scope },
      );
      await service.request(auth("grant-A", "hospital-A", "delivery-A"));
      expect(store.requests[0]?.scope).toEqual(scope);
      expect(store.requests[0]?.scope).toMatchObject({
        serviceOrderRecordIds: ["service-A"],
        inspectionRecordIds: ["inspection-A"],
        deviceRecordIds: ["device-A"],
        taskRecordIds: ["task-A"],
        scope: { accessLevel, hospitalId: "hospital-A" },
      });
    },
  );

  it("binds database status lookup to grant, hospital and delivery", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const store = new PrismaPortalRefreshRequestStore({
      portalRefreshRequest: { findFirst },
    } as unknown as PrismaClient);
    await store.findAuthorized(auth("grant-A", "hospital-A", "delivery-A"), "request-B");
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: "request-B",
      portalAccessGrantId: "grant-A",
      sourceHospitalRecordId: "hospital-A",
      communicationDeliveryId: "delivery-A",
    } }));
  });

  it("uses one unique active database key for repeated enqueue attempts", async () => {
    const upsert = vi.fn().mockResolvedValue({
      id: "request-1",
      status: PortalRefreshStatus.PENDING,
      requestedAt: new Date("2026-09-12T10:00:00Z"),
      completedAt: null,
    });
    const store = new PrismaPortalRefreshRequestStore({
      portalRefreshRequest: { upsert },
    } as unknown as PrismaClient);
    await store.enqueue(
      auth("grant-A", "hospital-A", "delivery-A"),
      refreshScope(),
      new Date("2026-09-12T10:00:00Z"),
    );
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { activeKey: "grant-A:hospital-A" },
      update: {},
    }));
  });
});

class MemoryRefreshStore implements PortalRefreshRequestStore {
  requests: Array<{
    id: string;
    authorization: PortalAuthorizationContext;
    scope: PortalRefreshScopeRecordIds;
    requestedAt: Date;
  }> = [];

  async enqueue(
    authorization: PortalAuthorizationContext,
    scope: PortalRefreshScopeRecordIds,
    requestedAt: Date,
  ) {
    const existing = this.requests.find((item) =>
      item.authorization.portalAccessGrantId === authorization.portalAccessGrantId &&
      item.authorization.sourceHospitalRecordId === authorization.sourceHospitalRecordId);
    const request = existing ?? {
      id: `request-${this.requests.length + 1}`,
      authorization,
      scope,
      requestedAt,
    };
    if (!existing) this.requests.push(request);
    return {
      requestId: request.id,
      status: PortalRefreshStatus.PENDING,
      requestedAt: request.requestedAt,
      completedAt: null,
    };
  }

  async findAuthorized(authorization: PortalAuthorizationContext, requestId: string) {
    const request = this.requests.find((item) => item.id === requestId &&
      item.authorization.portalAccessGrantId === authorization.portalAccessGrantId &&
      item.authorization.sourceHospitalRecordId === authorization.sourceHospitalRecordId &&
      item.authorization.communicationDeliveryId === authorization.communicationDeliveryId);
    return request ? {
      requestId,
      status: PortalRefreshStatus.PENDING,
      requestedAt: request.requestedAt,
      completedAt: null,
    } : null;
  }
}

function auth(
  portalAccessGrantId: string,
  sourceHospitalRecordId: string,
  communicationDeliveryId: string,
): PortalAuthorizationContext {
  return {
    portalAccessGrantId,
    sourceHospitalRecordId,
    communicationDeliveryId,
    entryContext: { type: "SERVICE_ORDER", sourceRecordId: "service-A" },
  };
}

function refreshScope(
  accessLevel = PortalAccessLevel.COMMUNICATION,
): PortalRefreshScopeRecordIds {
  return {
    scope: {
      hospitalId: "hospital-A",
      accessLevel,
      communicationDeliveryId: "delivery-A",
      contextType: "REPAIR",
      contextId: "service-A",
    },
    serviceOrderRecordIds: ["service-A"],
    inspectionRecordIds: ["inspection-A"],
    deviceRecordIds: ["device-A"],
    taskRecordIds: ["task-A"],
  };
}
