import sharp from "sharp";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AssetProcessingStatus,
  CommunicationDeliveryStatus,
  CommunicationAssetRole,
  CommunicationScenario,
  CommunicationSourceEntityType,
  PortalAccessLevel,
  StoredFileKind,
} from "../generated/prisma/enums.js";
import {
  INSPECTION_ATTACHMENT_FIELDS,
  SERVICE_ORDER_ATTACHMENT_FIELDS,
} from "../airtable/field-ids.js";
import {
  CommunicationAssetResolver,
  type CommunicationAssetRegistrationStore,
  type DiscoveredAsset,
} from "./communication-assets.js";
import {
  AirtableAttachmentDownloadSource,
  runAssetProcessor,
  type AssetProcessorStore,
  type AttachmentDownloadSource,
  type StoredFileJob,
} from "./processor.js";
import type { ObjectStorage } from "./object-storage.js";
import {
  BoundedCommunicationAssetPreflight,
  type CommunicationAssetStatusStore,
} from "./preflight.js";
import {
  PrismaPublicAssetStore,
  StoredPublicFileService,
  publicAssetAccessWhere,
  type PublicAssetStore,
} from "./public-files.js";

describe("communication asset discovery", () => {
  it("does no Airtable work for a scenario outside the central allowlist", async () => {
    const fetchRecord = vi.fn();
    const register = vi.fn();
    const resolver = new CommunicationAssetResolver(
      { fetchRecord } as never,
      { register } as CommunicationAssetRegistrationStore,
    );
    await expect(resolver.resolve(delivery(CommunicationScenario.REPAIR_RECEIVED))).resolves.toEqual([]);
    expect(fetchRecord).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("discovers the two Repair PDFs and two Repair photos only for REPAIR_COMPLETED", async () => {
    let registered: readonly DiscoveredAsset[] = [];
    const fetchRecord = vi.fn().mockResolvedValue({
      id: "recOrder",
      createdTime: "2026-08-13T10:00:00Z",
      fields: {
        [SERVICE_ORDER_ATTACHMENT_FIELDS.repairProtocol]: [attachment("att-repair", "repair.pdf")],
        [SERVICE_ORDER_ATTACHMENT_FIELDS.diagnosticProtocol]: [attachment("att-diagnostic", "diag.pdf")],
        [SERVICE_ORDER_ATTACHMENT_FIELDS.photo1]: [attachment("att-photo-1", "one.jpg", "image/jpeg")],
        [SERVICE_ORDER_ATTACHMENT_FIELDS.photo2]: [attachment("att-photo-2", "two.png", "image/png")],
      },
    });
    const resolver = new CommunicationAssetResolver(
      { fetchRecord } as never,
      { register: async (_deliveryId, assets) => {
        registered = assets;
        return assets.map((_, index) => ({ storedFileId: `file-${index}`, reused: false, status: "PENDING" }));
      } },
      undefined,
      { hospitalScope: async () => "recHospital" },
    );
    await resolver.resolve(delivery(CommunicationScenario.REPAIR_COMPLETED));
    expect(fetchRecord).toHaveBeenCalledWith(
      expect.any(String),
      "recOrder",
      [
        SERVICE_ORDER_ATTACHMENT_FIELDS.repairProtocol,
        SERVICE_ORDER_ATTACHMENT_FIELDS.diagnosticProtocol,
        SERVICE_ORDER_ATTACHMENT_FIELDS.photo1,
        SERVICE_ORDER_ATTACHMENT_FIELDS.photo2,
      ],
    );
    expect(registered.map((item) => [item.sourceAttachmentId, item.role])).toEqual([
      ["att-repair", CommunicationAssetRole.REPAIR_PROTOCOL],
      ["att-diagnostic", CommunicationAssetRole.DIAGNOSTIC_PROTOCOL],
      ["att-photo-1", CommunicationAssetRole.PHOTO],
      ["att-photo-2", CommunicationAssetRole.PHOTO],
    ]);
    expect(registered.map((item) => item.kind)).toEqual([
      StoredFileKind.DOCUMENT, StoredFileKind.DOCUMENT,
      StoredFileKind.IMAGE, StoredFileKind.IMAGE,
    ]);
  });

  it("associates every INSPECTION_COMPLETED document with its exact Inspection", async () => {
    let registered: readonly DiscoveredAsset[] = [];
    const fetchRecord = vi.fn().mockImplementation(async (_tableId, recordId) => ({
      id: recordId,
      createdTime: "2026-08-13T10:00:00Z",
      fields: {
        [INSPECTION_ATTACHMENT_FIELDS.documents]: [attachment(`att-${recordId}`, `${recordId}.pdf`)],
      },
    }));
    const resolver = new CommunicationAssetResolver(
      { fetchRecord } as never,
      { register: async (_deliveryId, assets) => {
        registered = assets;
        return assets.map((_, index) => ({ storedFileId: `file-${index}`, reused: false, status: "PENDING" }));
      } },
      undefined,
      { hospitalScope: async () => "recHospital" },
    );
    await resolver.resolve({
      id: "delivery-inspection",
      scenario: CommunicationScenario.INSPECTION_COMPLETED,
      sourceRecordId: "recTask",
      eventSnapshot: {
        sourceHospitalRecordId: "recHospital",
        linkedInspectionRecordIds: ["recI1", "recI2", "recI3"],
        linkedServiceOrderRecordIds: ["recRepairMustNotBeFetched"],
      },
    });
    expect(fetchRecord).toHaveBeenCalledTimes(3);
    expect(fetchRecord.mock.calls.map((call) => call[1])).toEqual(["recI1", "recI2", "recI3"]);
    expect(registered.map((item) => ({
      sourceRecordId: item.sourceRecordId,
      sourceEntityType: item.sourceEntityType,
      role: item.role,
      kind: item.kind,
    }))).toEqual(["recI1", "recI2", "recI3"].map((sourceRecordId) => ({
      sourceRecordId,
      sourceEntityType: CommunicationSourceEntityType.INSPECTION,
      role: CommunicationAssetRole.OTHER_DOCUMENT,
      kind: StoredFileKind.DOCUMENT,
    })));
  });

  it("registers zero assets when every allowed attachment field is empty", async () => {
    const register = vi.fn().mockResolvedValue([]);
    const resolver = new CommunicationAssetResolver(
      { fetchRecord: vi.fn().mockResolvedValue({
        id: "recOrder", createdTime: "2026-08-13T10:00:00Z", fields: {},
      }) } as never,
      { register },
    );
    await expect(resolver.resolve(delivery(CommunicationScenario.REPAIR_COMPLETED)))
      .resolves.toEqual([]);
    expect(register).toHaveBeenCalledWith("delivery-1", []);
  });

  it("deduplicates 100 polls and reuses one StoredFile across deliveries", async () => {
    const fields = {
      [SERVICE_ORDER_ATTACHMENT_FIELDS.repairProtocol]: [attachment("att-stable", "repair.pdf")],
    };
    const source = { fetchRecord: vi.fn().mockResolvedValue({
      id: "recOrder", createdTime: "2026-08-13T10:00:00Z", fields,
    }) };
    const store = new MemoryRegistrationStore();
    const resolver = new CommunicationAssetResolver(source as never, store);
    const first = delivery(CommunicationScenario.REPAIR_COMPLETED);
    for (let index = 0; index < 100; index += 1) await resolver.resolve(first);
    await resolver.resolve({ ...first, id: "delivery-2" });
    expect(store.storedFiles.size).toBe(1);
    expect(store.communicationAssets.size).toBe(2);
  });
});

describe("asset processor", () => {
  it("refreshes an Inspection attachment URL from the Inspection table", async () => {
    const fetchRecord = vi.fn().mockResolvedValue({
      id: "recI1", createdTime: "2026-08-13T10:00:00Z",
      fields: {
        [INSPECTION_ATTACHMENT_FIELDS.documents]: [attachment("att-I1", "inspection.pdf")],
      },
    });
    const source = new AirtableAttachmentDownloadSource({ fetchRecord } as never);
    const resolved = await source.resolve({
      ...imageJob(),
      sourceAttachmentId: "att-I1",
      sourceRecordId: "recI1",
      sourceFieldId: INSPECTION_ATTACHMENT_FIELDS.documents,
      sourceEntityType: CommunicationSourceEntityType.INSPECTION,
      kind: StoredFileKind.DOCUMENT,
    });
    expect(resolved.id).toBe("att-I1");
    expect(fetchRecord).toHaveBeenCalledWith(
      expect.any(String), "recI1", [INSPECTION_ATTACHMENT_FIELDS.documents],
    );
  });

  it("stores only bounded WebP portal and thumbnail variants", async () => {
    const sourceImage = await sharp({
      create: { width: 4_032, height: 3_024, channels: 3, background: "#124578" },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const job = imageJob();
    const store = new MemoryProcessorStore(job);
    const storage = new MemoryObjectStorage();
    await runAssetProcessor({
      store,
      source: fixedSource(sourceImage, "image/jpeg"),
      storage,
      config: processorConfig(),
      fetchFunction: fixedFetch(sourceImage, "image/jpeg"),
    });
    expect(store.readyImage).not.toBeNull();
    expect([...storage.objects.keys()].sort()).toEqual([
      `assets/${job.id}/portal.webp`, `assets/${job.id}/thumb.webp`,
    ]);
    const portal = storage.objects.get(`assets/${job.id}/portal.webp`)!;
    const thumb = storage.objects.get(`assets/${job.id}/thumb.webp`)!;
    expect((await sharp(portal).metadata()).format).toBe("webp");
    expect(Math.max((await sharp(portal).metadata()).width!, (await sharp(portal).metadata()).height!)).toBeLessThanOrEqual(1_920);
    expect(Math.max((await sharp(thumb).metadata()).width!, (await sharp(thumb).metadata()).height!)).toBeLessThanOrEqual(400);
    expect((await sharp(portal).metadata()).exif).toBeUndefined();
  });

  it("converts PNG to two WebPs without retaining the original", async () => {
    const png = await sharp({
      create: { width: 600, height: 300, channels: 4, background: "#aa8844" },
    }).png().toBuffer();
    const result = await processImage(png, "image/png");
    expect([...result.storage.objects.keys()].sort()).toEqual([
      "assets/file-1/portal.webp", "assets/file-1/thumb.webp",
    ]);
    expect((await sharp(result.storage.objects.get("assets/file-1/portal.webp")!).metadata()).format).toBe("webp");
  });

  it("does not upscale a small image", async () => {
    const small = await sharp({
      create: { width: 100, height: 60, channels: 3, background: "#000000" },
    }).jpeg().toBuffer();
    const result = await processImage(small, "image/jpeg");
    const portal = await sharp(result.storage.objects.get("assets/file-1/portal.webp")!).metadata();
    const thumb = await sharp(result.storage.objects.get("assets/file-1/thumb.webp")!).metadata();
    expect([portal.width, portal.height]).toEqual([100, 60]);
    expect([thumb.width, thumb.height]).toEqual([100, 60]);
  });

  it("rejects images above the configured pixel limit", async () => {
    const image = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#ffffff" },
    }).png().toBuffer();
    const job = imageJob();
    const store = new MemoryProcessorStore(job);
    await runAssetProcessor({
      store, source: fixedSource(image, "image/png"), storage: new MemoryObjectStorage(),
      config: { ...processorConfig(), maxImagePixels: 100 },
      fetchFunction: fixedFetch(image, "image/png"),
    });
    expect(store.rejected).toEqual({ status: "REJECTED_TOO_LARGE", code: "IMAGE_PIXEL_LIMIT" });
  });

  it("rejects invalid image bytes and leaves the processor operational", async () => {
    const invalid = new TextEncoder().encode("not-an-image");
    const job = imageJob();
    const store = new MemoryProcessorStore(job);
    await runAssetProcessor({
      store, source: fixedSource(invalid, "image/jpeg"), storage: new MemoryObjectStorage(),
      config: processorConfig(), fetchFunction: fixedFetch(invalid, "image/jpeg"),
    });
    expect(store.rejected).toEqual({
      status: "REJECTED_UNSUPPORTED", code: "IMAGE_DECODE_UNSUPPORTED",
    });
  });

  it("stores a valid PDF byte-for-byte", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\nprivate test document");
    const job = { ...imageJob(), kind: StoredFileKind.DOCUMENT, originalMimeType: "application/pdf" };
    const store = new MemoryProcessorStore(job);
    const storage = new MemoryObjectStorage();
    await runAssetProcessor({
      store, source: fixedSource(pdf, "application/pdf"), storage,
      config: processorConfig(), fetchFunction: fixedFetch(pdf, "application/pdf"),
    });
    expect(storage.objects.get(`assets/${job.id}/document`)).toEqual(pdf);
    expect(store.readyDocument?.documentSizeBytes).toBe(pdf.byteLength);
  });

  it.each([
    ["10 MB", 10 * 1_024 * 1_024],
    ["exactly 50 MB", 50 * 1_024 * 1_024],
  ])("allows a %s PDF and uploads it byte-for-byte", async (_label, size) => {
    const pdf = pdfBytes(size);
    const job = { ...imageJob(), kind: StoredFileKind.DOCUMENT, originalMimeType: "application/pdf" };
    const store = new MemoryProcessorStore(job);
    const storage = new MemoryObjectStorage();
    await runAssetProcessor({
      store, source: fixedSource(pdf, "application/pdf"), storage,
      config: processorConfig(), fetchFunction: fixedFetch(pdf, "application/pdf"),
    });
    const uploaded = storage.objects.get(`assets/${job.id}/document`)!;
    expect(store.readyDocument?.documentSizeBytes).toBe(size);
    expect(uploaded.byteLength).toBe(size);
    expect(digest(uploaded)).toBe(digest(pdf));
  });

  it("rejects a PDF above 50 MB from Content-Length before any upload", async () => {
    const job = { ...imageJob(), kind: StoredFileKind.DOCUMENT, originalMimeType: "application/pdf" };
    const store = new MemoryProcessorStore(job);
    const storage = new MemoryObjectStorage();
    const body = pdfBytes(16);
    const fetchFunction = (async () => new Response(body, {
      headers: { "content-length": String(52_428_801), "content-type": "application/pdf" },
    })) as typeof fetch;
    await runAssetProcessor({
      store, source: fixedSource(body, "application/pdf"), storage,
      config: processorConfig(), fetchFunction,
    });
    expect(store.rejected).toEqual({ status: "REJECTED_TOO_LARGE", code: "SOURCE_TOO_LARGE" });
    expect(storage.objects.size).toBe(0);
  });

  it("cancels a no-Content-Length stream immediately after it crosses 50 MB", async () => {
    const job = { ...imageJob(), kind: StoredFileKind.DOCUMENT, originalMimeType: "application/pdf" };
    const store = new MemoryProcessorStore(job);
    const storage = new MemoryObjectStorage();
    const streamed = streamingPdfFetch(100 * 1_024 * 1_024);
    await runAssetProcessor({
      store, source: fixedSource(pdfBytes(16), "application/pdf"), storage,
      config: processorConfig(), fetchFunction: streamed.fetchFunction,
    });
    expect(streamed.wasCancelled()).toBe(true);
    expect(streamed.emittedBytes()).toBeLessThan(100 * 1_024 * 1_024);
    expect(store.rejected).toEqual({ status: "REJECTED_TOO_LARGE", code: "SOURCE_TOO_LARGE" });
    expect(storage.objects.size).toBe(0);
  });

  it("rejects oversized metadata before resolving a temporary Airtable URL", async () => {
    const source = { resolve: vi.fn() };
    const job = { ...imageJob(), originalSizeBytes: 21_000_000n };
    const store = new MemoryProcessorStore(job);
    await runAssetProcessor({
      store, source, storage: new MemoryObjectStorage(), config: processorConfig(),
    });
    expect(source.resolve).not.toHaveBeenCalled();
    expect(store.rejected).toEqual({ status: "REJECTED_TOO_LARGE", code: "SOURCE_TOO_LARGE" });
  });
});

describe("bounded preflight and public access", () => {
  it("continues after a deterministic prep timeout", async () => {
    let clock = 0;
    const resolver = { resolve: vi.fn().mockResolvedValue([]) };
    const statuses: CommunicationAssetStatusStore = {
      statuses: async () => [AssetProcessingStatus.PROCESSING],
    };
    const preflight = new BoundedCommunicationAssetPreflight(
      resolver as never, statuses, 2_000,
      { now: () => clock, sleep: async (milliseconds) => { clock += milliseconds; } },
    );
    await expect(preflight.prepare(delivery(CommunicationScenario.REPAIR_COMPLETED))).resolves.toBeUndefined();
    expect(clock).toBe(2_000);
  });

  it.each([AssetProcessingStatus.READY, AssetProcessingStatus.REJECTED_UNSUPPORTED])(
    "allows mail flow to continue for terminal status %s",
    async (status) => {
      const resolver = { resolve: vi.fn().mockResolvedValue([]) };
      const statuses: CommunicationAssetStatusStore = { statuses: async () => [status] };
      const preflight = new BoundedCommunicationAssetPreflight(resolver as never, statuses, 90_000);
      await expect(preflight.prepare(delivery(CommunicationScenario.REPAIR_COMPLETED))).resolves.toBeUndefined();
    },
  );

  it("signs only an exposed file belonging to the same delivery and hospital", async () => {
    const findAuthorized = vi.fn().mockResolvedValue({
      kind: StoredFileKind.IMAGE,
      portalObjectKey: "private/portal.webp",
      thumbnailObjectKey: "private/thumb.webp",
      documentObjectKey: null,
    });
    const storage = new MemoryObjectStorage();
    await storage.putObject("private/thumb.webp", new Uint8Array([1]), "image/webp");
    const service = new StoredPublicFileService(
      { findAuthorized } as PublicAssetStore, storage, 300,
    );
    const authorization = {
      communicationDeliveryId: "delivery-1",
      sourceHospitalRecordId: "hospital-1",
      entryContext: { type: "SERVICE_ORDER" as const, sourceRecordId: "recOrder" },
    };
    await expect(service.signedUrl(authorization, "asset-1", "thumb"))
      .resolves.toBe("signed:private/thumb.webp:300");
    expect(findAuthorized).toHaveBeenCalledWith("asset-1", authorization);
    await expect(service.signedUrl(authorization, "asset-1", "document")).resolves.toBeNull();
  });

  it("builds COMMUNICATION asset visibility as exact grant delivery or the same batch", async () => {
    const where = publicAssetAccessWhere({
      hospitalId: "hospital-A",
      accessLevel: PortalAccessLevel.COMMUNICATION,
      communicationDeliveryId: "delivery-A",
      communicationBatchMessageId: "resend-batch-A",
    });
    expect(where).toMatchObject({
      exposedAt: { not: null },
      OR: [
        { deliveryId: "delivery-A", delivery: { status: "SENT" } },
        { delivery: { status: "SENT", resendMessageId: "resend-batch-A" } },
      ],
      storedFile: { sourceHospitalRecordId: "hospital-A" },
    });
  });

  it("scopes a fallback asset to the exact delivery of the current grant", async () => {
    const findUnique = vi.fn().mockResolvedValue(databaseAsset({
      deliveryId: "delivery-A", recipientType: "TIEMED_FALLBACK",
    }));
    const store = new PrismaPublicAssetStore(
      { communicationAsset: { findUnique } } as never,
      { resolve: async (hospitalId) => ({ hospitalId, accessLevel: PortalAccessLevel.COMMUNICATION }) },
    );
    const grantA = {
      communicationDeliveryId: "delivery-A", sourceHospitalRecordId: "hospital-A",
      entryContext: {
        type: "SERVICE_ORDER" as const, sourceRecordId: "recOrder-A",
        scenario: CommunicationScenario.REPAIR_RECEIVED,
      },
    };
    await expect(store.findAuthorized("asset-fallback", grantA)).resolves.toMatchObject({
      documentObjectKey: "hospital-A/protocol.pdf",
    });
    await expect(store.findAuthorized("asset-fallback", {
      ...grantA, communicationDeliveryId: "delivery-unrelated",
    })).resolves.toBeNull();
    await expect(store.authorize("asset-fallback", {
      ...grantA, communicationDeliveryId: "delivery-unrelated",
    })).resolves.toMatchObject({ asset: null, reason: "GRANT_DELIVERY_MISMATCH" });
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "asset-fallback" },
    }));
  });

  it.each(["CLIENT", "TIEMED_FALLBACK"] as const)(
    "allows %s sibling documents only inside the same Resend batch",
    async (recipientType) => {
      const findUnique = vi.fn().mockResolvedValue(databaseAsset({
        deliveryId: "delivery-B", recipientType, resendMessageId: "batch-ABC",
      }));
      const grantDelivery = vi.fn(async ({ where }: { where: { id: string } }) => ({
        status: CommunicationDeliveryStatus.SENT,
        resendMessageId: where.id === "delivery-A" ? "batch-ABC" : "batch-D",
      }));
      const store = new PrismaPublicAssetStore({
        communicationAsset: { findUnique },
        communicationDelivery: { findUnique: grantDelivery },
      } as never, { resolve: async (hospitalId) => ({ hospitalId,
        accessLevel: PortalAccessLevel.COMMUNICATION }) });
      const authorization = { ...publicAuthorization(), communicationDeliveryId: "delivery-A" };
      await expect(store.findAuthorized("asset-B", authorization)).resolves.not.toBeNull();
      await expect(store.findAuthorized("asset-B", {
        ...authorization, communicationDeliveryId: "delivery-D",
      })).resolves.toBeNull();
    },
  );

  it("does not expose an asset from another client message", async () => {
    const findUnique = vi.fn().mockResolvedValue(databaseAsset({
      deliveryId: "earlier-delivery", recipientType: "CLIENT",
    }));
    const store = new PrismaPublicAssetStore(
      { communicationAsset: { findUnique } } as never,
      { resolve: async (hospitalId) => ({ hospitalId, accessLevel: PortalAccessLevel.COMMUNICATION }) },
    );
    await expect(store.findAuthorized("asset-client-history", {
      communicationDeliveryId: "later-unrelated-grant",
      sourceHospitalRecordId: "hospital-A",
      entryContext: {
        type: "SERVICE_ORDER", sourceRecordId: "recOrder-B",
        scenario: CommunicationScenario.REPAIR_RECEIVED,
      },
    })).resolves.toBeNull();
  });

  it("does not authorize an H2 asset for an H1 portal token", async () => {
    const findUnique = vi.fn().mockResolvedValue(databaseAsset({ hospitalId: "H2" }));
    const store = new PrismaPublicAssetStore(
      { communicationAsset: { findUnique } } as never,
      { resolve: async () => ({ hospitalId: "H1", accessLevel: PortalAccessLevel.COMMUNICATION }) },
    );
    await expect(store.findAuthorized("asset-from-H2", {
      communicationDeliveryId: "delivery-H1",
      sourceHospitalRecordId: "H1",
      entryContext: { type: "SERVICE_ORDER", sourceRecordId: "repair-H1" },
    })).resolves.toBeNull();
    await expect(store.authorize("asset-from-H2", {
      communicationDeliveryId: "delivery-H1", sourceHospitalRecordId: "H1",
      entryContext: { type: "SERVICE_ORDER", sourceRecordId: "repair-H1" },
    })).resolves.toMatchObject({ asset: null, reason: "HOSPITAL_SCOPE_MISMATCH" });
  });

  it("allows FULL to query any READY non-orphan asset in its Hospital only", async () => {
    const findUnique = vi.fn().mockResolvedValue(databaseAsset({ exposedAt: null }));
    const store = new PrismaPublicAssetStore(
      { communicationAsset: { findUnique } } as never,
      { resolve: async (hospitalId) => ({ hospitalId, accessLevel: PortalAccessLevel.FULL }) },
    );
    await expect(store.findAuthorized("asset-full", {
      communicationDeliveryId: "delivery-A", sourceHospitalRecordId: "hospital-A",
      entryContext: { type: "SERVICE_ORDER", sourceRecordId: "recOrder-A" },
    })).resolves.toMatchObject({ documentObjectKey: "hospital-A/protocol.pdf" });
  });

  it("uses CommunicationAsset.id as the canonical public ID and rejects StoredFile.id", async () => {
    const findUnique = vi.fn().mockImplementation(async ({ where }) =>
      where.id === "communication-asset-id" ? databaseAsset({}) : null);
    const store = new PrismaPublicAssetStore(
      { communicationAsset: { findUnique } } as never,
      { resolve: async () => ({ hospitalId: "hospital-A", accessLevel: PortalAccessLevel.COMMUNICATION }) },
    );
    const authorization = publicAuthorization();
    await expect(store.findAuthorized("communication-asset-id", authorization)).resolves.not.toBeNull();
    await expect(store.authorize("stored-file-id", authorization))
      .resolves.toEqual({ asset: null, reason: "ASSET_NOT_FOUND" });
  });

  it.each([
    ["not exposed", { exposedAt: null }, "NOT_EXPOSED"],
    ["not ready", { processingStatus: AssetProcessingStatus.PROCESSING }, "NOT_READY"],
    ["orphaned", { orphanedAt: new Date("2026-08-14T10:00:00Z") }, "ORPHANED"],
  ] as const)("denies an asset that is %s", async (_label, overrides, reason) => {
    const store = new PrismaPublicAssetStore(
      { communicationAsset: { findUnique: async () => databaseAsset(overrides) } } as never,
      { resolve: async () => ({ hospitalId: "hospital-A", accessLevel: PortalAccessLevel.COMMUNICATION }) },
    );
    await expect(store.authorize("asset-1", publicAuthorization()))
      .resolves.toMatchObject({ asset: null, reason });
  });

  it("serves existing document, thumb and portal object variants after authorization", async () => {
    const storage = new MemoryObjectStorage();
    for (const [key, type] of [
      ["private/document.pdf", "application/pdf"],
      ["private/thumb.webp", "image/webp"],
      ["private/portal.webp", "image/webp"],
    ] as const) await storage.putObject(key, new Uint8Array([1]), type);
    const documentService = new StoredPublicFileService({
      findAuthorized: async () => null,
      authorize: async () => ({ asset: {
        kind: StoredFileKind.DOCUMENT, portalObjectKey: null,
        thumbnailObjectKey: null, documentObjectKey: "private/document.pdf",
      }, reason: null }),
    }, storage, 300);
    const imageService = new StoredPublicFileService({
      findAuthorized: async () => null,
      authorize: async () => ({ asset: {
        kind: StoredFileKind.IMAGE, portalObjectKey: "private/portal.webp",
        thumbnailObjectKey: "private/thumb.webp", documentObjectKey: null,
      }, reason: null }),
    }, storage, 300);
    await expect(documentService.signedUrl(publicAuthorization(), "asset-doc", "document"))
      .resolves.toBe("signed:private/document.pdf:300");
    await expect(imageService.signedUrl(publicAuthorization(), "asset-image", "thumb"))
      .resolves.toBe("signed:private/thumb.webp:300");
    await expect(imageService.signedUrl(publicAuthorization(), "asset-image", "portal"))
      .resolves.toBe("signed:private/portal.webp:300");
  });
});

