import { describe, expect, it } from "vitest";
import {
  CommunicationAssetRole,
  CommunicationScenario,
  CommunicationSourceEntityType,
  PortalAccessLevel,
  StoredFileKind,
} from "../generated/prisma/enums.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { renderHospitalPortal } from "./portal-page.js";
import {
  decodePortalCaseCursor,
  decodePortalDeviceCursor,
  encodePortalCaseCursor,
  encodePortalDeviceCursor,
  HospitalPortalViewModelService,
  inspectionDisplayStatus,
  InvalidPortalCursorError,
  PrismaHospitalPortalStore,
  type HospitalPortalStore,
  type PortalCaseFilter,
  type PortalCaseListItem,
  type PortalDevice,
  type PortalDocument,
} from "./view-model.js";

describe("paginated hospital portal", () => {
  it("shows a neutral display status without hiding inspection dates", () => {
    expect(inspectionDisplayStatus("DO REALIZACJI", new Date("2026-08-25T10:00:00Z")))
      .toBe("Dane wymagają weryfikacji");
    expect(inspectionDisplayStatus("DO REALIZACJI", null)).toBe("DO REALIZACJI");
  });
  it("renders at most 30 of 3200 records while preserving DB counts", async () => {
    const store = memoryStore(2000, 1200);
    const service = new HospitalPortalViewModelService(store, "Tiemed", 30);
    const view = await service.build(taskAuth());
    const html = renderHospitalPortal(view, "nonce", new Date(), "/p/token");

    expect(view.summary).toEqual({ repairs: 2000, inspections: 1200, devices: 2000, requiresAction: 0 });
    expect(view.initialCases.items).toHaveLength(30);
    expect(html.match(/class="task case-open"/g)).toHaveLength(30);
    expect(html).not.toContain("repair-1999");
    expect(html.length).toBeLessThan(200_000);
  });

  it("renders load-more logic that reuses the exact cursor and keeps the existing error UX", async () => {
    const view = await new HospitalPortalViewModelService(memoryStore(31, 0), "Tiemed", 30).build(taskAuth());
    const html = renderHospitalPortal(view, "nonce", new Date(), "/p/token");
    expect(html).toContain("const cursor=reset?null:state.cursor");
    expect(html).toContain("api('cases',{filter:state.filter,q:state.query,cursor})");
    expect(html).toContain("state.more.hidden=page.nextCursor===null");
    expect(html).toContain("Nie udało się pobrać danych. Spróbuj ponownie.");
    expect(html).toContain("button.addEventListener('click',()=>openCase(item.sourceRecordId))");
  });

  it("returns consecutive cursor pages without duplicates", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(75, 0), "Tiemed", 30);
    const first = await service.listCases(taskAuth(), { filter: "REPAIR" });
    const second = await service.listCases(taskAuth(), { filter: "REPAIR", cursor: first.nextCursor! });
    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(30);
    expect(new Set([...first.items, ...second.items].map((item) => item.sourceRecordId)).size).toBe(60);
  });

  it("paginates 65 cases as 30, 30 and 5, then ends", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(65, 0), "Tiemed", 30);
    const first = await service.listCases(taskAuth(), { filter: "REPAIR" });
    const second = await service.listCases(taskAuth(), { filter: "REPAIR", cursor: first.nextCursor! });
    const third = await service.listCases(taskAuth(), { filter: "REPAIR", cursor: second.nextCursor! });
    expect([first.items.length, second.items.length, third.items.length]).toEqual([30, 30, 5]);
    expect(third.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items, ...third.items].map((item) => item.sourceRecordId)).size).toBe(65);
  });

  it("paginates 2000 PostgreSQL-backed Device rows 30 at a time without duplicates", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(2000, 1200), "Tiemed", 30);
    const first = await service.listDevices(taskAuth(), {});
    const second = await service.listDevices(taskAuth(), { cursor: first.nextCursor! });
    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(30);
    expect(new Set([...first.items, ...second.items].map((item) => item.sourceRecordId)).size)
      .toBe(60);
  });

  it("finds a Device outside page one using server-side search", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(2000, 1200), "Tiemed", 30);
    const page = await service.listDevices(taskAuth(), { query: "UNIKAT-1999" });
    expect(page.items.map((item) => item.sourceRecordId)).toEqual(["device-1999"]);
  });

  it("uses stable tie-breakers for equal and missing sort dates", async () => {
    for (const lastChangedAt of [new Date("2026-08-13T10:00:00Z"), null]) {
      const service = new HospitalPortalViewModelService(memoryStore(65, 0, { lastChangedAt }), "Tiemed", 30);
      const pages = [];
      let cursor: string | undefined;
      do {
        const page = await service.listCases(taskAuth(), { filter: "REPAIR", cursor });
        pages.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(pages).toHaveLength(65);
      expect(new Set(pages.map((item) => item.sourceRecordId)).size).toBe(65);
    }
  });

  it("round-trips a URL-safe cursor through a query string", () => {
    const expected = { sortKey: 1_723_546_800_123n, type: "INSPECTION" as const, sourceRecordId: "rec+/= zażółć" };
    const encoded = encodePortalCaseCursor(expected);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const url = new URL("https://portal.test/data/cases");
    url.searchParams.set("cursor", encoded);
    expect(decodePortalCaseCursor(url.searchParams.get("cursor"))).toEqual(expected);
  });

  it("preserves repair, inspection and search result sets between pages", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(65, 65, { deviceName: "Wspólna fraza" }), "Tiemed", 30);
    for (const filter of ["REPAIR", "INSPECTION"] as const) {
      const first = await service.listCases(taskAuth(), { filter });
      const second = await service.listCases(taskAuth(), { filter, cursor: first.nextCursor! });
      expect([...first.items, ...second.items].every((item) => item.type === filter)).toBe(true);
    }
    const first = await service.listCases(taskAuth(), { query: "Wspólna fraza" });
    const second = await service.listCases(taskAuth(), { query: "Wspólna fraza", cursor: first.nextCursor! });
    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(30);
  });

  it("preserves the ACTION filter between cursor pages", async () => {
    const service = new HospitalPortalViewModelService(
      memoryStore(40, 40, { currentStatus: "DO REALIZACJI", requiresAction: true }), "Tiemed", 30,
    );
    const first = await service.listCases(taskAuth(), { filter: "ACTION" });
    const second = await service.listCases(taskAuth(), {
      filter: "ACTION", cursor: first.nextCursor!,
    });
    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(30);
    expect([...first.items, ...second.items].every((item) => item.requiresAction)).toBe(true);
  });

  it("binds a decoded cursor as bigint text, never as a Date raw-query parameter", async () => {
    const queries: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
    const prisma = {
      $queryRaw: async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        queries.push(query);
        return [];
      },
      trackedDevice: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const store = new PrismaHospitalPortalStore(prisma);
    const cursor = encodePortalCaseCursor({
      sortKey: 1_723_546_800_123n, type: "REPAIR", sourceRecordId: "repair-30",
    });
    await store.pageCases({
      hospitalId: "hospital-A", contextType: "INSPECTION_TASK", contextId: "task-T3",
    }, { filter: "REPAIR", query: "Pompa", cursor, limit: 30 });
    expect(queries[0]!.strings.join("?")).toContain("CAST(? AS bigint)");
    expect(queries[0]!.values).toContain("1723546800123");
    expect(queries[0]!.values.some((value) => value instanceof Date)).toBe(false);
  });

  it("rejects an invalid cursor instead of restarting or throwing an uncontrolled error", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(65, 0), "Tiemed", 30);
    await expect(service.listCases(auth(), { cursor: "not+url/safe=" }))
      .rejects.toThrow(InvalidPortalCursorError);
  });

  it("clamps a hostile requested limit to 100", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(500, 0), "Tiemed", 30);
    const page = await service.listCases(taskAuth(), { limit: 100_000 });
    expect(page.items).toHaveLength(100);
  });

  it("server-side search finds a record outside page one", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(2000, 0), "Tiemed", 30);
    const result = await service.listCases(taskAuth(), { query: "UNIKAT-1999" });
    expect(result.items.map((item) => item.sourceRecordId)).toEqual(["repair-1999"]);
  });

  it("uses entry context only for focus and allows another visible Hospital Case detail", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(2000, 0), "Tiemed", 30);
    const authorization = auth("repair-1999");
    const view = await service.build(authorization);
    expect(view.initialCases.items).toHaveLength(30);
    expect(view.focusedCase?.sourceRecordId).toBe("repair-1999");
    expect((await service.getCase(authorization, "repair-1999"))?.caseNumber).toBe("1999");
    expect((await service.getCase(authorization, "repair-1"))?.caseNumber).toBe("1");
  });

  it("does not treat inspection-task entry context as access scope", async () => {
    const store = memoryStore(20, 10, { deviceId: "shared-device" }, {
      "task-T3": ["inspection-7", "inspection-8", "repair-10"],
    });
    const service = new HospitalPortalViewModelService(store, "Tiemed", 30);
    const authorization = taskAuth("task-T3");
    const inspections = await service.listCases(authorization, { filter: "INSPECTION" });
    const repairs = await service.listCases(authorization, { filter: "REPAIR" });
    const devices = await service.listDevices(authorization, {});
    expect(inspections.items).toHaveLength(10);
    expect(repairs.items).toHaveLength(20);
    expect(repairs.items.some((item) => item.sourceRecordId === "repair-11")).toBe(true);
    expect(devices.items.map((item) => item.sourceRecordId)).toEqual(["shared-device"]);
  });

  it("builds access SQL from hospital ownership, CLIENT delivery and stable Device ordering", async () => {
    const queries: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
    const prisma = {
      $queryRaw: async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        queries.push(query);
        return query.strings.join("?").includes('SELECT d."airtableRecordId" FROM "TrackedDevice"')
          ? [{ airtableRecordId: "repair-only-device" }] : [];
      },
      trackedDevice: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const store = new PrismaHospitalPortalStore(prisma);
    const scope = {
      hospitalId: "hospital-A", contextType: "INSPECTION_TASK", contextId: "task-T3",
    } as const;
    await store.pageCases(scope, { filter: "ALL", query: null, cursor: null, limit: 30 });
    await store.pageDevices(scope, { query: null, cursor: null, limit: 30 });
    await store.findScopedDevice(scope, "repair-only-device", 30);
    const sql = queries[0]!.strings.join("?");
    expect(sql).toContain('c."sourceHospitalRecordId" =');
    expect(sql).toContain("'SENT'");
    expect(sql).toContain("'CLIENT'");
    expect(sql).toContain("WHEN 'NIESPRAWNE' THEN 3");
    expect(sql).toContain("WHEN 'WARUNKOWO DOPUSZCZONE' THEN 2");
    expect(queries[0]!.values).toContain("hospital-A");
    expect(queries[1]!.strings.join("?")).toContain('FROM "TrackedDevice" d');
    expect(queries[1]!.strings.join("?")).toContain('d."sourceHospitalRecordId" =');
    expect(queries[1]!.strings.join("?")).toContain("d.active = true");
    expect(queries[1]!.strings.join("?")).toContain('COALESCE(d."sourceModifiedAt", d."sourceCreatedAt"');
    expect(queries[1]!.strings.join("?")).not.toContain('d."updatedAt"');
    expect(queries[3]!.strings.join("?")).toContain('c."inspectionPerformedAt" IS NOT NULL');
    expect(queries[3]!.strings.join("?")).toContain('JOIN "TrackedCaseDevice"');
  });

  it("returns every Device in a multi-device Case detail", async () => {
    const prisma = {
      $queryRaw: async () => [{
        type: "INSPECTION", sourceRecordId: "inspection-I1", sortKey: 1n,
      }],
      trackedCase: { findMany: async () => [{
        id: "case-I1", airtableRecordId: "inspection-I1", businessNumber: "I1",
        clientOrderNumber: null, emmaCustomerStatus: null, hospitalName: null,
        deviceName: null, manufacturer: null, model: null, serialNumber: null,
        inventoryNumber: null, currentStatus: "SPRAWNE", faultDescription: null,
        sourceCreatedAt: null, reportedAt: null, sourceModifiedAt: null,
        inspectionDueDate: null, inspectionPerformedAt: new Date("2026-08-13T00:00:00Z"),
        inspectionResult: "SPRAWNE", inspectionValidUntil: new Date("2027-08-13T00:00:00Z"), sourceSnapshot: {},
        events: [],
      }] },
      trackedTask: { findMany: async () => [] },
      trackedCaseDevice: { findMany: async () => ["A", "B", "C"].map((id) => ({
        trackedCaseId: "case-I1", deviceAirtableId: `device-${id}`,
      })) },
      trackedDevice: { findMany: async () => ["A", "B", "C"].map((id) => ({
        airtableRecordId: `device-${id}`, name: `Device ${id}`, manufacturer: "M",
        model: id, serialNumber: `SN-${id}`, inventoryNumber: null,
      })) },
      communicationAsset: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const item = await new PrismaHospitalPortalStore(prisma).findScopedCase({
      hospitalId: "hospital-A", contextType: "INSPECTION_TASK", contextId: "task-A",
    }, "inspection-I1");
    expect(item?.sourceRecordId).toBe("inspection-I1");
    expect(item?.devices.map((device) => device.sourceRecordId)).toEqual([
      "device-A", "device-B", "device-C",
    ]);
    expect(item?.deviceName).toBe("3 urządzenia");
    expect(item?.deviceId).toBeNull();
  });

  it("shows Case H1 snapshot but does not expose current Device H2 data", async () => {
    let linkedDeviceWhere: unknown;
    let caseLookupQuery: { strings: readonly string[]; values: readonly unknown[] } | null = null;
    const prisma = {
      $queryRaw: async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        caseLookupQuery = query;
        return [{ type: "REPAIR", sourceRecordId: "repair-H1", sortKey: 1n }];
      },
      trackedCase: { findMany: async () => [{
        id: "case-H1", airtableRecordId: "repair-H1", businessNumber: "R1",
        clientOrderNumber: null, emmaCustomerStatus: "Naprawa", hospitalName: null,
        deviceName: "Snapshot H1", manufacturer: "Snapshot maker", model: "S1",
        serialNumber: "SN-HIST", inventoryNumber: "INV-HIST", currentStatus: null,
        faultDescription: null, sourceCreatedAt: null, reportedAt: null,
        sourceModifiedAt: null, inspectionDueDate: null, inspectionPerformedAt: null,
        inspectionResult: null, inspectionValidUntil: null, sourceSnapshot: {}, events: [],
      }] },
      trackedTask: { findMany: async () => [] },
      trackedCaseDevice: { findMany: async () => [{
        trackedCaseId: "case-H1", deviceAirtableId: "device-now-H2",
      }] },
      trackedDevice: { findMany: async ({ where }: { where: unknown }) => {
        linkedDeviceWhere = where;
        return [];
      } },
      communicationAsset: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const store = new PrismaHospitalPortalStore(prisma);
    const item = await store.findScopedCase({
      hospitalId: "H1", contextType: "REPAIR", contextId: "different-entry-repair",
    }, "repair-H1");
    const lookupSql = caseLookupQuery!.strings.join("?");
    expect(lookupSql).toContain('c."sourceHospitalRecordId" =');
    expect(caseLookupQuery!.values).toContain("H1");
    expect(caseLookupQuery!.values).toContain("repair-H1");
    expect(caseLookupQuery!.values).not.toContain("different-entry-repair");
    expect(linkedDeviceWhere).toMatchObject({ sourceHospitalRecordId: "H1" });
    expect(item?.devices[0]).toMatchObject({
      sourceRecordId: "device-now-H2",
      deviceName: "Snapshot H1",
      serialNumber: "SN-HIST",
    });
    expect(item?.deviceId).toBeNull();
    expect(item?.devices[0]?.deviceName).not.toBe("Current H2");
  });

  it("uses the historical H1 Case snapshot for Documents tab, document and photo context after Device moves to H2", async () => {
    const trackedDeviceQueries: unknown[] = [];
    const caseRow = {
      id: "case-H1", airtableRecordId: "repair-H1", businessNumber: "R-H1",
      clientOrderNumber: null, emmaCustomerStatus: "Naprawa zakończona", hospitalName: "H1",
      deviceName: "Device Old", manufacturer: "Old maker", model: "Old model",
      serialNumber: "SN-OLD", inventoryNumber: "INV-OLD", currentStatus: null,
      faultDescription: null, sourceCreatedAt: new Date("2025-01-01T00:00:00Z"),
      reportedAt: new Date("2025-01-01T00:00:00Z"), sourceModifiedAt: null,
      inspectionDueDate: null, inspectionPerformedAt: null, inspectionResult: null,
      inspectionValidUntil: null, sourceSnapshot: {}, events: [],
    };
    const assetRows = [
      {
        id: "asset-doc-H1", role: CommunicationAssetRole.REPAIR_PROTOCOL,
        displayOrder: 0, createdAt: new Date("2026-08-14T10:00:00Z"),
        storedFile: {
          id: "file-doc-H1", sourceRecordId: "repair-H1",
          sourceEntityType: CommunicationSourceEntityType.SERVICE_ORDER,
          kind: StoredFileKind.DOCUMENT, originalFileName: "repair.pdf",
        },
      },
      {
        id: "asset-photo-H1", role: CommunicationAssetRole.PHOTO,
        displayOrder: 1, createdAt: new Date("2026-08-14T10:00:00Z"),
        storedFile: {
          id: "file-photo-H1", sourceRecordId: "repair-H1",
          sourceEntityType: CommunicationSourceEntityType.SERVICE_ORDER,
          kind: StoredFileKind.IMAGE, originalFileName: "repair.jpg",
        },
      },
    ];
    const prisma = {
      $queryRaw: async () => [{ type: "REPAIR", sourceRecordId: "repair-H1", sortKey: 1n }],
      trackedCase: { findMany: async () => [caseRow] },
      trackedTask: { findMany: async () => [] },
      trackedCaseDevice: { findMany: async () => [{
        trackedCaseId: "case-H1", deviceAirtableId: "device-current-H2",
      }] },
      trackedDevice: { findMany: async ({ where }: { where: unknown }) => {
        trackedDeviceQueries.push(where);
        // The current record exists in H2 as Device Current / SN-NEW, so the H1-scoped lookup returns none.
        return [];
      } },
      communicationAsset: { findMany: async () => assetRows },
    } as unknown as PrismaClient;
    const store = new PrismaHospitalPortalStore(prisma);
    const scope = {
      hospitalId: "H1", accessLevel: PortalAccessLevel.FULL,
      communicationDeliveryId: "delivery-H1", contextType: "REPAIR" as const,
      contextId: "repair-H1",
    };

    const documents = await store.listDocuments(scope, null);
    expect(trackedDeviceQueries).toHaveLength(0);
    const detail = await store.findScopedCase(scope, "repair-H1");

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      deviceName: "Device Old", serialNumber: "SN-OLD", caseNumber: "R-H1",
    });
    expect(detail?.documents[0]).toMatchObject({
      deviceName: "Device Old", serialNumber: "SN-OLD",
    });
    expect(detail?.photos[0]).toMatchObject({
      deviceName: "Device Old", serialNumber: "SN-OLD",
    });
    expect(JSON.stringify({ documents, detail })).not.toContain("Device Current");
    expect(JSON.stringify({ documents, detail })).not.toContain("SN-NEW");
    expect(trackedDeviceQueries.length).toBeGreaterThan(0);
    expect(trackedDeviceQueries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceHospitalRecordId: "H1" }),
    ]));
  });

  it("denies Device H2 to H1 and scopes its history to H2 Cases", async () => {
    const queries: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
    const prisma = {
      trackedDevice: { findMany: async ({ where }: {
        where: { sourceHospitalRecordId: string };
      }) => where.sourceHospitalRecordId === "H2" ? [{
        airtableRecordId: "device-H2", name: "Current H2", manufacturer: null,
        model: null, serialNumber: null, inventoryNumber: null, deviceStatus: null,
      }] : [] },
      $queryRaw: async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        queries.push(query);
        return query.strings.join("?").includes('SELECT d."airtableRecordId"') && query.values.includes("H2")
          ? [{ airtableRecordId: "device-H2" }] : [];
      },
    } as unknown as PrismaClient;
    const store = new PrismaHospitalPortalStore(prisma);
    expect(await store.findScopedDevice({
      hospitalId: "H1", accessLevel: PortalAccessLevel.FULL, contextType: "REPAIR", contextId: "repair-H1",
    }, "device-H2", 30)).toBeNull();
    expect(await store.findScopedDevice({
      hospitalId: "H2", accessLevel: PortalAccessLevel.FULL, contextType: "REPAIR", contextId: "repair-H1",
    }, "device-H2", 30)).not.toBeNull();
    const historyQuery = queries.find((query) => query.strings.join("?").includes('FROM "TrackedCaseDevice" case_device'))!;
    const historySql = historyQuery.strings.join("?");
    expect(historySql).toContain('c."sourceHospitalRecordId" =');
    expect(historyQuery.values).toContain("H2");
    expect(historySql).toContain('FROM "TrackedCaseDevice" case_device');
  });

  it("filters Device detail and Case search through every junction link", async () => {
    const queries: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
    const prisma = { $queryRaw: async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
      queries.push(query); return [];
    } } as unknown as PrismaClient;
    const store = new PrismaHospitalPortalStore(prisma);
    const scope = { hospitalId: "H1", contextType: "INSPECTION_TASK", contextId: "T1" } as const;
    for (const id of ["device-A", "device-B", "device-C"]) {
      await store.pageCases(scope, {
        filter: "ALL", query: null, cursor: null, limit: 30,
        deviceId: id, hospitalWideDevice: true,
      });
    }
    await store.pageCases(scope, {
      filter: "ALL", query: "SN-C", cursor: null, limit: 30,
    });
    for (let index = 0; index < 3; index += 1) {
      const sql = queries[index]!.strings.join("?");
      expect(sql).toContain('FROM "TrackedCaseDevice" case_device');
      expect(queries[index]!.values).toContain(`device-${["A", "B", "C"][index]}`);
    }
    const searchSql = queries[3]!.strings.join("?");
    expect(searchSql).toContain('JOIN "TrackedDevice" search_device');
    expect(searchSql).toContain("search_device.active = true");
    expect(searchSql).toContain('search_device."serialNumber"');
  });

  it("loads a 30-row Device page with fixed query count and no Prisma N+1", async () => {
    const keys = Array.from({ length: 31 }, (_, index) => ({
      sourceRecordId: `device-${index}`,
      sortKey: BigInt(10_000 - index),
    }));
    let rawCalls = 0;
    let findManyCalls = 0;
    const prisma = {
      $queryRaw: async () => {
        rawCalls += 1;
        if (rawCalls === 1) return keys;
        if (rawCalls === 2) return keys.slice(0, 30).map((key) => ({ airtableRecordId: key.sourceRecordId }));
        return [];
      },
      trackedDevice: {
        findMany: async () => {
          findManyCalls += 1;
          return keys.slice(0, 30).map((key) => ({
            airtableRecordId: key.sourceRecordId,
            name: key.sourceRecordId,
            manufacturer: null,
            model: null,
            serialNumber: null,
            inventoryNumber: null,
            deviceStatus: null,
          }));
        },
      },
    } as unknown as PrismaClient;
    const store = new PrismaHospitalPortalStore(prisma);
    const page = await store.pageDevices({
      hospitalId: "hospital-A", accessLevel: PortalAccessLevel.FULL, contextType: "INSPECTION_TASK", contextId: "task-A",
    }, { query: null, cursor: null, limit: 30 });
    expect(page.items).toHaveLength(30);
    expect(page.nextCursor).not.toBeNull();
    expect(findManyCalls).toBe(1);
    expect(rawCalls).toBe(3);
  });

  it("keeps Device detail cases hospital-scoped even outside the entry context", async () => {
    const queries: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
    const prisma = {
      trackedDevice: {
        findMany: async () => [{
          airtableRecordId: "device-A", name: "USG", manufacturer: null,
          model: null, serialNumber: null, inventoryNumber: null, deviceStatus: null,
        }],
      },
      $queryRaw: async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        queries.push(query);
        return query.strings.join("?").includes('SELECT d."airtableRecordId"')
          ? [{ airtableRecordId: "device-A" }] : [];
      },
    } as unknown as PrismaClient;
    const store = new PrismaHospitalPortalStore(prisma);
    await store.findScopedDevice({
      hospitalId: "hospital-A", accessLevel: PortalAccessLevel.FULL, contextType: "REPAIR", contextId: "repair-other",
    }, "device-A", 30);
    const detailCasesQuery = queries.find((query) => query.strings.join("?").includes('FROM "TrackedCaseDevice" case_device'))!;
    const detailCasesSql = detailCasesQuery.strings.join("?");
    expect(detailCasesSql).toContain('c."sourceHospitalRecordId" =');
    expect(detailCasesSql).toContain('FROM "TrackedCaseDevice" case_device');
    expect(detailCasesSql).toContain('case_device."deviceAirtableId" =');
    expect(detailCasesQuery.values).toContain("hospital-A");
    expect(detailCasesQuery.values).toContain("device-A");
    expect(detailCasesSql).not.toContain('context_task."airtableRecordId"');
  });

  it("keeps scope on pages, search, details and devices", async () => {
    const store = memoryStore(10, 2);
    const service = new HospitalPortalViewModelService(store, "Tiemed", 30);
    const authorization = auth();
    await service.listCases(authorization, { query: "secret-B" });
    expect(await service.getCase(authorization, "hospital-B-secret")).toBeNull();
    expect(await service.getDevice(authorization, "device-B")).toBeNull();
    expect(store.seenScopes.every((scope) => scope === "hospital-A")).toBe(true);
  });

  it("does not let a hospital A cursor expose hospital B", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(65, 0), "Tiemed", 30);
    const first = await service.listCases(taskAuth(), { filter: "REPAIR" });
    const hospitalB = { ...taskAuth(), sourceHospitalRecordId: "hospital-B" };
    const next = await service.listCases(hospitalB, { filter: "REPAIR", cursor: first.nextCursor! });
    expect(next.items).toEqual([]);
  });

  it("keeps mixed open and closed inspections as independent sibling records", async () => {
    const store = memoryStore(0, 2);
    const page = await new HospitalPortalViewModelService(store).listCases(taskAuth(), {
      filter: "INSPECTION",
    });
    page.items[0]!.currentStatus = "Zakończony";
    page.items[1]!.currentStatus = "DO REALIZACJI";
    expect(page.items.map((item) => item.sourceRecordId)).toEqual([
      "inspection-0", "inspection-1",
    ]);
    expect(page.items.some((item) => item.currentStatus === "DO REALIZACJI")).toBe(true);
  });

  it("does not use sync timestamps as reportedAt fallback", async () => {
    const store = memoryStore(1, 0, { reportedAt: null });
    const view = await new HospitalPortalViewModelService(store).build(auth());
    expect(view.initialCases.items[0]?.reportedAt).toBeNull();
    expect(renderHospitalPortal(view, "nonce")).toContain("reportedAt\":null");
  });

  it("renders the Service Order department on the repair list", async () => {
    const view = await new HospitalPortalViewModelService(
      memoryStore(1, 0, { department: "Blok operacyjny" }),
    ).build(auth());
    expect(renderHospitalPortal(view, "nonce")).toContain("Blok operacyjny");
  });

  it("escapes XSS and preserves Polish UTF-8", async () => {
    const store = memoryStore(1, 0, {
      deviceName: "Łóżko · Żółty <svg onload=alert(1)>",
      description: "<script>alert(1)</script> Michał",
    });
    const html = renderHospitalPortal(await new HospitalPortalViewModelService(store).build(auth()), "nonce");
    expect(html).toContain("Łóżko · Żółty &lt;svg onload=alert(1)&gt;");
    expect(html).toContain("Michał");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html.match(/class="summary-card"/g)).toHaveLength(3);
  });

  it("renders the five-item mobile navigation and responsive access-safe teaser", async () => {
    const view = await new HospitalPortalViewModelService(memoryStore(3, 2)).build(auth());
    const html = renderHospitalPortal(view, "nonce");
    const mobileNav = html.match(/<nav class="mobile-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(mobileNav.match(/data-screen=/g)).toHaveLength(5);
    expect(html).toContain("@media(max-width:768px)");
    expect(html).toContain(".sidebar{display:none!important}");
    expect(html).toContain("env(safe-area-inset-bottom)");
    expect(html).toContain("grid-template-columns:repeat(5,minmax(0,1fr))");
    expect(html).toContain("overflow-x:hidden");
    expect(html).toContain("min-height:44px");
    expect(html).toContain("Odblokuj pełną Emmę");
    expect(html).not.toContain("historyModal");
  });

  it("renders secure document/photo UI with lazy thumbs and an on-demand portal lightbox", async () => {
    const store = memoryStore(1, 0);
    const view = await new HospitalPortalViewModelService(store).build(auth());
    const item = view.initialCases.items[0]!;
    item.documents = [portalAsset("doc-1", "DOCUMENT", "Protokół naprawy")];
    item.photos = [portalAsset("photo-1", "IMAGE", "Zdjęcie 1")];
    view.focusedCase = item;
    const html = renderHospitalPortal(view, "nonce", new Date(), "/p/token");
    expect(html).toContain("id=\"photoLightbox\"");
    expect(html).toContain("fileUrl(asset.id,'thumb')");
    expect(html).toContain("fileUrl(asset.id,'portal')");
    expect(html).toContain("image.loading='lazy'");
    expect(html).toContain("photoLightboxImage.removeAttribute('src')");
    expect(html).toContain("event.key==='Escape'");
    expect(html).toContain("link.href=fileUrl(asset.id,'document')");
    expect(html).toContain("link.target='_blank'");
    expect(html).toContain("width:44px");
    expect(html).toContain("grid-template-columns:repeat(2,minmax(0,1fr))");
  });

  it("loads the Documents tab from the server and renders the real empty state", async () => {
    const base = memoryStore(0, 0);
    const calls: Array<{ hospitalId: string; query: string | null }> = [];
    const store: HospitalPortalStore = {
      ...base,
      async listDocuments(scope, query) {
        calls.push({ hospitalId: scope.hospitalId, query });
        return [portalAsset("doc-1", "DOCUMENT", "Dokument przeglądu")];
      },
    };
    const service = new HospitalPortalViewModelService(store);
    const page = await service.listDocuments(auth(), { query: "  pompa  " });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    expect(calls).toEqual([{ hospitalId: "hospital-A", query: "pompa" }]);
    const html = renderHospitalPortal(await service.build(auth()), "nonce");
    expect(html).toContain("api('documents',{q:documentsState.query})");
    expect(html).toContain("Nie masz obecnie udostępnionych dokumentów.");
    expect(html).not.toContain("Emma ma jeszcze 4 000 dokumentów");
  });

  it("renders a high-contrast CTA with hover, focus and safe contact fallback", async () => {
    const view = await new HospitalPortalViewModelService(memoryStore(1, 0)).build(auth());
    const html = renderHospitalPortal(view, "nonce");
    expect(html).toContain("background:var(--navy);color:#fff");
    expect(html).toContain(".upgrade-teaser a:hover,.upgrade-cta:hover");
    expect(html).toContain(".upgrade-teaser a:focus-visible,.upgrade-cta:focus-visible");
    expect(html).toContain("min-height:44px");
    expect(html).toContain('href="mailto:serwis@tiemed.pl?subject=Emma%20FULL"');
    expect(html).not.toContain("var(--blue)");
  });

  it("explains an empty COMMUNICATION portal without exposing locked records", async () => {
    const view = await new HospitalPortalViewModelService(memoryStore(0, 0)).build(auth());
    view.teaser = {
      totalDevices: 347, visibleDevices: 0, lockedDevices: 347,
      totalRepairs: 1_975, visibleRepairs: 0, lockedRepairs: 1_975,
      totalInspections: 1_240, visibleInspections: 0, lockedInspections: 1_240,
    };
    const html = renderHospitalPortal(view, "nonce");
    expect(html).toContain("Nie masz obecnie udostępnionych spraw.");
    expect(html).toContain("Emma posiada pełną historię aparatury i serwisu Twojego szpitala.");
    expect(html).toContain("<strong>347</strong><span>urządzeń</span>");
    expect(html).toContain("<strong>1975</strong><span>napraw</span>");
    expect(html).toContain("<strong>1240</strong><span>przeglądów</span>");
    expect(html).not.toContain("Brak spraw dostępnych w tym widoku.");
  });
});

