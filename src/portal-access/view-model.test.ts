import { describe, expect, it } from "vitest";
import { CommunicationScenario } from "../generated/prisma/enums.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { renderHospitalPortal } from "./portal-page.js";
import {
  decodePortalCaseCursor,
  decodePortalDeviceCursor,
  encodePortalCaseCursor,
  encodePortalDeviceCursor,
  HospitalPortalViewModelService,
  InvalidPortalCursorError,
  PrismaHospitalPortalStore,
  type HospitalPortalStore,
  type PortalCaseFilter,
  type PortalCaseListItem,
  type PortalDevice,
} from "./view-model.js";

describe("paginated hospital portal", () => {
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

  it("rejects an invalid cursor instead of restarting or throwing an uncontrolled error", () => {
    const service = new HospitalPortalViewModelService(memoryStore(65, 0), "Tiemed", 30);
    expect(() => service.listCases(auth(), { cursor: "not+url/safe=" }))
      .toThrow(InvalidPortalCursorError);
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

  it("repair context exposes only its exact case", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(2000, 0), "Tiemed", 30);
    const authorization = auth("repair-1999");
    const view = await service.build(authorization);
    expect(view.initialCases.items.map((item) => item.sourceRecordId)).toEqual(["repair-1999"]);
    expect(view.focusedCase?.sourceRecordId).toBe("repair-1999");
    expect((await service.getCase(authorization, "repair-1999"))?.caseNumber).toBe("1999");
    expect(await service.getCase(authorization, "repair-1")).toBeNull();
  });

  it("inspection-task context exposes only its linked inspections and repairs", async () => {
    const store = memoryStore(20, 10, { deviceId: "shared-device" }, {
      "task-T3": ["inspection-7", "inspection-8", "repair-10"],
    });
    const service = new HospitalPortalViewModelService(store, "Tiemed", 30);
    const authorization = taskAuth("task-T3");
    const inspections = await service.listCases(authorization, { filter: "INSPECTION" });
    const repairs = await service.listCases(authorization, { filter: "REPAIR" });
    const devices = await service.listDevices(authorization, {});
    expect(inspections.items.map((item) => item.sourceRecordId).sort()).toEqual([
      "inspection-7", "inspection-8",
    ]);
    expect(repairs.items.map((item) => item.sourceRecordId)).toEqual(["repair-10"]);
    expect(repairs.items.some((item) => item.sourceRecordId === "repair-11")).toBe(false);
    expect(devices.items.map((item) => item.sourceRecordId)).toEqual(["shared-device"]);
  });

  it("builds task SQL from task references, hospital ownership and completed inspection statuses", async () => {
    const queries: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
    const prisma = {
      $queryRaw: async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        queries.push(query);
        return [];
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
    expect(sql).toContain('context_task."linkedInspectionRecordIds" ? c."airtableRecordId"');
    expect(sql).toContain('context_task."linkedServiceOrderRecordIds" ? c."airtableRecordId"');
    expect(sql).toContain('context_task."sourceHospitalRecordId" =');
    expect(sql).toContain("'SPRAWNE', 'NIESPRAWNE', 'WARUNKOWO DOPUSZCZONE'");
    expect(sql).toContain("WHEN 'NIESPRAWNE' THEN 3");
    expect(sql).toContain("WHEN 'WARUNKOWO DOPUSZCZONE' THEN 2");
    expect(queries[0]!.values).toContain("task-T3");
    expect(queries[0]!.values).toContain("hospital-A");
    expect(queries[1]!.strings.join("?")).toContain('FROM "TrackedDevice" d');
    expect(queries[1]!.strings.join("?")).toContain('d."sourceHospitalRecordId" =');
    expect(queries[1]!.strings.join("?")).toContain('COALESCE(d."sourceModifiedAt", d."sourceCreatedAt"');
    expect(queries[1]!.strings.join("?")).not.toContain('d."updatedAt"');
    expect(queries[2]!.strings.join("?")).toContain('c."inspectionPerformedAt" IS NOT NULL');
    expect(queries[2]!.strings.join("?")).toContain('JOIN "TrackedCaseDevice"');
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
        inspectionResult: "SPRAWNE", inspectionValidUntil: new Date("2027-08-13T00:00:00Z"),
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
    const prisma = {
      $queryRaw: async () => [{
        type: "REPAIR", sourceRecordId: "repair-H1", sortKey: 1n,
      }],
      trackedCase: { findMany: async () => [{
        id: "case-H1", airtableRecordId: "repair-H1", businessNumber: "R1",
        clientOrderNumber: null, emmaCustomerStatus: "Naprawa", hospitalName: null,
        deviceName: "Snapshot H1", manufacturer: "Snapshot maker", model: "S1",
        serialNumber: "SN-HIST", inventoryNumber: "INV-HIST", currentStatus: null,
        faultDescription: null, sourceCreatedAt: null, reportedAt: null,
        sourceModifiedAt: null, inspectionDueDate: null, inspectionPerformedAt: null,
        inspectionResult: null, inspectionValidUntil: null, events: [],
      }] },
      trackedTask: { findMany: async () => [] },
      trackedCaseDevice: { findMany: async () => [{
        trackedCaseId: "case-H1", deviceAirtableId: "device-now-H2",
      }] },
      trackedDevice: { findMany: async ({ where }: { where: unknown }) => {
        linkedDeviceWhere = where;
        return [];
      } },
    } as unknown as PrismaClient;
    const store = new PrismaHospitalPortalStore(prisma);
    const item = await store.findScopedCase({
      hospitalId: "H1", contextType: "REPAIR", contextId: "repair-H1",
    }, "repair-H1");
    expect(linkedDeviceWhere).toMatchObject({ sourceHospitalRecordId: "H1" });
    expect(item?.devices[0]).toMatchObject({
      sourceRecordId: "device-now-H2",
      deviceName: "Snapshot H1",
      serialNumber: "SN-HIST",
    });
    expect(item?.deviceId).toBeNull();
    expect(item?.devices[0]?.deviceName).not.toBe("Current H2");
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
        queries.push(query); return [];
      },
    } as unknown as PrismaClient;
    const store = new PrismaHospitalPortalStore(prisma);
    expect(await store.findScopedDevice({
      hospitalId: "H1", contextType: "REPAIR", contextId: "repair-H1",
    }, "device-H2", 30)).toBeNull();
    expect(await store.findScopedDevice({
      hospitalId: "H2", contextType: "REPAIR", contextId: "repair-H1",
    }, "device-H2", 30)).not.toBeNull();
    const historySql = queries.at(-1)!.strings.join("?");
    expect(historySql).toContain('c."sourceHospitalRecordId" =');
    expect(queries.at(-1)!.values).toContain("H2");
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
      $queryRaw: async () => rawCalls++ === 0 ? keys : [],
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
      hospitalId: "hospital-A", contextType: "INSPECTION_TASK", contextId: "task-A",
    }, { query: null, cursor: null, limit: 30 });
    expect(page.items).toHaveLength(30);
    expect(page.nextCursor).not.toBeNull();
    expect(findManyCalls).toBe(1);
    expect(rawCalls).toBe(2);
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
        return [];
      },
    } as unknown as PrismaClient;
    const store = new PrismaHospitalPortalStore(prisma);
    await store.findScopedDevice({
      hospitalId: "hospital-A", contextType: "REPAIR", contextId: "repair-other",
    }, "device-A", 30);
    const detailCasesSql = queries[1]!.strings.join("?");
    expect(detailCasesSql).toContain('c."sourceHospitalRecordId" =');
    expect(detailCasesSql).toContain('FROM "TrackedCaseDevice" case_device');
    expect(detailCasesSql).toContain('case_device."deviceAirtableId" =');
    expect(queries[1]!.values).toContain("hospital-A");
    expect(queries[1]!.values).toContain("device-A");
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
});

function memoryStore(
  repairCount: number,
  inspectionCount: number,
  overrides: Partial<PortalCaseListItem> = {},
  taskLinks: Record<string, string[]> = {},
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
  const scoped = (scope: { contextType: "REPAIR" | "INSPECTION_TASK"; contextId: string }) => {
    if (scope.contextType === "REPAIR") {
      return all.filter((item) => item.type === "REPAIR" && item.sourceRecordId === scope.contextId);
    }
    const linkedIds = taskLinks[scope.contextId];
    return linkedIds ? all.filter((item) => linkedIds.includes(item.sourceRecordId)) : all;
  };
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
    async findScopedCase(scope, id) { return check(scope) ? scoped(scope).find((item) => item.sourceRecordId === id) ?? null : null; },
    async resolveFocusedCase(scope) { return check(scope) ? scoped(scope)[0] ?? null : null; },
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
      return device ? { ...device, cases: { items: all.filter((item) => item.deviceId === id).slice(0, limit), nextCursor: null } } : null;
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
