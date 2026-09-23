import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("./portal-page.ts", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("./portal-styles.ts", import.meta.url), "utf8");

describe("shared case-detail responsive shell", () => {
  it("renders Repair and Inspection through one header with one actions container", () => {
    expect(pageSource).toContain("function caseDetailHeader(");
    expect(pageSource).toContain("case-detail-header-actions");
    expect(pageSource).toMatch(/renderInspectionDetail[\s\S]*?caseDetailHeader\('Przeglądy'/);
    expect(pageSource).toMatch(/renderRepairDetail[\s\S]*?caseDetailHeader\('Naprawy'/);
  });

  it("places meta and refresh together after the header main content", () => {
    const header = pageSource.slice(
      pageSource.indexOf("function caseDetailHeader("),
      pageSource.indexOf("function caseDetailSectionHeader("),
    );

    expect(header).toContain("actions.append(meta)");
    expect(header).toContain("actions.append(refreshBar)");
    expect(header.indexOf("append(head,main,actions)")).toBeGreaterThan(
      header.indexOf("actions.append(refreshBar)"),
    );
  });

  it("keeps mobile header controls in document flow", () => {
    const mobile = styleSource.slice(styleSource.lastIndexOf("@media(max-width:768px)"));

    expect(mobile).toContain(".case-detail-header{display:block");
    expect(mobile).toContain(".case-detail-header .portal-refresh-message{position:static");
    expect(mobile).not.toMatch(/\.case-detail-header \.portal-refresh-bar\{[^}]*position:absolute/);
  });

  it("uses shared grid classes for 3-to-2-to-1 layouts", () => {
    expect(styleSource).toContain(".case-detail-result-grid{display:grid;grid-template-columns:repeat(3");
    expect(styleSource).toContain(".case-detail-device-data .case-detail-grid{display:grid;grid-template-columns:repeat(3");
    expect(styleSource).toContain("grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(styleSource).toContain(".case-detail-media-grid,.case-detail-links-grid{grid-template-columns:1fr}");
  });

  it("reserves the fixed mobile navigation height through one variable", () => {
    expect(styleSource).toContain("--mobile-nav-height:60px");
    expect(styleSource).toContain("padding:16px 16px calc(var(--mobile-nav-height) + env(safe-area-inset-bottom) + 16px)");
    expect(styleSource).toContain(".sidebar{display:none!important}");
  });
});