function memoryStore(
  repairCount: number,
  inspectionCount: number,
  overrides: Partial<PortalCaseListItem> = {},
  _taskLinks: Record<string, string[]> = {},
): HospitalPortalStore & { seenScopes: string[] } {
  const repairs = Array.from({ length: repairCount }, (_, index) => caseItem("REPAIR", index, overrides));
  const inspections = Array.from({ length: inspectionCount }, (_, index) => caseItem("INSPECTION", index, overrides));
  const all = [...repairs, ...inspections].sort(compareCases);
  const seenScopes: string[] = [];
  const hospitalId = (scope: string | { hospitalId: string }) =>
    typeof scope === "string" ? scope : scope.hospitalId;
  const check = (scope: string | { hospitalId: string }) => {
    const hospital = hospitalId(scope);
    seenScopes.push(hospital);
    return hospital === "hospital-A";
  };
  const scoped = (_scope: { contextType: "REPAIR" | "INSPECTION_TASK"; contextId: string }) => all;
  return {
    seenScopes,
    async findHospital(scope) { check(scope); return { shortName: "SZA", name: "Szpital A", address: null }; },
    async getSummaryCounts(scope) {
      check(scope);
      const items = scoped(scope);
      return {
        repairs: items.filter((item) => item.type === "REPAIR").length,
        inspections: items.filter((item) => item.type === "INSPECTION").length,
        devices: uniqueDevices(all).length,
        requiresAction: items.filter((item) => item.requiresAction).length,
      };
    },
    async getTeaserCounts(scope) {
      check(scope);
      const visible = scoped(scope);
      const visibleRepairs = visible.filter((item) => item.type === "REPAIR").length;
      const visibleInspections = visible.filter((item) => item.type === "INSPECTION").length;
      const visibleDevices = uniqueDevices(visible).length;
      return {
        totalDevices: visibleDevices, visibleDevices, lockedDevices: 0,
        totalRepairs: visibleRepairs, visibleRepairs, lockedRepairs: 0,
        totalInspections: visibleInspections, visibleInspections, lockedInspections: 0,
      };
    },
    async pageCases(scope, options) {
      if (!check(scope)) return { items: [], nextCursor: null };
      let result = filterCases(scoped(scope), options.filter);
      if (options.deviceId) result = result.filter((item) => item.deviceId === options.deviceId);
      if (options.query) result = result.filter((item) => JSON.stringify(item).toLowerCase().includes(options.query!.toLowerCase()));
      const decoded = decodePortalCaseCursor(options.cursor);
      const start = decoded
        ? result.findIndex((item) => item.type === decoded.type &&
            item.sourceRecordId === decoded.sourceRecordId && sortKey(item) === decoded.sortKey) + 1
        : 0;
      const items = result.slice(start, start + options.limit);
      const last = items.at(-1);
      const next = start + items.length < result.length && last
        ? encodePortalCaseCursor({ type: last.type, sourceRecordId: last.sourceRecordId, sortKey: sortKey(last) })
        : null;
      return { items, nextCursor: next };
    },
    async findScopedCase(scope, id) { return check(scope) ? all.find((item) => item.sourceRecordId === id) ?? null : null; },
    async resolveFocusedCase(scope) {
      if (!check(scope)) return null;
      return all.find((item) => item.sourceRecordId === scope.contextId) ?? scoped(scope)[0] ?? null;
    },
    async pageDevices(scope, options) {
      if (!check(scope)) return { items: [], nextCursor: null };
      const devices = uniqueDevices(all).filter((item) => !options.query || JSON.stringify(item).toLowerCase().includes(options.query.toLowerCase()));
      const decoded = decodePortalDeviceCursor(options.cursor);
      const start = decoded
        ? devices.findIndex((item) => item.sourceRecordId === decoded.sourceRecordId) + 1
        : 0;
      const items = devices.slice(start, start + options.limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor: start + items.length < devices.length && last
          ? encodePortalDeviceCursor({ sourceRecordId: last.sourceRecordId, sortKey: 0n })
          : null,
      };
    },
    async findScopedDevice(scope, id, limit) {
      if (!check(scope) || id === "device-B") return null;
      const device = uniqueDevices(all).find((item) => item.sourceRecordId === id);
      return device ? {
        ...device,
        cases: { items: all.filter((item) => item.deviceId === id).slice(0, limit), nextCursor: null },
        lockedCaseCount: 0,
      } : null;
    },
  };
}

