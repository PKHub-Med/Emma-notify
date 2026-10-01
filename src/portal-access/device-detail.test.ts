import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderHospitalPortal } from "./portal-page.js";
import type { HospitalPortalViewModel } from "./view-model.js";

const pageSource = readFileSync(new URL("./portal-page.ts", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("./portal-styles.ts", import.meta.url), "utf8");

describe("Device detail redesign", () => {
  it("renders Device through the shared detail layout and helpers", () => {
    const html = renderHospitalPortal(emptyView(), "nonce");

    expect(html).toContain("function renderDevice(item)");
    expect(html).toContain("caseDetailHeader('Urządzenia','Karta urządzenia'");
    expect(html).toContain("case-detail-hero device-detail-hero");
    expect(html).toContain("caseDetailSectionHeader('Dane urządzenia','device')");
    expect(html).toContain("deviceDataSection(item),caseDetailLocationSection(item.location),histories");
    expect(html).toContain("caseDetailRelatedCard('Zobacz dokumenty','document'");
  });

  it("renders the accepted Device data fields and uses the shared dash fallback", () => {
    const html = renderHospitalPortal(emptyView(), "nonce");
    const deviceData = html.slice(html.indexOf("function deviceDataSection"), html.indexOf("function deviceHistoryRow"));

    for (const label of [
      "Typ sprzętu", "Producent", "Model", "Numer seryjny", "Numer inwentarzowy",
      "Rok produkcji", "Data uruchomienia", "Gwarancja", "RFID / EPC",
    ]) expect(deviceData).toContain(`'${label}'`);
    expect(html).toContain("const text=(value,fallback='—')");
    expect(deviceData).not.toMatch(/\|\|\s*0|\?\?\s*0/);
    expect(deviceData).not.toContain("'null'");
    expect(deviceData).not.toContain("'undefined'");
  });

  it("reuses the three-box Location component", () => {
    expect(pageSource).toContain("caseDetailDeviceTile('Szpital',location.hospitalName)");
    expect(pageSource).toContain("caseDetailDeviceTile('Skrót',location.hospitalShortName)");
    expect(pageSource).toContain("caseDetailDeviceTile('Oddział',location.department)");
    expect(pageSource).toContain("caseDetailLocationSection(item.location)");
  });

  it("keeps inspection and repair histories clickable through existing Case details", () => {
    expect(pageSource).toContain("deviceHistorySection('Ostatnie przeglądy','INSPECTION',item.cases.items)");
    expect(pageSource).toContain("deviceHistorySection('Ostatnie naprawy','REPAIR',item.cases.items)");
    expect(pageSource).toContain("button.addEventListener('click',()=>openCase(item.sourceRecordId))");
    expect(pageSource).toContain("caseCache.set(item.sourceRecordId,item)");
  });

  it("describes empty histories as the last three months instead of the communication scope", () => {
    expect(pageSource).toContain("Brak przeglądów z ostatnich 3 miesięcy.");
    expect(pageSource).toContain("Brak napraw z ostatnich 3 miesięcy.");
    expect(pageSource).not.toContain("Brak danych w obecnym zakresie historii.");
  });

  it("omits the empty history date instead of rendering a dash or reserving its column", () => {
    const historyRow = pageSource.slice(
      pageSource.indexOf("function deviceHistoryRow"),
      pageSource.indexOf("function deviceHistorySection"),
    );

    expect(historyRow).toContain("if(rawDate){button.classList.add('has-date')");
    expect(historyRow).toContain("button.append(node('span','device-detail-history-date'");
    expect(historyRow).not.toContain("node('span','device-detail-history-date',date)");
    expect(styleSource).toContain(".device-detail-history-row{display:grid;grid-template-columns:minmax(120px,1fr) minmax(110px,1fr) 18px");
    expect(styleSource).toContain(".device-detail-history-row.has-date{grid-template-columns:minmax(82px,.75fr)");
  });

  it("keeps the latest inspection separate from the cutoff-limited history query", () => {
    expect(pageSource).toContain("deviceInspectionSection(item)");
    expect(pageSource).toContain("item.inspectionPerformedAt?formatDate(item.inspectionPerformedAt):null");
    expect(pageSource).toContain("item.validUntil?formatDate(item.validUntil):null");
    expect(pageSource).toContain("deviceHistorySection('Ostatnie przeglądy','INSPECTION',item.cases.items)");
  });

  it("uses one-column Device grids on mobile without changing shared cards", () => {
    expect(styleSource).toContain(".device-detail-history-grid{display:grid;grid-template-columns:repeat(2");
    expect(styleSource).toContain(".device-detail-inspection-grid,.device-detail-history-grid{grid-template-columns:1fr}");
    expect(styleSource).toContain(".case-detail-location .case-detail-grid,.case-detail-media-grid,.case-detail-links-grid{grid-template-columns:1fr}");
    expect(pageSource).toContain("function renderInspectionDetail(item,detail)");
    expect(pageSource).toContain("function renderRepairDetail(item,detail)");
  });

  it("gives the Device hero text a flexible mobile column at phone widths", () => {
    expect(styleSource).toContain(".device-detail-hero{grid-template-columns:56px minmax(0,1fr)}");
    expect(styleSource).toContain(".device-detail-hero{grid-template-columns:52px minmax(0,1fr)}");
    expect(styleSource).toContain("word-break:normal;overflow-wrap:break-word");
    expect(styleSource).toContain(".device-detail-history-row.has-date{grid-template-columns:1fr 18px}");
  });
});

function emptyView(): HospitalPortalViewModel {
  return {
    hospital: { shortName: "Szpital", name: "Szpital", address: null },
    serviceProviderName: "Tiemed",
    summary: { requiresAction: 0, repairs: 0, inspections: 0, devices: 0 },
    accessLevel: "FULL",
    teaser: {
      totalDevices: 0, visibleDevices: 0, lockedDevices: 0,
      totalRepairs: 0, visibleRepairs: 0, lockedRepairs: 0,
      totalInspections: 0, visibleInspections: 0, lockedInspections: 0,
    },
    upgradeUrl: "https://example.invalid/upgrade",
    initialCases: { items: [], nextCursor: null },
    focusedCase: null,
  };
}
