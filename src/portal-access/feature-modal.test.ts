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
