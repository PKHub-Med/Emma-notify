export function toOptionalString(value: unknown): string | null {
  const values = toStringValues(value);
  return values.length > 0 ? values.join(", ") : null;
}

export function toBusinessNumber(value: unknown): string | null {
  return toOptionalString(value);
}

export function toLinkedRecordIds(value: unknown): string[] {
  return [...new Set(toStringValues(value).filter((item) => item.startsWith("rec")))];
}

export function toFirstLinkedRecordId(value: unknown): string | null {
  return toLinkedRecordIds(value)[0] ?? null;
}

export function parseAirtableDate(value: unknown): Date | null {
  const raw = toOptionalString(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(raw)) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toStringValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(toStringValues);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
  return [];
}
