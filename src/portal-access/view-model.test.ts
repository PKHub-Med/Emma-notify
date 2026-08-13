import { describe, expect, it } from "vitest";
import { CommunicationScenario } from "../generated/prisma/enums.js";
import { renderHospitalPortal } from "./portal-page.js";
import {
  HospitalPortalViewModelService,
  type HospitalPortalStore,
  type PortalCaseFilter,
  type PortalCaseListItem,
  type PortalDevice,
} from "./view-model.js";

describe("paginated hospital portal", () => {
  it("renders at most 30 of 3200 records while preserving DB counts", async () => {
    const store = memoryStore(2000, 1200);
    const service = new HospitalPortalViewModelService(store, "Tiemed", 30);
    const view = await service.build(auth());
    const html = renderHospitalPortal(view, "nonce", new Date(), "/p/token");

    expect(view.summary).toEqual({ repairs: 2000, inspections: 1200, requiresAction: 0 });
    expect(view.initialCases.items).toHaveLength(30);
    expect(html.match(/class="task case-open"/g)).toHaveLength(30);
    expect(html).not.toContain("repair-1999");
    expect(html.length).toBeLessThan(200_000);
  });

  it("returns consecutive cursor pages without duplicates", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(75, 0), "Tiemed", 30);
    const first = await service.listCases(auth(), { filter: "REPAIR" });
    const second = await service.listCases(auth(), { filter: "REPAIR", cursor: first.nextCursor! });
    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(30);
    expect(new Set([...first.items, ...second.items].map((item) => item.sourceRecordId)).size).toBe(60);
  });

  it("clamps a hostile requested limit to 100", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(500, 0), "Tiemed", 30);
    const page = await service.listCases(auth(), { limit: 100_000 });
    expect(page.items).toHaveLength(100);
  });

  it("server-side search finds a record outside page one", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(2000, 0), "Tiemed", 30);
    const result = await service.listCases(auth(), { query: "UNIKAT-1999" });
    expect(result.items.map((item) => item.sourceRecordId)).toEqual(["repair-1999"]);
  });

  it("focused context and case detail work outside page one", async () => {
    const service = new HospitalPortalViewModelService(memoryStore(2000, 0), "Tiemed", 30);
    const authorization = auth("repair-1999");
    const view = await service.build(authorization);
    expect(view.initialCases.items.some((item) => item.sourceRecordId === "repair-1999")).toBe(false);
    expect(view.focusedCase?.sourceRecordId).toBe("repair-1999");
    expect((await service.getCase(authorization, "repair-1999"))?.caseNumber).toBe("1999");
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

  it("keeps mixed open and closed inspections as independent sibling records", async () => {
    const store = memoryStore(0, 2);
    const page = await new HospitalPortalViewModelService(store).listCases(auth(), {
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
): HospitalPortalStore & { seenScopes: string[] } {
  const repairs = Array.from({ length: repairCount }, (_, index) => caseItem("REPAIR", index, overrides));
  const inspections = Array.from({ length: inspectionCount }, (_, index) => caseItem("INSPECTION", index, overrides));
  const all = [...repairs, ...inspections];
  const seenScopes: string[] = [];
  const check = (scope: string) => { seenScopes.push(scope); return scope === "hospital-A"; };
  return {
    seenScopes,
    async findHospital(scope) { check(scope); return { shortName: "SZA", name: "Szpital A", address: null }; },
    async getSummaryCounts(scope) {
      check(scope);
      return { repairs: repairCount, inspections: inspectionCount, requiresAction: 0 };
    },
    async pageCases(scope, options) {
      if (!check(scope)) return { items: [], nextCursor: null };
      let result = filterCases(all, options.filter);
      if (options.deviceId) result = result.filter((item) => item.deviceId === options.deviceId);
      if (options.query) result = result.filter((item) => JSON.stringify(item).toLowerCase().includes(options.query!.toLowerCase()));
      const start = options.cursor ? Number(Buffer.from(options.cursor, "base64url").toString("utf8")) : 0;
      const items = result.slice(start, start + options.limit);
      const next = start + items.length < result.length
        ? Buffer.from(String(start + items.length)).toString("base64url") : null;
      return { items, nextCursor: next };
    },
    async findScopedCase(scope, id) { return check(scope) ? all.find((item) => item.sourceRecordId === id) ?? null : null; },
    async resolveFocusedCase(scope, entry) { return check(scope) ? all.find((item) => item.sourceRecordId === entry.sourceRecordId) ?? null : null; },
    async pageDevices(scope, options) {
      if (!check(scope)) return { items: [], nextCursor: null };
      const devices = uniqueDevices(all).filter((item) => !options.query || JSON.stringify(item).toLowerCase().includes(options.query.toLowerCase()));
      return { items: devices.slice(0, options.limit), nextCursor: null };
    },
    async findScopedDevice(scope, id, limit) {
      if (!check(scope) || id === "device-B") return null;
      const device = uniqueDevices(all).find((item) => item.sourceRecordId === id);
      return device ? { ...device, cases: { items: all.filter((item) => item.deviceId === id).slice(0, limit), nextCursor: null } } : null;
    },
  };
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
  }])).values()];
}

function caseItem(
  type: "REPAIR" | "INSPECTION",
  index: number,
  overrides: Partial<PortalCaseListItem>,
): PortalCaseListItem {
  return {
    type, sourceRecordId: `${type === "REPAIR" ? "repair" : "inspection"}-${index}`,
    deviceId: `device-${index}`, deviceName: `Urządzenie UNIKAT-${index}`,
    manufacturer: "Producent", model: "M1", manufacturerModel: "Producent · M1",
    serialNumber: `SN-${index}`, inventoryNumber: `INV-${index}`,
    caseNumber: String(index), clientOrderNumber: null, currentStatus: "Diagnostyka",
    lastChangedAt: new Date(2026, 7, 13, 12, 0, -index), requiresAction: false,
    reportedAt: new Date("2026-08-01T10:00:00Z"), inspectionPerformedAt: null,
    validUntil: type === "INSPECTION" ? new Date("2027-08-01T00:00:00Z") : null,
    description: null, history: [], documents: [], photos: [], ...overrides,
  };
}

function auth(sourceRecordId = "missing") {
  return {
    sourceHospitalRecordId: "hospital-A",
    entryContext: {
      type: "SERVICE_ORDER" as const, sourceRecordId,
      scenario: CommunicationScenario.REPAIR_RECEIVED,
    },
  };
}