function publicAuthorization() {
  return {
    communicationDeliveryId: "delivery-A",
    sourceHospitalRecordId: "hospital-A",
    entryContext: { type: "SERVICE_ORDER" as const, sourceRecordId: "recOrder-A" },
  };
}

function databaseAsset(overrides: {
  deliveryId?: string;
  recipientType?: "CLIENT" | "TIEMED_FALLBACK";
  hospitalId?: string;
  exposedAt?: Date | null;
  processingStatus?: AssetProcessingStatus;
  orphanedAt?: Date | null;
  resendMessageId?: string | null;
} = {}) {
  const hospitalId = overrides.hospitalId ?? "hospital-A";
  return {
    deliveryId: overrides.deliveryId ?? "delivery-A",
    exposedAt: overrides.exposedAt === undefined
      ? new Date("2026-08-14T10:00:00Z") : overrides.exposedAt,
    delivery: {
      status: "SENT",
      resendMessageId: overrides.resendMessageId ?? null,
      communicationEventRecipient: { recipientType: overrides.recipientType ?? "TIEMED_FALLBACK" },
      communicationEvent: { eventSnapshot: { sourceHospitalRecordId: hospitalId } },
    },
    storedFile: {
      processingStatus: overrides.processingStatus ?? AssetProcessingStatus.READY,
      orphanedAt: overrides.orphanedAt ?? null,
      sourceHospitalRecordId: hospitalId,
      kind: StoredFileKind.DOCUMENT,
      portalObjectKey: null,
      thumbnailObjectKey: null,
      documentObjectKey: "hospital-A/protocol.pdf",
    },
  };
}

