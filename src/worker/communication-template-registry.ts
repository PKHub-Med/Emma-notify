import {
  CommunicationScenario,
} from "../generated/prisma/enums.js";

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
