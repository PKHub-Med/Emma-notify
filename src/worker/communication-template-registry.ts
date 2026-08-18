import {
  CommunicationScenario,
} from "../generated/prisma/enums.js";
import type { TemplateVariableValue } from "../email/resend-client.js";

export const COMMUNICATION_TEMPLATE_ALIASES: Readonly<
  Record<CommunicationScenario, string>
> = Object.freeze({
  [CommunicationScenario.REPAIR_RECEIVED]: "emma-repair-received",
  [CommunicationScenario.REPAIR_COMPLETED]: "emma-repair-completed",
  [CommunicationScenario.INSPECTION_DATE_CONFIRMED]: "emma-inspection-confirmed",
  [CommunicationScenario.INSPECTION_DATE_PROPOSED]: "emma-inspection-proposed",
  [CommunicationScenario.INSPECTION_REMINDER]: "emma-inspection-reminder",
  [CommunicationScenario.INSPECTION_COMPLETED]: "emma-inspection-summary",
});

export function templateAliasForScenario(scenario: CommunicationScenario): string {
  return COMMUNICATION_TEMPLATE_ALIASES[scenario];
}

export const TEMPLATE_STRING_VALUE_MAX_LENGTH = 2_000;
export const REPAIR_ROW_SLOT_COUNT = 20;
export const INSPECTION_ROW_SLOT_COUNT = 39;

export function templateRowSlotKey(prefix: string, index: number): string {
  return `${prefix}_${String(index + 1).padStart(2, "0")}`;
}

const NUMBER_VARIABLES_BY_TEMPLATE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "emma-repair-received": ["REPAIR_COUNT"],
  "emma-repair-completed": ["REPAIR_COUNT"],
  "emma-inspection-confirmed": ["DEVICE_COUNT"],
  "emma-inspection-proposed": ["DEVICE_COUNT"],
  "emma-inspection-reminder": ["DEVICE_COUNT"],
});

export function normalizeCommunicationTemplateVariables(
  templateId: string,
  variables: Record<string, TemplateVariableValue>,
): Record<string, TemplateVariableValue> {
  const normalized = { ...variables };
  migrateLegacyRowVariables(templateId, normalized);

  for (const key of NUMBER_VARIABLES_BY_TEMPLATE[templateId] ?? []) {
    const raw = normalized[key];
    const value = typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim().length > 0
        ? Number(raw)
        : Number.NaN;
    if (!Number.isFinite(value)) throw new Error(`Invalid ${key}`);
    normalized[key] = value;
  }

  for (const [key, value] of Object.entries(normalized)) {
    if (typeof value === "string" && value.length > TEMPLATE_STRING_VALUE_MAX_LENGTH) {
      throw new Error(`Template variable ${key} exceeds ${TEMPLATE_STRING_VALUE_MAX_LENGTH} characters`);
    }
  }

  return normalized;
}

type RowSlotConfig = { legacyKey: string; prefix: string; count: number };

const ROW_SLOTS_BY_TEMPLATE: Readonly<Record<string, RowSlotConfig>> = Object.freeze({
  "emma-repair-received": { legacyKey: "REPAIRS_ROWS", prefix: "REPAIR_ROW", count: REPAIR_ROW_SLOT_COUNT },
  "emma-repair-completed": { legacyKey: "REPAIRS_ROWS", prefix: "REPAIR_ROW", count: REPAIR_ROW_SLOT_COUNT },
  "emma-inspection-confirmed": { legacyKey: "DEVICES_ROWS", prefix: "DEVICE_ROW", count: INSPECTION_ROW_SLOT_COUNT },
  "emma-inspection-proposed": { legacyKey: "DEVICES_ROWS", prefix: "DEVICE_ROW", count: INSPECTION_ROW_SLOT_COUNT },
  "emma-inspection-reminder": { legacyKey: "DEVICES_ROWS", prefix: "DEVICE_ROW", count: INSPECTION_ROW_SLOT_COUNT },
  "emma-inspection-summary": { legacyKey: "RESULT_ROWS", prefix: "RESULT_ROW", count: INSPECTION_ROW_SLOT_COUNT },
});

function migrateLegacyRowVariables(
  templateId: string,
  variables: Record<string, TemplateVariableValue>,
): void {
  const config = ROW_SLOTS_BY_TEMPLATE[templateId];
  if (!config) return;

  const hasSlots = Array.from({ length: config.count }, (_, index) =>
    templateRowSlotKey(config.prefix, index)).some((key) => key in variables);

  let rows: string[] = [];
  const legacy = variables[config.legacyKey];
  if (!hasSlots && typeof legacy === "string" && legacy.length > 0) {
    rows = legacy.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [legacy];
  }
  delete variables[config.legacyKey];

  if (rows.length > config.count) {
    throw new Error(`Too many template rows for ${templateId}`);
  }

  for (let index = 0; index < config.count; index += 1) {
    const key = templateRowSlotKey(config.prefix, index);
    if (!(key in variables)) variables[key] = rows[index] ?? "";
  }
}
