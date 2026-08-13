import { describe, expect, it, vi } from "vitest";
import { CaseType } from "../generated/prisma/enums.js";
import type { MappedCase } from "../airtable/mappers.js";
import type { MappedTask } from "../airtable/task.js";
import {
  buildServiceOrderObservation,
  buildTaskObservation,
  observeCommunication,
  type CommunicationEventStore,
} from "./communication-event.js";

describe("communication event diagnostics and snapshots", () => {
  it("logs an unknown non-empty pair without snapshot or personal data", async () => {
    const log = vi.fn();
    const observation = buildTaskObservation({
      ...mappedTask(),
      emmaCustomerStatus: "Nieznany stan",
      emmaMailTemplate: "Nieznany-template",
    }, detectedAt);

    await observeCommunication({
      store: staticStore("NO_SCENARIO"),
      observation,
      allowEvent: true,
      detectedAt,
      log,
    });

    expect(log).toHaveBeenCalledWith(
      "COMMUNICATION_SCENARIO_UNKNOWN sourceEntityType=TASK sourceRecordId=recTask",
    );
    expect(log.mock.calls[0]?.[0]).not.toContain("recContact");
  });

  it("does not diagnose blank state/template as an error", async () => {
    const log = vi.fn();
    const observation = buildTaskObservation({
      ...mappedTask(),
      emmaCustomerStatus: null,
      emmaMailTemplate: null,
    }, detectedAt);

    await observeCommunication({
      store: staticStore("NO_SCENARIO"),
      observation,
      allowEvent: true,
      detectedAt,
      log,
    });

    expect(log).not.toHaveBeenCalled();
  });

  it("builds the required service-order event snapshot", () => {
    const observation = buildServiceOrderObservation(mappedServiceOrder(), detectedAt);

    expect(observation.eventSnapshot).toMatchObject({
      sourceEntityType: "SERVICE_ORDER",
      sourceRecordId: "recService",
      scenario: "REPAIR_RECEIVED",
      emmaCustomerStatus: "Diagnostyka",
      emmaMailTemplate: "Naprawa-zmiana_stanu",
      businessNumber: "SO-12",
      clientOrderNumber: "CLIENT-7",
      serviceOrderType: "NAPRAWA",
      hospitalName: "Szpital Testowy",
      sourceHospitalRecordId: "recHospital",
      contactRecordIds: ["recContact"],
      device: {
        airtableRecordId: "recDevice",
        serialNumber: "SN-1",
      },
      detectedAt: detectedAt.toISOString(),
    });
  });

  it("builds the required task event snapshot without resolving emails", () => {
    const observation = buildTaskObservation(mappedTask(), detectedAt);

    expect(observation.eventSnapshot).toMatchObject({
      sourceEntityType: "TASK",
      sourceRecordId: "recTask",
      taskNumber: "12",
      scenario: "INSPECTION_DATE_CONFIRMED",
      day: "2026-09-10",
      selectedContactRecordIds: ["recContactA", "recContactB"],
      linkedInspectionRecordIds: ["recInspectionA"],
      linkedServiceOrderRecordIds: ["recService"],
      performerRecordIds: ["recEmployee"],
      sourceHospitalRecordId: "recHospital",
      detectedAt: detectedAt.toISOString(),
    });
    expect(observation.eventSnapshot).not.toHaveProperty("email");
  });
});

const detectedAt = new Date("2026-08-12T10:00:00.000Z");

function staticStore(
  outcome: "NO_SCENARIO" | "UNCHANGED",
): CommunicationEventStore {
  return {
    async isBaselineCompleted() {
      return true;
    },
    async markBaselineCompleted() {},
    async observe() {
      return { outcome, revision: 0 };
    },
  };
}

function mappedTask(): MappedTask {
  return {
    airtableRecordId: "recTask",
    taskNumber: "12",
    day: "2026-09-10",
    activity: "Potwierdzenie terminu",
    performerRecordIds: ["recEmployee"],
    completed: false,
    status: "Zaplanowane",
    linkedServiceOrderRecordIds: ["recService"],
    linkedInspectionRecordIds: ["recInspectionA"],
    selectedContactRecordIds: ["recContactA", "recContactB"],
    sourceHospitalRecordId: "recHospital",
    emmaCustomerStatus: "Ustalono termin wizyty",
    emmaMailTemplate: "Przegląd-informacja_o_umówionej_wizycie",
  };
}

function mappedServiceOrder(): MappedCase {
  return {
    caseType: CaseType.SERVICE_ORDER,
    airtableRecordId: "recService",
    businessNumber: "SO-12",
    clientOrderNumber: "CLIENT-7",
    caseSubtype: "NAPRAWA",
    serviceOrderType: "NAPRAWA",
    emmaCustomerStatus: "Diagnostyka",
    emmaMailTemplate: "Naprawa-zmiana_stanu",
    caseLocation: null,
    hospitalName: "Szpital Testowy",
    sourceHospitalRecordId: "recHospital",
    deviceAirtableId: "recDevice",
    deviceName: "Aparat",
    manufacturer: "Producent",
    model: "Model",
    serialNumber: "SN-1",
    inventoryNumber: "INV-1",
    currentStatus: "Legacy",
    faultDescription: "Usterka",
    sourceCreatedAt: null,
    reportedAt: null,
    sourceModifiedAt: null,
    inspectionDueDate: null,
    inspectionDueDateRaw: null,
    inspectionScheduledDate: null,
    inspectionBookingStatus: null,
    sourceSnapshot: {},
    contactRecordIds: ["recContact"],
    invalidDueDate: false,
  };
}
