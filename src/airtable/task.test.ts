import { describe, expect, it } from "vitest";
import { TASK_FIELDS } from "./field-ids.js";
import { mapTask } from "./task.js";
import type { AirtableRecord } from "./types.js";

describe("task contract mapper", () => {
  it("maps task data and keeps all linked records as arrays", () => {
    const mapped = mapTask(record({
      [TASK_FIELDS.sequenceNumber]: 17,
      [TASK_FIELDS.day]: "2026-08-12",
      [TASK_FIELDS.activity]: "Przypomnienie",
      [TASK_FIELDS.assigneeLinks]: ["recEmployeeA", "recEmployeeB"],
      [TASK_FIELDS.completed]: false,
      [TASK_FIELDS.status]: "Zaplanowane",
      [TASK_FIELDS.serviceOrderLinks]: ["recServiceA", "recServiceB"],
      [TASK_FIELDS.inspectionLinks]: ["recInspectionA", "recInspectionB"],
      [TASK_FIELDS.selectedContactLinks]: [
        "recContactA",
        "recContactB",
        "recContactA",
      ],
      [TASK_FIELDS.selectedContactEmailLookup]: "ignored@example.com",
      [TASK_FIELDS.sourceHospitalLink]: ["recHospital"],
      [TASK_FIELDS.emmaCustomerStatus]: "Wizyta potwierdzona",
      [TASK_FIELDS.emmaMailTemplate]: "Przegląd-przypomnienie_o_wizycie",
    }));

    expect(mapped).toMatchObject({
      taskNumber: "17",
      performerRecordIds: ["recEmployeeA", "recEmployeeB"],
      linkedServiceOrderRecordIds: ["recServiceA", "recServiceB"],
      linkedInspectionRecordIds: ["recInspectionA", "recInspectionB"],
      selectedContactRecordIds: ["recContactA", "recContactB"],
      sourceHospitalRecordId: "recHospital",
      emmaCustomerStatus: "Wizyta potwierdzona",
      emmaMailTemplate: "Przegląd-przypomnienie_o_wizycie",
    });
    expect(mapped).not.toHaveProperty("selectedContactEmailLookup");
  });
});

function record(fields: Record<string, unknown>): AirtableRecord {
  return {
    id: "recTask",
    createdTime: "2026-08-11T08:00:00.000Z",
    fields,
  };
}
