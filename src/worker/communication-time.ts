export type LocalDate = { year: number; month: number; day: number };

export function parseLocalDate(value: unknown): LocalDate | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value.trim());
  if (!match) return null;
  const date = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const verified = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return verified.getUTCFullYear() === date.year &&
    verified.getUTCMonth() === date.month - 1 &&
    verified.getUTCDate() === date.day ? date : null;
}

export function reminderScheduledFor(
  visitDate: LocalDate,
  timeZone: string,
): Date {
  const previous = new Date(Date.UTC(
    visitDate.year,
    visitDate.month - 1,
    visitDate.day - 1,
  ));
  return localDateTimeToUtc({
    year: previous.getUTCFullYear(),
    month: previous.getUTCMonth() + 1,
    day: previous.getUTCDate(),
    hour: 6,
    minute: 0,
    second: 0,
  }, timeZone);
}

export function localDateAt(instant: Date, timeZone: string): LocalDate {
  const parts = zonedParts(instant, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

export function compareLocalDates(left: LocalDate, right: LocalDate): number {
  return dateNumber(left) - dateNumber(right);
}

function localDateTimeToUtc(
  desired: LocalDate & { hour: number; minute: number; second: number },
  timeZone: string,
): Date {
  const desiredAsUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second,
  );
  let candidate = new Date(desiredAsUtc);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = zonedParts(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    candidate = new Date(candidate.getTime() + desiredAsUtc - actualAsUtc);
  }
  return candidate;
}

function zonedParts(instant: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year!, month: values.month!, day: values.day!,
    hour: values.hour!, minute: values.minute!, second: values.second!,
  };
}

function dateNumber(value: LocalDate): number {
  return Date.UTC(value.year, value.month - 1, value.day);
}
