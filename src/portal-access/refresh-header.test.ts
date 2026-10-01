import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderHospitalPortal } from "./portal-page.js";
import type { HospitalPortalViewModel } from "./view-model.js";

const pageSource = readFileSync(new URL("./portal-page.ts", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("./portal-styles.ts", import.meta.url), "utf8");

describe("shared portal refresh header status", () => {
  it("keeps the live status outside the action button", () => {
    const html = renderHospitalPortal(emptyView(), "nonce");
    const buttonStart = html.indexOf('id="portalRefreshButton"');
    const buttonEnd = html.indexOf("</button>", buttonStart);
    const buttonMarkup = html.slice(buttonStart, buttonEnd);

    expect(html.indexOf('id="portalRefreshMessage"')).toBeLessThan(buttonStart);
    expect(buttonMarkup).not.toContain("portalRefreshMessage");
    expect(buttonMarkup).toContain("Aktualizuj dane");
  });

  it("uses the existing header meta slot for the original timestamp and refresh feedback", () => {
    const header = pageSource.slice(
      pageSource.indexOf("function caseDetailHeader("),
      pageSource.indexOf("function caseDetailSectionHeader("),
    );

    expect(header).toContain("mountRefreshStatus(meta,metaText)");
    expect(header).toContain("actions.append(meta)");
    expect(header).toContain("actions.append(refreshBar)");
    expect(pageSource).toContain("refreshMessage.dataset.defaultText=defaultText");
    expect(pageSource).toContain("refreshFeedback?.text||defaultText");
    expect(pageSource).toContain("d.headerDateType+': '+formatDate(d.headerDate)");
  });

  it("disables and restores the button without putting feedback into its label", () => {
    const refresh = pageSource.slice(
      pageSource.indexOf("async function requestPortalRefresh"),
      pageSource.indexOf("refreshButton.addEventListener"),
    );

    expect(refresh).toContain("refreshButton.disabled=true");
    expect(refresh).toContain("setRefreshButtonLabel('Aktualizuję dane…')");
    expect(refresh).toContain("refreshButton.disabled=false");
    expect(refresh).toContain("setRefreshButtonLabel('Aktualizuj dane')");
    expect(refresh).toContain("setRefreshFeedback('error','Nie udało się zaktualizować danych. Spróbuj ponownie.')");
  });

  it("replaces the default meta with the successful refresh time", () => {
    expect(pageSource).toContain(
      "setRefreshFeedback('success','Ostatnia aktualizacja: '",
    );
    expect(pageSource).not.toContain("Dane zaktualizowane •");
    expect(pageSource).toContain("setRefreshFeedback(null)");
    expect(pageSource).toContain("formatTechnicalDateTime(updatedAt)");
    expect(pageSource).not.toContain("refreshMessage.textContent='Dane zaktualizowane");
  });

  it("routes Inspection, Repair and Device through the same header helper", () => {
    expect(pageSource).toMatch(/renderInspectionDetail[\s\S]*?caseDetailHeader\('Przeglądy'/);
    expect(pageSource).toMatch(/renderRepairDetail[\s\S]*?caseDetailHeader\('Naprawy'/);
    expect(pageSource).toMatch(/renderDevice[\s\S]*?caseDetailHeader\('Urządzenia'/);
  });

  it("does not position refresh feedback over the button at any breakpoint", () => {
    expect(styleSource).not.toMatch(/\.portal-refresh-message\{[^}]*position:absolute/);
    expect(styleSource).toContain(".case-detail-header .portal-refresh-message{position:static");
    expect(styleSource).toContain(".page-title-row>.portal-refresh-message{margin-left:auto;text-align:right}");
    expect(styleSource).toContain(".page-title-row>.portal-refresh-message{margin-left:0;text-align:left}");
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
