import { describe, expect, it, vi } from "vitest";
import {
  CommunicationDeliveryStatus,
  CommunicationScenario,
  CommunicationSourceEntityType,
} from "../generated/prisma/enums.js";
import {
  PortalAccessGrantService,
  type PortalAccessGrantRecord,
  type PortalAccessGrantStore,
  type PortalDeliverySource,
} from "./service.js";
import { verifyPortalGrantToken } from "./token.js";

const secret = "test-access-link-signing-secret-with-at-least-32-bytes";
const now = new Date("2026-08-15T10:00:00.000Z");

describe("PortalAccessGrantService", () => {
  it("creates one grant for a READY delivery", async () => {
    const store = new MemoryGrantStore([serviceDelivery("deliveryA")]);
    const result = await service(store).getOrCreatePortalAccessGrant("deliveryA", now);
    expect(store.grants).toHaveLength(1);
    expect(result.url).toMatch(/^https:\/\/notify\.example\.org\/p\//);
  });

  it("returns exactly the same grant and link on sender retry", async () => {
    const store = new MemoryGrantStore([serviceDelivery("deliveryA")]);
    const grants = service(store);
    const first = await grants.getOrCreatePortalAccessGrant("deliveryA", now);
    const retry = await grants.getOrCreatePortalAccessGrant(
      "deliveryA",
      new Date(now.getTime() + 60_000),
    );
    expect(store.grants).toHaveLength(1);
    expect(retry).toEqual(first);
  });

  it("creates different grants and links for two recipient deliveries", async () => {
    const store = new MemoryGrantStore([
      serviceDelivery("deliveryA"), serviceDelivery("deliveryB"),
    ]);
    const grants = service(store);
    const first = await grants.getOrCreatePortalAccessGrant("deliveryA", now);
    const second = await grants.getOrCreatePortalAccessGrant("deliveryB", now);
    expect(store.grants).toHaveLength(2);
    expect(first.url).not.toBe(second.url);
  });

  it("creates an independent grant for a fallback recipient delivery", async () => {
    const store = new MemoryGrantStore([serviceDelivery("fallbackDelivery")]);
    const result = await service(store).getOrCreatePortalAccessGrant(
      "fallbackDelivery",
      now,
    );
    expect(result.grant.communicationDeliveryId).toBe("fallbackDelivery");
  });

  it("rejects missing hospital scope without persisting a grant", async () => {
    const delivery = serviceDelivery("deliveryA");
    delivery.event.eventSnapshot = { sourceHospitalRecordId: null };
    const store = new MemoryGrantStore([delivery]);
    await expect(service(store).getOrCreatePortalAccessGrant("deliveryA", now))
      .rejects.toThrow("MISSING_HOSPITAL_SCOPE");
    expect(store.grants).toHaveLength(0);
  });

  it("starts the 30-day TTL at just-in-time grant creation", async () => {
    const store = new MemoryGrantStore([serviceDelivery("deliveryA")]);
    const result = await service(store).getOrCreatePortalAccessGrant("deliveryA", now);
    expect(result.grant.createdAt).toEqual(now);
    expect(result.grant.expiresAt).toEqual(
      new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    );
  });

  it("does not create a grant for SCHEDULED delivery", async () => {
    const delivery = serviceDelivery("deliveryA");
    delivery.status = CommunicationDeliveryStatus.SCHEDULED;
    const store = new MemoryGrantStore([delivery]);
    await expect(service(store).getOrCreatePortalAccessGrant("deliveryA", now))
      .rejects.toThrow("COMMUNICATION_DELIVERY_NOT_READY");
    expect(store.grants).toHaveLength(0);
  });

  it("allows first JIT grant after sender atomically claims delivery as SENDING", async () => {
    const delivery = serviceDelivery("deliveryA");
    delivery.status = CommunicationDeliveryStatus.SENDING;
    const store = new MemoryGrantStore([delivery]);
    expect((await service(store).getOrCreatePortalAccessGrant("deliveryA", now)).grant)
      .toMatchObject({ communicationDeliveryId: "deliveryA" });
  });

  it("persists no full token, URL, email or personal data", async () => {
    const store = new MemoryGrantStore([serviceDelivery("deliveryA")]);
    const result = await service(store).getOrCreatePortalAccessGrant("deliveryA", now);
    const persisted = JSON.stringify(store.grants[0]);
    expect(persisted).not.toContain(result.url);
    expect(persisted).not.toContain(result.url.split("/p/")[1]!);
    expect(persisted).not.toContain("email");
  });

  it("does not log the full token", async () => {
    const logger = vi.spyOn(console, "info");
    const store = new MemoryGrantStore([serviceDelivery("deliveryA")]);
    const result = await service(store).getOrCreatePortalAccessGrant("deliveryA", now);
    expect(logger).not.toHaveBeenCalledWith(expect.stringContaining(result.url));
    logger.mockRestore();
  });

  it("creates SERVICE_ORDER hospital scope and entry context from the event", async () => {
    const store = new MemoryGrantStore([serviceDelivery("deliveryA")]);
    const { grant } = await service(store).getOrCreatePortalAccessGrant("deliveryA", now);
    expect(grant.sourceHospitalRecordId).toBe("recHospitalService");
    expect(grant.entryContext).toEqual({
      type: "SERVICE_ORDER",
      sourceRecordId: "recService",
      scenario: CommunicationScenario.REPAIR_RECEIVED,
    });
  });

  it("creates TASK context with linked inspections and service orders", async () => {
    const store = new MemoryGrantStore([taskDelivery("deliveryTask")]);
    const { grant } = await service(store).getOrCreatePortalAccessGrant("deliveryTask", now);
    expect(grant.sourceHospitalRecordId).toBe("recHospitalTask");
    expect(grant.entryContext).toEqual({
      type: "TASK",
      sourceRecordId: "recTask",
      scenario: CommunicationScenario.INSPECTION_REMINDER,
      linkedInspectionRecordIds: ["recInspectionA", "recInspectionB"],
      linkedServiceOrderRecordIds: ["recServiceA"],
    });
  });

  it("does not allow entryContext to widen the signed hospital scope", async () => {
    const store = new MemoryGrantStore([taskDelivery("deliveryTask")]);
    const { grant, url } = await service(store).getOrCreatePortalAccessGrant("deliveryTask", now);
    const token = url.split("/p/")[1]!;
    expect(verifyPortalGrantToken(token, {
      ...grant,
      sourceHospitalRecordId: "recDifferentHospital",
    }, secret)).toBe(false);
  });

  it("does not call Resend while creating a grant", async () => {
    const resend = vi.fn();
    const store = new MemoryGrantStore([serviceDelivery("deliveryA")]);
    await service(store).getOrCreatePortalAccessGrant("deliveryA", now);
    expect(resend).not.toHaveBeenCalled();
  });
});

class MemoryGrantStore implements PortalAccessGrantStore {
  grants: PortalAccessGrantRecord[] = [];
  constructor(private readonly deliveries: PortalDeliverySource[]) {}
  async findDelivery(id: string) {
    return this.deliveries.find((delivery) => delivery.id === id) ?? null;
  }
  async findByDeliveryId(id: string) {
    return this.grants.find((grant) => grant.communicationDeliveryId === id) ?? null;
  }
  async create(record: PortalAccessGrantRecord) {
    if (this.grants.some((grant) =>
      grant.publicId === record.publicId ||
      grant.communicationDeliveryId === record.communicationDeliveryId)) {
      throw new Error("PORTAL_ACCESS_GRANT_UNIQUE_CONFLICT");
    }
    this.grants.push(record);
    return record;
  }
}

function service(store: PortalAccessGrantStore) {
  let sequence = 0;
  return new PortalAccessGrantService(store, {
    signingSecret: secret,
    publicBaseUrl: "https://notify.example.org/",
    ttlDays: 30,
    generatePublicId: () => `portalpublicid${String(++sequence).padStart(10, "0")}`,
  });
}

function serviceDelivery(id: string): PortalDeliverySource {
  return {
    id,
    status: CommunicationDeliveryStatus.READY,
    event: {
      sourceEntityType: CommunicationSourceEntityType.SERVICE_ORDER,
      sourceRecordId: "recService",
      scenario: CommunicationScenario.REPAIR_RECEIVED,
      eventSnapshot: { sourceHospitalRecordId: "recHospitalService" },
    },
  };
}

function taskDelivery(id: string): PortalDeliverySource {
  return {
    id,
    status: CommunicationDeliveryStatus.READY,
    event: {
      sourceEntityType: CommunicationSourceEntityType.TASK,
      sourceRecordId: "recTask",
      scenario: CommunicationScenario.INSPECTION_REMINDER,
      eventSnapshot: {
        sourceHospitalRecordId: "recHospitalTask",
        linkedInspectionRecordIds: ["recInspectionA", "recInspectionB"],
        linkedServiceOrderRecordIds: ["recServiceA"],
      },
    },
  };
}
