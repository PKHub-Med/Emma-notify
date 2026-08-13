import { describe, expect, it } from "vitest";
import {
  PublicPortalAccessService,
  type PublicPortalAccessGrant,
  type PublicPortalAccessStore,
} from "./public.js";
import { signPortalGrantToken } from "./token.js";
import { CommunicationScenario } from "../generated/prisma/enums.js";

const secret = "test-access-link-signing-secret-with-at-least-32-bytes";
const now = new Date("2026-08-15T10:00:00Z");

describe("PublicPortalAccessService", () => {
  it("validates a token and returns hospital authorization plus entry context", async () => {
    const grant = record();
    const store = new MemoryPublicPortalStore(grant);
    const result = await service(store).open(token(grant), now);
    expect(result).toEqual({
      outcome: "VALID",
      authorization: {
        sourceHospitalRecordId: "recHospital",
        entryContext: grant.entryContext,
      },
    });
  });

  it("atomically increments openCount and updates lastOpenedAt", async () => {
    const grant = record();
    const store = new MemoryPublicPortalStore(grant);
    await service(store).open(token(grant), now);
    expect(store.openCount).toBe(1);
    expect(store.lastOpenedAt).toEqual(now);
  });

  it("authorizes paginated data without incrementing page openCount", async () => {
    const grant = record();
    const store = new MemoryPublicPortalStore(grant);
    const result = await service(store).authorizeData(token(grant), now);
    expect(result.outcome).toBe("VALID");
    expect(store.openCount).toBe(0);
  });

  it("rejects a one-character token change as NOT_FOUND", async () => {
    const grant = record();
    const valid = token(grant);
    const changed = valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A");
    expect(await service(new MemoryPublicPortalStore(grant)).open(changed, now))
      .toEqual({ outcome: "NOT_FOUND" });
  });

  it("does not let a token for another grant authorize this grant", async () => {
    const grant = record();
    const other = record({
      publicId: grant.publicId,
      communicationDeliveryId: "anotherDelivery",
    });
    expect(await service(new MemoryPublicPortalStore(grant)).open(token(other), now))
      .toEqual({ outcome: "NOT_FOUND" });
  });

  it("returns INACTIVE for expired and revoked grants without counting", async () => {
    for (const grant of [
      record({ expiresAt: new Date(now.getTime() - 1) }),
      record({ revokedAt: new Date(now.getTime() - 1) }),
    ]) {
      const store = new MemoryPublicPortalStore(grant);
      expect(await service(store).open(token(grant), now))
        .toEqual({ outcome: "INACTIVE" });
      expect(store.openCount).toBe(0);
    }
  });

  it("returns identical NOT_FOUND for malformed and unknown tokens", async () => {
    const grant = record();
    const store = new MemoryPublicPortalStore(grant);
    expect(await service(store).open("invalid", now)).toEqual({ outcome: "NOT_FOUND" });
    const unknown = record({ publicId: "unknownportalpublicid0001" });
    expect(await service(store).open(token(unknown), now)).toEqual({ outcome: "NOT_FOUND" });
  });
});

class MemoryPublicPortalStore implements PublicPortalAccessStore {
  openCount = 0;
  lastOpenedAt: Date | null = null;
  constructor(private readonly grant: PublicPortalAccessGrant | null) {}
  async findByPublicId(publicId: string) {
    return this.grant?.publicId === publicId ? this.grant : null;
  }
  async recordValidOpen(id: string, at: Date) {
    if (!this.grant || this.grant.id !== id || this.grant.revokedAt ||
      this.grant.expiresAt.getTime() <= at.getTime()) return false;
    this.openCount += 1;
    this.lastOpenedAt = at;
    return true;
  }
}

function service(store: PublicPortalAccessStore) {
  return new PublicPortalAccessService(store, secret);
}

function token(grant: PublicPortalAccessGrant) {
  return signPortalGrantToken(grant, secret);
}

function record(
  overrides: Partial<PublicPortalAccessGrant> = {},
): PublicPortalAccessGrant {
  return {
    id: "grantId",
    publicId: "portalpublicid0000000001",
    communicationDeliveryId: "deliveryId",
    sourceHospitalRecordId: "recHospital",
    entryContext: {
      type: "SERVICE_ORDER",
      sourceRecordId: "recService",
      scenario: CommunicationScenario.REPAIR_RECEIVED,
    },
    expiresAt: new Date(now.getTime() + 60_000),
    revokedAt: null,
    ...overrides,
  };
}