function delivery(scenario: CommunicationScenario) {
  return {
    id: "delivery-1", scenario, sourceRecordId: "recOrder",
    eventSnapshot: { sourceHospitalRecordId: "recHospital" },
  };
}

function attachment(id: string, filename: string, type = "application/pdf") {
  return { id, url: "https://airtable.invalid/temporary", filename, type, size: 100 };
}

function imageJob(): StoredFileJob {
  return {
    id: "file-1", sourceAttachmentId: "att-1", sourceRecordId: "recOrder",
    sourceFieldId: SERVICE_ORDER_ATTACHMENT_FIELDS.repairProtocol,
    sourceEntityType: CommunicationSourceEntityType.SERVICE_ORDER,
    sourceHospitalRecordId: "recHospital", kind: StoredFileKind.IMAGE,
    originalMimeType: "image/jpeg", originalSizeBytes: null, attemptCount: 1,
  };
}

function processorConfig() {
  return {
    maxSourceBytes: 20_971_520, maxDocumentSourceBytes: 52_428_800,
    maxImagePixels: 50_000_000,
    portalMaxDimension: 1_920, thumbMaxDimension: 400,
    portalWebpQuality: 82, thumbWebpQuality: 78, concurrency: 1,
  };
}

function fixedSource(body: Uint8Array, type: string): AttachmentDownloadSource {
  return { resolve: async (job) => ({
    id: job.sourceAttachmentId, filename: "source", type, size: body.byteLength,
    url: "https://asset.invalid/file",
  }) };
}

