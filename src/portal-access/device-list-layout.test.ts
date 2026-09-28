import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("./portal-page.ts", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("./portal-styles.ts", import.meta.url), "utf8");
const deviceRowSource = pageSource.slice(
  pageSource.indexOf("function makeDeviceRow"),
  pageSource.indexOf("const lists="),
);

describe("Device list layout", () => {
  it("renders four ordered logical cells and keeps the whole row clickable", () => {
    const main = deviceRowSource.indexOf("const main=");
    const deviceStatus = deviceRowSource.indexOf("device-list-device-status");
    const inspectionStatus = deviceRowSource.indexOf("device-list-inspection-status");
    const validity = deviceRowSource.indexOf("device-list-validity");

    expect(main).toBeGreaterThanOrEqual(0);
    expect(deviceStatus).toBeGreaterThan(main);
    expect(inspectionStatus).toBeGreaterThan(deviceStatus);
    expect(validity).toBeGreaterThan(inspectionStatus);
    expect(deviceRowSource).toContain("append(row,main,deviceState,inspectionState,validity)");
    expect(deviceRowSource).toContain("activate(row,()=>openDevice(item.sourceRecordId))");
  });

  it("uses the same device status value and pill helper as Device detail", () => {
    expect(deviceRowSource).toContain("deviceStatusPill(item.status,'device-list-device-pill')");
    expect(pageSource).toContain("renderDevice(item)");
    expect(pageSource).toContain("deviceStatusPill(item.status)");
    expect(pageSource).toContain("text(value,'Brak informacji')");
    expect(pageSource).toContain("function repairDeviceStatusVariant(status)");
  });

  it("keeps inspection health logic and separates its badge from validity text", () => {
    expect(pageSource).toContain("label:'Brak terminu',detail:'brak danych'");
    expect(pageSource).toContain("state:'overdue',label:'Przegląd nieaktualny'");
    expect(pageSource).toContain("state:days<=30?'soon':'ok',label:'Przegląd aktualny'");
    expect(deviceRowSource).toContain("inspectionState.append(node('span','inspection-state '+health.state,health.label))");
    expect(deviceRowSource).toContain("validity.append(node('span','inspection-date',health.detail))");
  });

  it("uses the requested desktop proportions without a visible header", () => {
    expect(styleSource).toContain("grid-template-columns:minmax(0,50fr) minmax(0,15fr) minmax(0,17fr) minmax(0,18fr)");
    expect(deviceRowSource).not.toContain("header");
  });

  it("stacks the identity and validity around two status columns on tablet and mobile", () => {
    expect(styleSource).toContain("@media(max-width:1080px)");
    expect(styleSource).toContain(".device-row-search{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}");
    expect(styleSource).toContain(".device-row-search .list-row-main,.device-list-validity{grid-column:1/-1}");
  });

  it("allows long device, department, and status text to wrap without horizontal overflow", () => {
    expect(styleSource).toContain(".device-row-search .list-row-main b,.device-row-search .list-row-main span{overflow-wrap:anywhere}");
    expect(styleSource).toContain(".device-list-device-pill{max-width:100%;white-space:normal;text-align:center}");
    expect(styleSource).toContain(".device-list-inspection-status .inspection-state{max-width:100%;white-space:normal;text-align:center}");
  });
});
