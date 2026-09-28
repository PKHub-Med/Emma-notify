import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatDate } from "./portal-page.js";

const pageSource = readFileSync(new URL("./portal-page.ts", import.meta.url), "utf8");
const legacyPageSource = readFileSync(new URL("../access-links/public-page.ts", import.meta.url), "utf8");

describe("portal date presentation", () => {
  it("formats all business timestamps as DD.MM.RRRR in Europe/Warsaw", () => {
    const timestamp = new Date("2026-08-27T11:09:00.000Z");

    expect(formatDate(timestamp)).toBe("27.08.2026");
  });

  it("does not shift Airtable date-only values at UTC midnight", () => {
    expect(formatDate(new Date("2026-08-27T00:00:00.000Z"))).toBe("27.08.2026");
  });

  it("uses date-only formatting for case lists and change history", () => {
    expect(pageSource).toContain("node('div','task-date',formatDate(item.lastChangedAt))");
    expect(pageSource).toContain("node('div','case-history-date',formatDate(event.changedAt))");
    expect(pageSource).not.toContain("formatDateTime(item.lastChangedAt)");
    expect(pageSource).not.toContain("formatDateTime(event.changedAt)");
  });

  it("keeps date and time only for technical update information", () => {
    const calls = pageSource.match(/formatTechnicalDateTime\(/g) ?? [];

    expect(calls).toHaveLength(2);
    expect(pageSource).toContain("const formatTechnicalDateTime=value=>value?new Intl.DateTimeFormat('pl-PL',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'");
    expect(pageSource).toContain("'Ostatnia aktualizacja: '+formatTechnicalDateTime(item.sourceModifiedAt)");
    expect(pageSource).toContain("'Dane zaktualizowane • Ostatnia aktualizacja: '+formatTechnicalDateTime(updatedAt)");
  });

  it("keeps the reachable legacy case timeline date-only", () => {
    expect(legacyPageSource).toContain("formatDate(event.detectedAt)");
    expect(legacyPageSource).not.toContain("formatDateTime");
    expect(legacyPageSource).not.toMatch(/hour:\s*["']2-digit["']/);
  });
});
