import { describe, expect, it } from "vitest";
import { featureActionBehavior, renderHospitalPortal } from "./portal-page.js";
import type { HospitalPortalViewModel } from "./view-model.js";

describe("shared unavailable-feature modal", () => {
  it("keeps a real URL as normal navigation and does not select the modal", () => {
    expect(featureActionBehavior({ url: "/working-route" })).toBe("NAVIGATE");
  });

  it("uses the modal only when no URL or handler exists", () => {
    expect(featureActionBehavior({ hasHandler: true })).toBe("EXECUTE");
    expect(featureActionBehavior({})).toBe("UPGRADE_MODAL");
  });

  it("renders one accessible modal with clickable email and every close mechanism", () => {
    const html = renderHospitalPortal(emptyView(), "nonce");
    expect(html.match(/id="featureModal"/g)).toHaveLength(1);
    expect(html).toContain('href="mailto:pawel@emmamed.com"');
    expect(html).toContain('id="featureModalClose"');
    expect(html).toContain('id="featureModalX"');
    expect(html).toContain("featureModal.addEventListener('click'");
    expect(html).toContain("event.key==='Escape'&&!featureModal.hidden");
    expect(html).toContain("event.key==='Tab'&&!featureModal.hidden");
  });

  it("routes inspection controls structurally and leaves no disabled V5 CTA", () => {
    const html = renderHospitalPortal(emptyView(), "nonce");
    expect(html).toContain("button.dataset.hasRealAction=String(Boolean(action))");
    expect(html).toContain("action||openFeatureModal");
    expect(html).not.toContain("inspection-v5-link:disabled");
    expect(html).not.toContain("button.disabled=true");
  });

  it("renders the shared TARGET-aligned inspection layout from structural variants", () => {
    const html = renderHospitalPortal(emptyView(), "nonce");

    expect(html).toContain("const CASE_DETAIL_VARIANTS={");
    expect(html).toContain("function caseDetailStatusPanel(d)");
    expect(html).toContain("function caseDetailDeviceSection(d)");
    expect(html).toContain("function caseDetailRelatedSection(d)");
    expect(html).toContain("caseDetailDeviceTile('RFID / EPC'");
    expect(html).toContain("case-detail-active");
    expect(html).not.toContain("inspection-v5-");
  });

  it("routes repairs through the shared detail renderer without the legacy timeline", () => {
    const html = renderHospitalPortal(emptyView(), "nonce");
    expect(html).toContain("function renderRepairDetail(item,detail)");
    expect(html).toContain("function renderInspectionDetail(item,detail)");
    expect(html).toContain("'Szczegóły naprawy'");
    expect(html).toContain("'Dane urządzenia'");
    expect(html).toContain("'Uwagi / diagnostyka / opis usterki'");
    expect(html).toContain("'Dokumenty naprawy'");
    expect(html).toContain("'Zdjęcia z naprawy'");
    expect(html).toContain("'Powiązane informacje'");
    const repairRenderer = html.slice(html.indexOf("function renderRepairDetail"), html.indexOf("function renderCase(item)"));
    expect(repairRenderer).not.toContain("renderHistory(");
    expect(repairRenderer).not.toContain("Dokument przeglądu");
    expect(repairRenderer).not.toContain("Zdjęcia z przeglądu");
  });

  it("uses SVG refresh and explicit fill variants without changing shared stroke icons", () => {
    const html = renderHospitalPortal(emptyView(), "nonce");
    expect(html).not.toContain("content:'↻'");
    expect(html).toContain("refresh:['M20 11a8 8 0 1 0-2.34 5.66','M20 4v7h-7']");
    expect(html).toContain("gear:{style:'fill'");
    expect(html).toContain("location:{style:'fill',nodes:");
    expect(html).toContain("document:{style:'fill',nodes:");
    expect(html).toContain("camera:{style:'fill',nodes:");
    expect(html).toContain("caseDetailLocationSection(d,'fill')");
    expect(html).toContain("'Dokumenty naprawy','document',null,'fill'");
    expect(html).toContain("'Zdjęcia z naprawy','camera',count?node('span','case-detail-photo-count',String(count)):null,'fill'");
    expect(html).toContain(".case-detail-icon.is-stroke svg{fill:none");
  });

  it("keeps repair-specific SVG paths exact without changing inspection icons", () => {
    const html = renderHospitalPortal(emptyView(), "nonce");
    const repairRenderer = html.slice(html.indexOf("function renderRepairDetail"), html.indexOf("function renderCase(item)"));

    expect(html).toContain('repairStatus:["M14.7 6.3a4 4 0 0 0-5-5l2.1 2.1-2.8 2.8L6.9 4.1a4 4 0 0 0 5 5l6.7 6.7a2 2 0 1 1-2.8 2.8L9.1 11.9","m5 19 4-4"]');
    expect(html).toContain("caseDetailIcon('repairStatus')");
    expect(html).toContain("repairExclamation:['M12 7v6','M12 17h.01']");
    expect(html).toContain("normalized==='WARUNKOWO DOPUSZCZONY')return{tone:'warning',icon:'repairExclamation'}");
    expect(html).toContain("normalized==='NIESPRAWNY')return{tone:'danger',icon:'repairExclamation'}");
    expect(html).toContain("normalized==='WYCOFANY Z UŻYTKU'||normalized==='SKASOWANY')return{tone:'neutral',icon:'repairExclamation'}");

    expect(html).toContain("repairCalendar:{style:'stroke',nodes:[['rect',{x:'3',y:'5',width:'18',height:'16',rx:'2'}],['path',{d:'M16 3v4M8 3v4M3 10h18'}],['path',{d:'M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01'}]]}");
    expect(repairRenderer.match(/'repairCalendar'/g)).toHaveLength(3);

    expect(html).toContain("repairDocument:['M6 2h8l4 4v16H6z','M14 2v5h5','M9 12h6M9 16h6']");
    expect(repairRenderer.match(/'repairDocument'/g)).toHaveLength(3);
    expect(html).toContain("caseDetailMediaEmpty('repairDocument','Brak dokumentów.'");

    expect(html).toContain("repairCamera:{style:'stroke',nodes:[['path',{d:'M4 7h4l2-2h4l2 2h4v12H4z'}],['circle',{cx:'12',cy:'13',r:'3.5'}]]}");
    expect(html).toContain("caseDetailMediaEmpty('repairCamera','Brak zdjęć.'");

    expect(html).toContain("calendar:['M6 2v4','M18 2v4','M3 9h18','M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z']");
    expect(html).toContain("document:['M6 2h9l3 3v17H6z','M14 2v5h5','M9 13h6','M9 17h6']");
    expect(html).toContain("camera:['M4 7h3l2-3h6l2 3h3v13H4z','M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z']");
    expect(html).toContain("alert:['M12 8v5','M12 17h.01','M10.3 2.9 1.8 17.1A2 2 0 0 0 3.5 20h17a2 2 0 0 0 1.7-2.9L13.7 2.9a2 2 0 0 0-3.4 0Z']");
    expect(html).toContain("wrench:['M14.7 6.3a4 4 0 0 0-5-5L12 3.6 8.6 7 6.3 4.7a4 4 0 0 0 5 5L4 17l3 3 7.3-7.3a4 4 0 0 0 .4-6.4Z']");
    expect(repairRenderer).toContain("'Zobacz powiązane przeglądy','wrench'");
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
