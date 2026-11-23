import { normalizeEmail } from "../shared/normalize-email.js";

/**
 * Department ("Oddział") identity taken from the Oddziały table.
 *
 * In the "Emma neu" base the link to Oddziały arrives from the source base as
 * plain text, CSV-style: names that contain commas are wrapped in quotes, e.g.
 * `"Oddział Anestezjologii, Intensywnej Terapii i Leczenia Bólu"`. Several
 * linked departments are joined with ", ". A record is scoped to a department
 * only when exactly one department is linked.
 */
export function parseDepartmentUnits(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").join(", ")
    : typeof value === "string" ? value : "";
  const names: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "\"") {
      if (quoted && raw[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      names.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  names.push(current);
  return [...new Set(names.map((name) => name.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

/** Display name of the single linked department, or null when none/ambiguous. */
export function singleDepartmentUnit(value: unknown): string | null {
  const names = parseDepartmentUnits(value);
  return names.length === 1 ? names[0]! : null;
}

/** Stable comparison key: whitespace-collapsed, case-insensitive. */
export function departmentUnitKey(name: string | null | undefined): string | null {
  const normalized = name?.replace(/\s+/g, " ").trim().toLocaleLowerCase("pl-PL");
  return normalized ? normalized : null;
}

/** Normalized e-mail addresses from a text, lookup or formula value. */
export function emailList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values
    .filter((item): item is string => typeof item === "string")
    .flatMap((item) => item.split(/[,;\s]+/))
    .map((item) => normalizeEmail(item))
    .filter((item) => item.includes("@")))];
}
