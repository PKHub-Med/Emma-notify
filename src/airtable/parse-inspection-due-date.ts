export function parseInspectionDueDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dayFirst = /^(\d{2})[-.](\d{2})[-.](\d{4})$/.exec(trimmed);
  if (dayFirst) {
    return createUtcDate(
      Number(dayFirst[3]),
      Number(dayFirst[2]),
      Number(dayFirst[1]),
    );
  }

  const yearFirst = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (yearFirst) {
    return createUtcDate(
      Number(yearFirst[1]),
      Number(yearFirst[2]),
      Number(yearFirst[3]),
    );
  }

  return null;
}

function createUtcDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}
