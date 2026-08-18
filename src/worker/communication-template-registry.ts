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
  return normalized;
}
