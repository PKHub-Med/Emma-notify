import { describe, expect, it, vi } from "vitest";
import {
  CommunicationSourceEntityType,
} from "../generated/prisma/enums.js";
import {
  INSPECTION_ATTACHMENT_FIELDS,
  SERVICE_ORDER_ATTACHMENT_FIELDS,
} from "../airtable/field-ids.js";
import type { AirtableIncrementalSource, AirtableRecord } from "../airtable/types.js";
import {
  synchronizeCaseAttachments,
  type CaseAttachmentSyncResult,
  type CaseAttachmentSyncStore,
  type CaseAttachmentSyncTarget,
} from "./case-attachment-sync.js";
import type { DiscoveredAsset } from "./communication-assets.js";

describe("case attachment synchronization", () => {
  it("discovers two photos for a current or historical repair without creating mail state", async () => {
    const store = new MemoryCaseAssetStore();
    const airtable = source(record("repair-25133", {
      [SERVICE_ORDER_ATTACHMENT_FIELDS.photo1]: [attachment("att-1", "one.jpg", "image/jpeg")],
      [SERVICE_ORDER_ATTACHMENT_FIELDS.photo2]: [attachment("att-2", "two.jpg", "image/jpeg")],
    }));
    const result = await synchronizeCaseAttachments({
      target: target("repair-25133", "H1", CommunicationSourceEntityType.SERVICE_ORDER),
      airtable, store,
    });
    expect(result).toMatchObject({ discovered: 2, created: 2, removed: 0 });
    expect(store.activeIds()).toEqual(["att-1", "att-2"]);
  });

  it("discovers a historical inspection document and photo", async () => {
    const store = new MemoryCaseAssetStore();
    const airtable = source(record("inspection-old", {
      [INSPECTION_ATTACHMENT_FIELDS.documents]: [attachment("doc-1", "protocol.pdf", "application/pdf")],
      [INSPECTION_ATTACHMENT_FIELDS.photos]: [attachment("photo-1", "inspection.jpg", "image/jpeg")],
    }));
    const result = await synchronizeCaseAttachments({
      target: target("inspection-old", "H1", CommunicationSourceEntityType.INSPECTION),
      airtable, store,
    });
    expect(result.discovered).toBe(2);
    expect(store.activeIds()).toEqual(["doc-1", "photo-1"]);
  });

  it("reuses unchanged files, adds a later photo and hides a removed photo", async () => {
    const store = new MemoryCaseAssetStore();
    const sync = (values: unknown[]) => synchronizeCaseAttachments({
      target: target("repair-1", "H1", CommunicationSourceEntityType.SERVICE_ORDER),
      airtable: source(record("repair-1", {
        [SERVICE_ORDER_ATTACHMENT_FIELDS.photo1]: values,
      })),
      store,
    });
    await sync([attachment("att-1", "one.jpg", "image/jpeg")]);
    expect(await sync([
      attachment("att-1", "one.jpg", "image/jpeg"),
      attachment("att-2", "two.jpg", "image/jpeg"),
    ])).toMatchObject({ created: 1, reused: 1 });
    expect(await sync([attachment("att-2", "two.jpg", "image/jpeg")]))
      .toMatchObject({ created: 0, reused: 1, removed: 1 });
    expect(store.activeIds()).toEqual(["att-2"]);
  });

  it("is idempotent during parallel refreshes", async () => {
    const store = new MemoryCaseAssetStore();
    const run = () => synchronizeCaseAttachments({
      target: target("repair-1", "H1", CommunicationSourceEntityType.SERVICE_ORDER),
      airtable: source(record("repair-1", {
        [SERVICE_ORDER_ATTACHMENT_FIELDS.photo1]: [attachment("att-1", "one.jpg", "image/jpeg")],
      })),
      store,
    });
    await Promise.all([run(), run()]);
    expect(store.activeIds()).toEqual(["att-1"]);
  });

  it("fails closed for a different Hospital and sanitizes logs", async () => {
    const store = new MemoryCaseAssetStore(false);
    const fetchRecord = vi.fn();
    const logs: string[] = [];
    await synchronizeCaseAttachments({
      target: target("record\nAuthorization: secret", "H2", CommunicationSourceEntityType.SERVICE_ORDER),
      airtable: { fetchRecord } as unknown as AirtableIncrementalSource,
      store,
      log: (message) => logs.push(message),
    });
    expect(fetchRecord).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toContain("Authorization:");
    expect(logs.join("\n")).not.toContain("secret\n");
  });
});

class MemoryCaseAssetStore implements CaseAttachmentSyncStore {
  private readonly known = new Set<string>();
  private readonly active = new Set<string>();
  constructor(private readonly authorized = true) {}
  async isAuthorized() { return this.authorized; }
  async synchronize(
    _target: CaseAttachmentSyncTarget,
    assets: readonly DiscoveredAsset[],
  ): Promise<CaseAttachmentSyncResult> {
    let created = 0;
    let reused = 0;
    for (const asset of assets) {
      this.known.has(asset.sourceAttachmentId) ? reused += 1 : created += 1;
      this.known.add(asset.sourceAttachmentId);
    }
    const next = new Set(assets.map((asset) => asset.sourceAttachmentId));
    const removed = [...this.active].filter((id) => !next.has(id)).length;
    this.active.clear();
    next.forEach((id) => this.active.add(id));
    return { discovered: assets.length, created, reused, removed };
  }
  activeIds() { return [...this.active].sort(); }
}

function target(
  sourceRecordId: string,
  sourceHospitalRecordId: string,
  sourceEntityType: CommunicationSourceEntityType,
): CaseAttachmentSyncTarget {
  return { sourceRecordId, sourceHospitalRecordId, sourceEntityType };
}

function source(value: AirtableRecord): AirtableIncrementalSource {
  return { fetchRecord: async () => value } as unknown as AirtableIncrementalSource;
}

function record(id: string, fields: Record<string, unknown>): AirtableRecord {
  return { id, createdTime: "2026-01-01T00:00:00.000Z", fields };
}

function attachment(id: string, filename: string, type: string) {
  return { id, filename, type, size: 10, url: `https://temporary.invalid/${id}` };
}
