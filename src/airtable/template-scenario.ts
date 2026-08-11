export const EMMA_MAIL_SCENARIOS = {
  REPAIR_STATUS_CHANGE: "REPAIR_STATUS_CHANGE",
  INSPECTION_DATE_PROPOSED: "INSPECTION_DATE_PROPOSED",
  INSPECTION_DATE_CONFIRMED: "INSPECTION_DATE_CONFIRMED",
  INSPECTION_REMINDER: "INSPECTION_REMINDER",
  INSPECTION_COMPLETED: "INSPECTION_COMPLETED",
} as const;

export type EmmaMailScenario =
  typeof EMMA_MAIL_SCENARIOS[keyof typeof EMMA_MAIL_SCENARIOS];

export const EMMA_MAIL_TEMPLATE_MAP = {
  "Naprawa-zmiana_stanu": EMMA_MAIL_SCENARIOS.REPAIR_STATUS_CHANGE,
  "Przegląd-informacja_o_nadchodzącej_wizycie":
    EMMA_MAIL_SCENARIOS.INSPECTION_DATE_PROPOSED,
  "Przegląd-informacja_o_umówionej_wizycie":
    EMMA_MAIL_SCENARIOS.INSPECTION_DATE_CONFIRMED,
  "Przegląd-przypomnienie_o_wizycie": EMMA_MAIL_SCENARIOS.INSPECTION_REMINDER,
  "Przegląd-podsumowanie_wizyty": EMMA_MAIL_SCENARIOS.INSPECTION_COMPLETED,
} as const satisfies Readonly<Record<string, EmmaMailScenario>>;

export function mapEmmaMailTemplate(value: unknown): EmmaMailScenario | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!Object.hasOwn(EMMA_MAIL_TEMPLATE_MAP, key)) return null;
  return EMMA_MAIL_TEMPLATE_MAP[key as keyof typeof EMMA_MAIL_TEMPLATE_MAP];
}
