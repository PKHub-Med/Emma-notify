import { describe, expect, it } from "vitest";
import {
  COMMUNICATION_SCENARIOS,
  EMMA_COMMUNICATION_CONTRACT,
  resolveCommunicationScenario,
} from "./template-scenario.js";

describe("communication scenario resolver", () => {
  it.each([
    [
      "SERVICE_ORDER",
      EMMA_COMMUNICATION_CONTRACT.repair.receivedState,
      EMMA_COMMUNICATION_CONTRACT.repair.template,
      COMMUNICATION_SCENARIOS.REPAIR_RECEIVED,
    ],
    [
      "SERVICE_ORDER",
      EMMA_COMMUNICATION_CONTRACT.repair.completedState,
      EMMA_COMMUNICATION_CONTRACT.repair.template,
      COMMUNICATION_SCENARIOS.REPAIR_COMPLETED,
    ],
    [
      "TASK",
      EMMA_COMMUNICATION_CONTRACT.inspection.dateProposed.state,
      EMMA_COMMUNICATION_CONTRACT.inspection.dateProposed.template,
      COMMUNICATION_SCENARIOS.INSPECTION_DATE_PROPOSED,
    ],
    [
      "TASK",
      EMMA_COMMUNICATION_CONTRACT.inspection.dateConfirmed.state,
      EMMA_COMMUNICATION_CONTRACT.inspection.dateConfirmed.template,
      COMMUNICATION_SCENARIOS.INSPECTION_DATE_CONFIRMED,
    ],
    [
      "TASK",
      EMMA_COMMUNICATION_CONTRACT.inspection.reminder.state,
      EMMA_COMMUNICATION_CONTRACT.inspection.reminder.template,
      COMMUNICATION_SCENARIOS.INSPECTION_REMINDER,
    ],
    [
      "TASK",
      EMMA_COMMUNICATION_CONTRACT.inspection.completed.state,
      EMMA_COMMUNICATION_CONTRACT.inspection.completed.template,
      COMMUNICATION_SCENARIOS.INSPECTION_COMPLETED,
    ],
  ] as const)("resolves %s / %s", (sourceEntityType, state, template, expected) => {
    expect(resolveCommunicationScenario({
      sourceEntityType,
      emmaCustomerStatus: state,
      emmaMailTemplate: template,
    })).toBe(expected);
  });

  it("returns null for an unknown non-empty pair", () => {
    expect(resolveCommunicationScenario({
      sourceEntityType: "TASK",
      emmaCustomerStatus: "Nieznany stan",
      emmaMailTemplate: "Nieznany-template",
    })).toBeNull();
  });

  it.each(["", "   ", null, undefined])(
    "returns null for blank template %s",
    (emmaMailTemplate) => {
      expect(resolveCommunicationScenario({
        sourceEntityType: "TASK",
        emmaCustomerStatus: "Ustalono termin wizyty",
        emmaMailTemplate,
      })).toBeNull();
    },
  );

  it("does not resolve an inspection pair for a service order", () => {
    expect(resolveCommunicationScenario({
      sourceEntityType: "SERVICE_ORDER",
      emmaCustomerStatus:
        EMMA_COMMUNICATION_CONTRACT.inspection.dateConfirmed.state,
      emmaMailTemplate:
        EMMA_COMMUNICATION_CONTRACT.inspection.dateConfirmed.template,
    })).toBeNull();
  });
});