function sortKey(item: PortalCaseListItem): bigint {
  return BigInt(item.lastChangedAt?.getTime() ?? 0);
}

function compareCases(left: PortalCaseListItem, right: PortalCaseListItem): number {
  const time = Number(sortKey(right) - sortKey(left));
  if (time !== 0) return time;
  const type = right.type.localeCompare(left.type);
  return type !== 0 ? type : right.sourceRecordId.localeCompare(left.sourceRecordId);
}

function filterCases(items: PortalCaseListItem[], filter: PortalCaseFilter) {
  if (filter === "REPAIR") return items.filter((item) => item.type === "REPAIR");
  if (filter === "INSPECTION") return items.filter((item) => item.type === "INSPECTION");
  if (filter === "ACTION") return items.filter((item) => item.requiresAction);
  return items;
}

function uniqueDevices(items: PortalCaseListItem[]): PortalDevice[] {
  return [...new Map(items.filter((item) => item.deviceId).map((item) => [item.deviceId!, {
    sourceRecordId: item.deviceId!, deviceName: item.deviceName,
    manufacturer: item.manufacturer, model: item.model, serialNumber: item.serialNumber,
    inventoryNumber: item.inventoryNumber, currentStatus: item.currentStatus,
    validUntil: item.validUntil,
    inspectionPerformedAt: item.inspectionPerformedAt,
    inspectionResult: null,
  }])).values()];
}