function fixedFetch(body: Uint8Array, type: string): typeof fetch {
  return (async () => new Response(body, {
    status: 200,
    headers: { "content-type": type, "content-length": String(body.byteLength) },
  })) as typeof fetch;
}

function pdfBytes(size: number): Uint8Array {
  const body = new Uint8Array(size);
  body.set(new TextEncoder().encode("%PDF-1.7\n"));
  return body;
}

function digest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function streamingPdfFetch(totalBytes: number) {
  const chunkSize = 1_024 * 1_024;
  let emitted = 0;
  let cancelled = false;
  const fetchFunction = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= totalBytes) { controller.close(); return; }
      const length = Math.min(chunkSize, totalBytes - emitted);
      const chunk = new Uint8Array(length);
      if (emitted === 0) chunk.set(new TextEncoder().encode("%PDF-1.7\n"));
      emitted += length;
      controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/pdf" } })) as typeof fetch;
  return { fetchFunction, wasCancelled: () => cancelled, emittedBytes: () => emitted };
}

async function processImage(body: Uint8Array, type: string) {
  const job = imageJob();
  const store = new MemoryProcessorStore(job);
  const storage = new MemoryObjectStorage();
  await runAssetProcessor({
    store, source: fixedSource(body, type), storage,
    config: processorConfig(), fetchFunction: fixedFetch(body, type),
  });
  return { store, storage };
}

