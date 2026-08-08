import { describe, expect, it } from "vitest";
import {
  PublicAccessLinkService,
  type PublicAccessLinkRecord,
  type PublicAccessLinkStore,
  type PublicTrackedCase,
} from "./public-page.js";
import { signAccessLink } from "./token.js";

const secret = "test-access-link-signing-secret-with-at-least-32-bytes";
const now = new Date("2026-08-08T18:00:00.000Z");

class MemoryPublicStore implements PublicAccessLinkStore {
  openCount = 0;
  lastOpenedAt: Date | null = null;

  constructor(public record: PublicAccessLinkRecord | null) {}

  async findByPublicId(publicId: string): Promise<PublicAccessLinkRecord | null> {
    return this.record?.publicId === publicId ? this.record : null;
  }

  async recordValidOpen(id: string, openedAt: Date): Promise<boolean> {
    if (!this.record || this.record.id !== id || this.record.revokedAt ||
        this.record.expiresAt.getTime() <= openedAt.getTime()) return false;
    this.openCount += 1;
    this.lastOpenedAt = openedAt;
    return true;
  }
}

describe("public AccessLink page", () => {
  it("returns 200 and atomically records a valid open", async () => {
    const record = accessRecord();
    const store = new MemoryPublicStore(record);
    const result = await new PublicAccessLinkService(store, secret)
      .open(tokenFor(record), now);
    expect(result.status).toBe(200);
    expect(store.openCount).toBe(1);
    expect(store.lastOpenedAt).toEqual(now);
  });

  it("returns the same 404 for unknown publicId and invalid signature without counting", async () => {
    const record = accessRecord();
    const store = new MemoryPublicStore(record);
    const service = new PublicAccessLinkService(store, secret);
    const validToken = tokenFor(record);
    const invalidToken = validToken.slice(0, -1) +
      (validToken.endsWith("A") ? "B" : "A");
    expect((await service.open(invalidToken, now)).status).toBe(404);
    const unknown = signAccessLink({
      publicId: "zyxwvutsrqponmlkjihgfedc",
      digestId: record.digestId,
      expiresAt: record.expiresAt,
    }, secret);
    expect((await service.open(unknown, now)).status).toBe(404);
    expect(store.openCount).toBe(0);
  });

  it("returns 410 for expired or revoked links without counting", async () => {
    const expired = accessRecord({ expiresAt: new Date(now.getTime() - 1) });
    const expiredStore = new MemoryPublicStore(expired);
    expect((await new PublicAccessLinkService(expiredStore, secret)
      .open(tokenFor(expired), now)).status).toBe(410);
    expect(expiredStore.openCount).toBe(0);

    const revoked = accessRecord({ revokedAt: new Date(now.getTime() - 1) });
    const revokedStore = new MemoryPublicStore(revoked);
    expect((await new PublicAccessLinkService(revokedStore, secret)
      .open(tokenFor(revoked), now)).status).toBe(410);
    expect(revokedStore.openCount).toBe(0);
  });

  it("shows every DigestItem, current status and escaped customer data", async () => {
    const currentCases = Array.from({ length: 6 }, (_, index) =>
      trackedCase(index + 1));
    currentCases[0] = {
      ...currentCases[0]!,
      deviceName: "USG <script>alert(1)</script>",
      currentStatus: "Naprawa zakończona & odebrana",
      faultDescription: "Brak <obrazu>",
      events: [{
        eventType: "SERVICE_STATUS_CHANGED",
        oldValue: "Naprawa w toku <old>",
        newValue: "Naprawa zakończona",
        detectedAt: now,
      }],
      ...({
        airtableRecordId: "recAirtableSecret",
        email: "client@example.com",
      } as object),
    };
    const record = accessRecord({
      digest: { items: currentCases.map((trackedCase) => ({ trackedCase })) },
    });
    const result = await new PublicAccessLinkService(
      new MemoryPublicStore(record),
      secret,
    ).open(tokenFor(record), now);

    expect(result.status).toBe(200);
    for (let index = 2; index <= 6; index += 1) {
      expect(result.html).toContain(`Device ${index}`);
    }
    expect(result.html).toContain("Naprawa zakończona &amp; odebrana");
    expect(result.html).not.toContain("Naprawa w toku jako snapshot");
    expect(result.html).toContain("USG &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(result.html).toContain("Brak &lt;obrazu&gt;");
    expect(result.html).not.toContain("<script>alert(1)</script>");
    expect(result.html).not.toContain("client@example.com");
    expect(result.html).not.toContain("recAirtableSecret");
    expect(result.html).not.toContain(record.id);
    expect(result.html).not.toContain(record.digestId);
  });
});

function accessRecord(
  overrides: Partial<PublicAccessLinkRecord> = {},
): PublicAccessLinkRecord {
  return {
    id: "db-access-link-id-secret",
    publicId: "abcdefghijklmnopqrstuvwx",
    digestId: "db-digest-id-secret",
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    revokedAt: null,
    digest: { items: [{ trackedCase: trackedCase(1) }] },
    ...overrides,
  };
}

function tokenFor(record: PublicAccessLinkRecord): string {
  return signAccessLink(record, secret);
}

function trackedCase(index: number): PublicTrackedCase {
  return {
    caseType: "SERVICE_ORDER",
    businessNumber: String(20_900 + index),
    deviceName: `Device ${index}`,
    manufacturer: "Philips",
    model: `Model ${index}`,
    serialNumber: `SN-${index}`,
    inventoryNumber: `INV-${index}`,
    currentStatus: index === 1 ? "Naprawa zakończona" : `Status ${index}`,
    faultDescription: null,
    inspectionDueDate: null,
    inspectionScheduledDate: null,
    inspectionBookingStatus: null,
    events: [],
  };
}