function portalAsset(
  id: string,
  kind: "DOCUMENT" | "IMAGE",
  title: string,
): PortalDocument {
  return {
    id,
    fileName: kind === "DOCUMENT" ? "bezpieczna-nazwa.pdf" : "zdjecie.jpg",
    title,
    kind,
    role: kind === "DOCUMENT" ? "OTHER_DOCUMENT" : "PHOTO",
    documentType: title,
    sourceRecordId: "repair-0",
    caseType: "REPAIR",
    deviceName: "Pompa",
    manufacturer: "Producent",
    model: "Model",
    serialNumber: "SN-1",
    caseNumber: "CASE-1",
    caseDate: new Date("2026-08-13T00:00:00Z"),
    createdAt: new Date("2026-08-14T10:00:00Z"),
  };
}

function caseItem(
  type: "REPAIR" | "INSPECTION",
  index: number,
  overrides: Partial<PortalCaseListItem>,
): PortalCaseListItem {
  return {
    devices: [{
      sourceRecordId: `device-${index}`, deviceName: `Device ${index}`,
      manufacturer: "Producent", model: "M1", serialNumber: `SN-${index}`,
      inventoryNumber: `INV-${index}`,
    }],
    type, sourceRecordId: `${type === "REPAIR" ? "repair" : "inspection"}-${index}`,
    deviceId: `device-${index}`, deviceName: `Urządzenie UNIKAT-${index}`,
    manufacturer: "Producent", model: "M1", manufacturerModel: "Producent · M1",
    serialNumber: `SN-${index}`, inventoryNumber: `INV-${index}`,
    caseNumber: String(index), clientOrderNumber: null,
    currentStatus: type === "INSPECTION" ? "SPRAWNE" : "Diagnostyka",
    lastChangedAt: new Date(2026, 7, 13, 12, 0, -index), requiresAction: false,
    reportedAt: new Date("2026-08-01T10:00:00Z"), inspectionPerformedAt: null,
    validUntil: type === "INSPECTION" ? new Date("2027-08-01T00:00:00Z") : null,
    description: null, history: [], documents: [], photos: [], ...overrides,
  };
}

function auth(sourceRecordId = "repair-0") {
  return {
    sourceHospitalRecordId: "hospital-A",
    entryContext: {
      type: "SERVICE_ORDER" as const, sourceRecordId,
      scenario: CommunicationScenario.REPAIR_RECEIVED,
    },
  };
}

function taskAuth(sourceRecordId = "task-all") {
  return {
    sourceHospitalRecordId: "hospital-A",
    entryContext: {
      type: "TASK" as const, sourceRecordId,
      scenario: CommunicationScenario.INSPECTION_COMPLETED,
      linkedInspectionRecordIds: [], linkedServiceOrderRecordIds: [],
    },
  };
}