class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  async putObject(key: string, body: Uint8Array): Promise<void> { this.objects.set(key, body); }
  async headObject(key: string) { return this.objects.has(key) ? { sizeBytes: this.objects.get(key)!.byteLength, contentType: null } : null; }
  async getSignedDownloadUrl(key: string, seconds: number) { return `signed:${key}:${seconds}`; }
  async deleteObject(key: string) { this.objects.delete(key); }
}

class MemoryProcessorStore implements AssetProcessorStore {
  private claimed = false;
  readyImage: Parameters<AssetProcessorStore["markImageReady"]>[1] | null = null;
  readyDocument: Parameters<AssetProcessorStore["markDocumentReady"]>[1] | null = null;
  rejected: { status: string; code: string } | null = null;
  constructor(private readonly job: StoredFileJob) {}
  async claimNext() { if (this.claimed) return null; this.claimed = true; return this.job; }
  async markImageReady(_id: string, output: Parameters<AssetProcessorStore["markImageReady"]>[1]) { this.readyImage = output; }
  async markDocumentReady(_id: string, output: Parameters<AssetProcessorStore["markDocumentReady"]>[1]) { this.readyDocument = output; }
  async markRejected(_id: string, status: "REJECTED_TOO_LARGE" | "REJECTED_UNSUPPORTED", code: string) { this.rejected = { status, code }; }
  async markFailed() {}
}

class MemoryRegistrationStore implements CommunicationAssetRegistrationStore {
  readonly storedFiles = new Map<string, string>();
  readonly communicationAssets = new Set<string>();
  async register(deliveryId: string, assets: readonly DiscoveredAsset[]) {
    return assets.map((asset) => {
      const existing = this.storedFiles.get(asset.sourceAttachmentId);
      const storedFileId = existing ?? `file-${this.storedFiles.size + 1}`;
      this.storedFiles.set(asset.sourceAttachmentId, storedFileId);
      this.communicationAssets.add(`${deliveryId}:${storedFileId}:${asset.role}`);
      return { storedFileId, reused: Boolean(existing), status: "PENDING" };
    });
  }
}
