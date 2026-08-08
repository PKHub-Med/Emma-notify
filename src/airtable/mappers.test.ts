import { describe, expect, it } from "vitest";
import { CaseType } from "../generated/prisma/enums.js";
import { INSPECTION_FIELDS, SERVICE_ORDER_FIELDS } from "./field-ids.js";
import { mapInspection, mapServiceOrder } from "./mappers.js";
import type { AirtableRecord } from "./types.js";
import { toBusinessNumber } from "./values.js";

describe("toBusinessNumber", () => {
  it.each([
    [1234, "1234"],
    [" SO-12 ", "SO-12"],
    [null, null],
  ])("converts %s safely", (input, expected) => {
    expect(toBusinessNumber(input)).toBe(expected);
  });
});

describe("case mappers", () => {
  it("maps a service order using customer-facing status and record IDs", () => {
    const mapped = mapServiceOrder(record("recService", {
      [SERVICE_ORDER_FIELDS.businessNumber]: 42,
      [SERVICE_ORDER_FIELDS.clientOrderNumber]: "CLIENT-7",
      [SERVICE_ORDER_FIELDS.hospitalName]: ["Hospital"],
      [SERVICE_ORDER_FIELDS.deviceLink]: ["recDevice"],
      [SERVICE_ORDER_FIELDS.contactLinks]: ["recContactA", "recContactB"],
      [SERVICE_ORDER_FIELDS.customerStatus]: "W naprawie",
      [SERVICE_ORDER_FIELDS.faultDescription]: "Usterka",
      [SERVICE_ORDER_FIELDS.sourceModifiedAt]: "2026-08-08T10:00:00.000Z",
    }));

    expect(mapped).toMatchObject({
      caseType: CaseType.SERVICE_ORDER,
      airtableRecordId: "recService",
      businessNumber: "42",
      clientOrderNumber: "CLIENT-7",
      hospitalName: "Hospital",
      deviceAirtableId: "recDevice",
      currentStatus: "W naprawie",
      faultDescription: "Usterka",
      contactRecordIds: ["recContactA", "recContactB"],
    });
    expect(mapped.sourceSnapshot).not.toHaveProperty("contactRecordIds");
  });

  it("maps an inspection and preserves an invalid due date", () => {
    const mapped = mapInspection(record("recInspection", {
      [INSPECTION_FIELDS.businessNumber]: "17",
      [INSPECTION_FIELDS.currentStatus]: "Zaplanowany",
      [INSPECTION_FIELDS.deviceLink]: ["recDevice"],
      [INSPECTION_FIELDS.contactLinks]: ["recContact"],
      [INSPECTION_FIELDS.dueDate]: "#ERROR!",
      [INSPECTION_FIELDS.bookingStatus]: [" Nowe ", "", "Potwierdzone"],
      [INSPECTION_FIELDS.scheduledDate]: "2026-09-01T09:00:00.000Z",
    }));

    expect(mapped).toMatchObject({
      caseType: CaseType.INSPECTION,
      airtableRecordId: "recInspection",
      currentStatus: "Zaplanowany",
      inspectionDueDate: null,
      inspectionDueDateRaw: "#ERROR!",
      inspectionBookingStatus: "Nowe, Potwierdzone",
      invalidDueDate: true,
    });
    expect(mapped.inspectionScheduledDate?.toISOString()).toBe(
      "2026-09-01T09:00:00.000Z",
    );
  });
});

function record(id: string, fields: Record<string, unknown>): AirtableRecord {
  return {
    id,
    createdTime: "2026-08-01T08:00:00.000Z",
    fields,
  };
}
