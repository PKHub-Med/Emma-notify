import type { EmailMode } from "./recipient.js";

const MAX_TEMPLATE_ITEMS = 5;

export type CaseDigestTemplateItem = {
  trackedCaseId: string;
  lastEventAt: Date | null;
  snapshot: unknown;
};

export type CaseDigestTemplateVariables = Record<string, string>;

export class TemplateMappingError extends Error {
  constructor(readonly code: "DETAIL_URL_NOT_AVAILABLE") {
    super(code);
    this.name = "TemplateMappingError";
  }
}

export function mapCaseDigestTemplate(input: {
  mode: EmailMode;
  itemsCount: number;
  items: readonly CaseDigestTemplateItem[];
  detailUrl: string | null;
}): {
  variables: CaseDigestTemplateVariables;
  itemsShown: number;
  hasMore: boolean;
} {
  const detailUrl = requirePublicDetailUrl(input.detailUrl);
  const sortedItems = [...input.items].sort(compareItems);
  const visibleItems = sortedItems.slice(0, MAX_TEMPLATE_ITEMS);
  const hasMore = input.itemsCount > MAX_TEMPLATE_ITEMS;
  const variables: CaseDigestTemplateVariables = {
    TEST_DISPLAY: input.mode === "TEST" ? "table-row" : "none",
    ENVIRONMENT_LABEL: input.mode === "TEST" ? "TRYB TESTOWY" : "",
    ENVIRONMENT_NOTE: input.mode === "TEST"
      ? "Wiadomość nie została wysłana do klienta."
      : "",
    TITLE: input.itemsCount === 1
      ? "Aktualizacja dotycząca urządzenia"
      : "Aktualizacje dotyczące urządzeń",
    INTRO: input.itemsCount === 1
      ? "Poniżej znajdziesz najnowszą informację dotyczącą Twojego urządzenia."
      : "Poniżej znajdziesz najnowsze informacje dotyczące Twoich urządzeń.",
    MORE_DISPLAY: hasMore ? "block" : "none",
    MORE_TEXT: hasMore ? formatMoreText(input.itemsCount - MAX_TEMPLATE_ITEMS) : "",
    LAST_UPDATED: formatLastUpdated(sortedItems[0]?.lastEventAt ?? null),
    DETAIL_URL: detailUrl,
    FOOTER_TEXT: "Pełne informacje są dostępne po otwarciu bezpiecznego linku.",
  };

  for (let slot = 1; slot <= MAX_TEMPLATE_ITEMS; slot += 1) {
    const item = visibleItems[slot - 1];
    const snapshot = asRecord(item?.snapshot);
    variables[`ROW_${slot}_DISPLAY`] = item ? "table-row" : "none";
    variables[`DEVICE_${slot}_NAME`] = item
      ? readDeviceName(snapshot)
      : "";
    variables[`DEVICE_${slot}_META`] = item
      ? readDeviceMeta(snapshot)
      : "";
    variables[`DEVICE_${slot}_STATUS`] = item
      ? readString(snapshot, "currentStatus") ?? ""
      : "";
  }

  return { variables, itemsShown: visibleItems.length, hasMore };
}

function formatMoreText(count: number): string {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;
  const usesNominativePlural = lastDigit >= 2 && lastDigit <= 4 &&
    !(lastTwoDigits >= 12 && lastTwoDigits <= 14);
  return usesNominativePlural
    ? `+ ${count} kolejne aktualizacje`
    : `+ ${count} kolejnych aktualizacji`;
}

function compareItems(left: CaseDigestTemplateItem, right: CaseDigestTemplateItem): number {
  const timestampDifference = (right.lastEventAt?.getTime() ?? -Infinity) -
    (left.lastEventAt?.getTime() ?? -Infinity);
  if (timestampDifference !== 0) return timestampDifference;
  if (left.trackedCaseId < right.trackedCaseId) return -1;
  if (left.trackedCaseId > right.trackedCaseId) return 1;
  return 0;
}

function readDeviceName(snapshot: Record<string, unknown>): string {
  return readString(asRecord(snapshot.device), "name") ?? "Urządzenie medyczne";
}

function readDeviceMeta(snapshot: Record<string, unknown>): string {
  const businessNumber = readString(snapshot, "businessNumber");
  if (!businessNumber) return "";
  return snapshot.caseType === "INSPECTION"
    ? `Przegląd ${businessNumber}`
    : `Zlecenie ${businessNumber}`;
}

function formatLastUpdated(value: Date | null): string {
  if (!value || Number.isNaN(value.getTime())) return "";
  return new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Warsaw",
  }).format(value);
}

function requirePublicDetailUrl(value: string | null): string {
  if (!value) throw new TemplateMappingError("DETAIL_URL_NOT_AVAILABLE");
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const disallowedHostname = hostname === "localhost" ||
      hostname === "example.com" || hostname.endsWith(".example.com") ||
      hostname.endsWith(".local");
    if (url.protocol !== "https:" || url.username || url.password ||
        disallowedHostname) {
      throw new Error("not public");
    }
    return url.toString();
  } catch {
    throw new TemplateMappingError("DETAIL_URL_NOT_AVAILABLE");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}
