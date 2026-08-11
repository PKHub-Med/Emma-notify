export const COMMUNICATION_SCENARIOS = {
  REPAIR_RECEIVED: "REPAIR_RECEIVED",
  REPAIR_COMPLETED: "REPAIR_COMPLETED",
  INSPECTION_DATE_PROPOSED: "INSPECTION_DATE_PROPOSED",
  INSPECTION_DATE_CONFIRMED: "INSPECTION_DATE_CONFIRMED",
  INSPECTION_REMINDER: "INSPECTION_REMINDER",
  INSPECTION_COMPLETED: "INSPECTION_COMPLETED",
} as const;

export type CommunicationScenario =
  typeof COMMUNICATION_SCENARIOS[keyof typeof COMMUNICATION_SCENARIOS];

export type CommunicationSourceEntityType = "SERVICE_ORDER" | "TASK";

export const EMMA_COMMUNICATION_CONTRACT = {
  repair: {
    template: "Naprawa-zmiana_stanu",
    receivedState: "Diagnostyka",
    completedState: "Naprawa zakończona",
  },
  inspection: {
    dateProposed: {
      template: "Przegląd-informacja_o_nadchodzącej_wizycie",
      state: "Poinformowano o wizycie",
    },
    dateConfirmed: {
      template: "Przegląd-informacja_o_umówionej_wizycie",
      state: "Ustalono termin wizyty",
    },
    reminder: {
      template: "Przegląd-przypomnienie_o_wizycie",
      state: "Przypomnienie o wizycie",
    },
    completed: {
      template: "Przegląd-podsumowanie_wizyty",
      state: "Zakończono przegląd",
    },
  },
} as const;

export function resolveCommunicationScenario(input: {
  sourceEntityType: CommunicationSourceEntityType;
  emmaCustomerStatus: string | null | undefined;
  emmaMailTemplate: string | null | undefined;
}): CommunicationScenario | null {
  const state = normalizeContractValue(input.emmaCustomerStatus);
  const template = normalizeContractValue(input.emmaMailTemplate);
  if (!state || !template) return null;

  if (input.sourceEntityType === "SERVICE_ORDER") {
    if (template !== EMMA_COMMUNICATION_CONTRACT.repair.template) return null;
    if (state === EMMA_COMMUNICATION_CONTRACT.repair.receivedState) {
      return COMMUNICATION_SCENARIOS.REPAIR_RECEIVED;
    }
    if (state === EMMA_COMMUNICATION_CONTRACT.repair.completedState) {
      return COMMUNICATION_SCENARIOS.REPAIR_COMPLETED;
    }
    return null;
  }

  const inspectionScenarios = [
    [
      EMMA_COMMUNICATION_CONTRACT.inspection.dateProposed,
      COMMUNICATION_SCENARIOS.INSPECTION_DATE_PROPOSED,
    ],
    [
      EMMA_COMMUNICATION_CONTRACT.inspection.dateConfirmed,
      COMMUNICATION_SCENARIOS.INSPECTION_DATE_CONFIRMED,
    ],
    [
      EMMA_COMMUNICATION_CONTRACT.inspection.reminder,
      COMMUNICATION_SCENARIOS.INSPECTION_REMINDER,
    ],
    [
      EMMA_COMMUNICATION_CONTRACT.inspection.completed,
      COMMUNICATION_SCENARIOS.INSPECTION_COMPLETED,
    ],
  ] as const;

  for (const [contract, scenario] of inspectionScenarios) {
    if (state === contract.state && template === contract.template) return scenario;
  }
  return null;
}

function normalizeContractValue(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
