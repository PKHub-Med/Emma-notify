import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("./portal-page.ts", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("./portal-styles.ts", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n");
const repairRowSource = pageSource.slice(
  pageSource.indexOf("function makeRepairRow"),
  pageSource.indexOf("function makeInspectionRow"),
);
const inspectionRowSource = pageSource.slice(
  pageSource.indexOf("function makeInspectionRow"),
  pageSource.indexOf("function makeDeviceRow"),
);

describe("Repair and inspection Device state columns", () => {
  it.each([
    ["Repair", repairRowSource, "Status naprawy", "append(row,main,makeCaseDeviceStatus(item),state,date)"],
    ["Inspection", inspectionRowSource, "Status przeglądu", "append(row,main,makeCaseDeviceStatus(item),middle,dates)"],
  ])("renders the ordered four-area %s row", (_name, source, statusLabel, appendOrder) => {
    expect(source).toContain("case-list-main");
    expect(source).toContain(statusLabel);
    expect(source).toContain("case-list-dates");
    expect(source).toContain(appendOrder);
  });

  it("uses the Devices screen pill helper and the explicit missing-state fallback", () => {
    expect(pageSource).toContain(
      "deviceStatusPill(text(item.emmaDeviceStatus,'Brak informacji'),'device-list-device-pill')",
    );
    expect(pageSource).toContain(
      "deviceStatusPill(item.status,'device-list-device-pill')",
    );
    expect(pageSource).toContain("function repairDeviceStatusVariant(status)");
  });

  it("shares typography and vertical alignment across every cell after Device data", () => {
    expect(styleSource).toContain(".case-list-cell{");
    expect(styleSource).toContain("font-family:inherit;\n  font-size:12px;");
    expect(styleSource).toContain("justify-content:center;");
    expect(styleSource).toContain(".case-list-cell .status-tag,\n.case-list-cell .case-detail-status-pill{");
    expect(styleSource).toContain(".case-list-cell strong{font-size:12px");
    expect(styleSource).toContain(".case-list-cell .case-list-label,\n.case-list-dates b{");
  });

  it("uses four desktop columns and a one-column mobile layout without horizontal scrolling", () => {
    expect(styleSource).toContain(
      "grid-template-columns:minmax(0,48fr) minmax(130px,17fr) minmax(145px,18fr) minmax(135px,17fr)",
    );
    expect(styleSource).toContain("@media(max-width:800px){\n  .case-list-row{grid-template-columns:minmax(0,1fr);gap:11px}");
    expect(styleSource).toContain(".case-list-cell{padding-top:10px;border-top:1px solid var(--line);align-items:flex-start}");
    expect(styleSource).not.toContain(".case-list-row{overflow-x:auto");
  });
});
