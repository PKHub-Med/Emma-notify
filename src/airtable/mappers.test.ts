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
      [SERVICE_ORDER_FIELDS.emmaCustomerStatus]: "Naprawa rozpoczęta",
      [SERVICE_ORDER_FIELDS.emmaMailTemplate]: "Naprawa-zmiana_stanu",
      [SERVICE_ORDER_FIELDS.serviceOrderType]: "NAPRAWA",
      [SERVICE_ORDER_FIELDS.sourceHospitalLink]: ["recHospital", "recIgnored"],
      [SERVICE_ORDER_FIELDS.faultDescription]: "Usterka",
      [SERVICE_ORDER_FIELDS.sourceModifiedAt]: "2026-08-08T10:00:00.000Z",
      [SERVICE_ORDER_FIELDS.reportedAt]: "2026-08-02T07:30:00.000Z",
    }));

    expect(mapped).toMatchObject({
      caseType: CaseType.SERVICE_ORDER,
      airtableRecordId: "recService",
      businessNumber: "42",
      clientOrderNumber: "CLIENT-7",
      hospitalName: "Hospital",
      deviceAirtableId: "recDevice",
      currentStatus: "W naprawie",
      emmaCustomerStatus: "Naprawa rozpoczęta",
      emmaMailTemplate: "Naprawa-zmiana_stanu",
      serviceOrderType: "NAPRAWA",
      faultDescription: "Usterka",
      contactRecordIds: ["recContactA", "recContactB"],
      sourceHospitalRecordId: "recHospital",
    });
    expect(mapped.sourceSnapshot).not.toHaveProperty("contactRecordIds");
    expect(mapped.reportedAt?.toISOString()).toBe("2026-08-02T07:30:00.000Z");
  });

  it("does not fall back to source or sync timestamps when reportedAt is absent", () => {
    const mapped = mapServiceOrder(record("recMissingDate", {
      [SERVICE_ORDER_FIELDS.sourceModifiedAt]: "2026-08-08T10:00:00.000Z",
    }));
    expect(mapped.reportedAt).toBeNull();
    expect(mapped.sourceCreatedAt).not.toBeNull();
    expect(mapped.sourceModifiedAt).not.toBeNull();
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
