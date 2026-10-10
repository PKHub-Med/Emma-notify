const FIELD_RANGES = [
  { minimum: 0, maximum: 59 },
  { minimum: 0, maximum: 23 },
  { minimum: 1, maximum: 31 },
  { minimum: 1, maximum: 12 },
  { minimum: 0, maximum: 7 },
] as const;

type ParsedCron = {
  fields: ReadonlySet<number>[];
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
};

const cache = new Map<string, ParsedCron>();

export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

export function nextCronOccurrence(
  expression: string,
  atOrAfter: Date,
  timeZone: string,
): Date {
  const cron = parseCronExpression(expression);
  const start = Math.floor(atOrAfter.getTime() / 60_000) * 60_000;
  let candidate = new Date(start < atOrAfter.getTime() ? start + 60_000 : start);
  const searchLimit = candidate.getTime() + 366 * 5 * 24 * 60 * 60_000;

  while (candidate.getTime() <= searchLimit) {
    if (matches(cron, zonedParts(candidate, timeZone))) return candidate;
    candidate = new Date(candidate.getTime() + 60_000);
  }

  throw new Error(`Cron expression has no occurrence within five years: ${expression}`);
}

function parseCronExpression(expression: string): ParsedCron {
  const normalized = expression.trim().replace(/\s+/g, " ");
  const cached = cache.get(normalized);
  if (cached) return cached;

  const sourceFields = normalized.split(" ");
  if (sourceFields.length !== FIELD_RANGES.length) {
    throw new Error("Cron expression must contain exactly five fields");
  }

  const fields = sourceFields.map((field, index) => {
    const range = FIELD_RANGES[index]!;
    return parseField(field!, range.minimum, range.maximum, index === 4);
  });
  const parsed = {
    fields,
    dayOfMonthWildcard: sourceFields[2] === "*",
    dayOfWeekWildcard: sourceFields[4] === "*",
  };
  cache.set(normalized, parsed);
  return parsed;
}

function parseField(
  source: string,
  minimum: number,
  maximum: number,
  normalizeSunday: boolean,
): ReadonlySet<number> {
  const values = new Set<number>();
  for (const item of source.split(",")) {
    if (!item) throw new Error("Cron field contains an empty list item");
    const [base, stepSource, extra] = item.split("/");
    if (extra !== undefined || !base) throw new Error(`Invalid cron field: ${source}`);
    const step = stepSource === undefined
      ? 1
      : parseInteger(stepSource, 1, maximum - minimum + 1);
    const [start, end] = base === "*"
      ? [minimum, maximum]
      : parseRange(base, minimum, maximum);
    for (let value = start; value <= end; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }
  if (values.size === 0) throw new Error(`Cron field has no values: ${source}`);
  return values;
}

function parseRange(source: string, minimum: number, maximum: number): [number, number] {
  const parts = source.split("-");
  if (parts.length === 1) {
    const value = parseInteger(parts[0]!, minimum, maximum);
    return [value, value];
  }
  if (parts.length !== 2) throw new Error(`Invalid cron range: ${source}`);
  const start = parseInteger(parts[0]!, minimum, maximum);
  const end = parseInteger(parts[1]!, minimum, maximum);
  if (start > end) throw new Error(`Cron range must be ascending: ${source}`);
  return [start, end];
}

function parseInteger(source: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(source)) throw new Error(`Invalid cron value: ${source}`);
  const value = Number(source);
  if (value < minimum || value > maximum) {
    throw new Error(`Cron value is outside ${minimum}-${maximum}: ${source}`);
  }
  return value;
}

function matches(cron: ParsedCron, parts: ReturnType<typeof zonedParts>): boolean {
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = cron.fields;
  if (!minutes!.has(parts.minute) || !hours!.has(parts.hour) ||
      !months!.has(parts.month)) return false;

  const dayOfMonthMatches = daysOfMonth!.has(parts.day);
  const dayOfWeekMatches = daysOfWeek!.has(parts.dayOfWeek);
  return cron.dayOfMonthWildcard
    ? dayOfWeekMatches
    : cron.dayOfWeekWildcard
      ? dayOfMonthMatches
      : dayOfMonthMatches || dayOfWeekMatches;
}

function zonedParts(instant: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const dayOfWeek = new Date(Date.UTC(values.year!, values.month! - 1, values.day!))
    .getUTCDay();
  return {
    month: values.month!, day: values.day!, hour: values.hour!,
    minute: values.minute!, dayOfWeek,
  };
}
