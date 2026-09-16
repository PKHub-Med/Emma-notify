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
      [SERVICE_ORDER_FIELDS.completedAt]: "2026-08-07T14:45:00.000Z",
    }));

    expect(mapped).toMatchObject({
      caseType: CaseType.SERVICE_ORDER,
      airtableRecordId: "recService",
      businessNumber: "42",
      clientOrderNumber: "CLIENT-7",
      hospitalName: "Hospital",
      deviceAirtableIds: ["recDevice"],
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
    expect(mapped.completedAt?.toISOString()).toBe("2026-08-07T14:45:00.000Z");
    expect(mapped.sourceSnapshot.reportedAtRaw).toBe("2026-08-02T07:30:00.000Z");
    expect(mapped.sourceSnapshot.completedAt).toBe("2026-08-07T14:45:00.000Z");
  });

  it("does not fall back to source or sync timestamps when reportedAt is absent", () => {
    const mapped = mapServiceOrder(record("recMissingDate", {
      [SERVICE_ORDER_FIELDS.sourceModifiedAt]: "2026-08-08T10:00:00.000Z",
    }));
    expect(mapped.reportedAt).toBeNull();
    expect(mapped.sourceCreatedAt).not.toBeNull();
    expect(mapped.sourceModifiedAt).not.toBeNull();
  });

  it("maps a missing service-order completion date to null", () => {
    expect(mapServiceOrder(record("recNotCompleted", {})).completedAt).toBeNull();
  });

  it.each([
    [undefined, []],
    [["recOnly"], ["recOnly"]],
  ])("maps ServiceOrder Device links as 0..N (%j)", (input, expected) => {
    const mapped = mapServiceOrder(record("recServiceLinks", {
      [SERVICE_ORDER_FIELDS.deviceLink]: input,
    }));
    expect(mapped.deviceAirtableIds).toEqual(expected);
  });

  it("maps an inspection and preserves an invalid due date", () => {
    const mapped = mapInspection(record("recInspection", {
      [INSPECTION_FIELDS.businessNumber]: "17",
      [INSPECTION_FIELDS.emmaStatus]: "Zaplanowany",
      [INSPECTION_FIELDS.deviceLink]: ["recDevice"],
      [INSPECTION_FIELDS.contactLinks]: ["recContact"],
      [INSPECTION_FIELDS.dueDate]: "#ERROR!",
      [INSPECTION_FIELDS.bookingStatus]: [" Nowe ", "", "Potwierdzone"],
      [INSPECTION_FIELDS.scheduledDate]: "2026-09-01T09:00:00.000Z",
      [INSPECTION_FIELDS.performedAt]: "2026-08-31",
      [INSPECTION_FIELDS.result]: "SPRAWNY",
      [INSPECTION_FIELDS.estimatedDuration]: "720",
    }));

    expect(mapped).toMatchObject({
      caseType: CaseType.INSPECTION,
      airtableRecordId: "recInspection",
      currentStatus: "Zaplanowany",
      inspectionDueDate: null,
      inspectionDueDateRaw: "#ERROR!",
      inspectionBookingStatus: "Nowe, Potwierdzone",
      invalidDueDate: true,
      inspectionResult: "SPRAWNY",
      sourceSnapshot: { estimatedDurationSeconds: 720 },
    });
    expect(mapped.inspectionScheduledDate?.toISOString()).toBe(
      "2026-09-01T09:00:00.000Z",
    );
    expect(mapped.inspectionPerformedAt?.toISOString()).toBe(
      "2026-08-31T00:00:00.000Z",
    );
  });

  it("does not invent an inspection performed date or validity fallback", () => {
    const mapped = mapInspection(record("recNoPerformedDate", {
      [INSPECTION_FIELDS.sourceModifiedAt]: "2026-08-31T10:00:00.000Z",
    }));
    expect(mapped.inspectionPerformedAt).toBeNull();
    expect(mapped.inspectionValidUntil).toBeNull();
    expect(mapped.inspectionResult).toBeNull();
  });

  it("always maps inspection completedAt to null", () => {
    expect(mapInspection(record("recInspection", {})).completedAt).toBeNull();
  });

  it("ignores DATA PRZEGLĄDU when DATA WYKONANIA PRZEGLĄDU is empty", () => {
    const mapped = mapInspection(record("recZSwJTzztiigVv1", {
      fld3knASxSRaBdDVt: "2026-08-04",
      [INSPECTION_FIELDS.emmaStatus]: "DO REALIZACJI",
    }));

    expect(mapped.inspectionPerformedAt).toBeNull();
  });

  it("maps DATA WYKONANIA PRZEGLĄDU independently from DATA PRZEGLĄDU", () => {
    const mapped = mapInspection(record("recPerformed", {
      fld3knASxSRaBdDVt: "2026-08-04",
      [INSPECTION_FIELDS.performedAt]: "2026-08-05",
    }));

    expect(mapped.inspectionPerformedAt?.toISOString()).toBe(
      "2026-08-05T00:00:00.000Z",
    );
  });

  it("stores Airtable-provided V5 status, copy and validation without deriving them", () => {
    const mapped = mapInspection(record("recV5", {
      [INSPECTION_FIELDS.adminStatus]: "UMÓWIONE",
      [INSPECTION_FIELDS.emmaStatus]: "W TRAKCIE REALIZACJI",
      [INSPECTION_FIELDS.heroLabel]: "WIZYTA UMÓWIONA",
      [INSPECTION_FIELDS.heroDescription]: "Serwisant przyjedzie w ustalonym terminie.",
      [INSPECTION_FIELDS.headerDateType]: "Zaktualizowano",
      [INSPECTION_FIELDS.headerDate]: "2026-09-10T12:22:00.000Z",
      [INSPECTION_FIELDS.validation]: "OK",
      [INSPECTION_FIELDS.emmaValidUntil]: "2027-09-10",
      [INSPECTION_FIELDS.notes]: "Uwagi z rekordu",
      [INSPECTION_FIELDS.relatedRepairNumber]: 24872,
      [INSPECTION_FIELDS.deviceTagged]: "TAK",
      [INSPECTION_FIELDS.epc]: "EPC-123",
    }));

    expect(mapped).toMatchObject({
      currentStatus: "W TRAKCIE REALIZACJI",
      inspectionAdminStatus: "UMÓWIONE",
      inspectionHeroLabel: "WIZYTA UMÓWIONA",
      inspectionHeaderDateType: "Zaktualizowano",
      inspectionValidation: "OK",
      inspectionNotes: "Uwagi z rekordu",
      relatedRepairNumber: "24872",
      inspectionDeviceTagged: "TAK",
      inspectionDeviceEpc: "EPC-123",
    });
    expect(mapped.inspectionValidUntil?.toISOString()).toBe("2027-09-10T00:00:00.000Z");
  });

  it("keeps STAN and Dopuszczenie do uzytku as separate values", () => {
    const mapped = mapInspection(record("recResultVsAdmission", {
      [INSPECTION_FIELDS.result]: "WARUNKOWO DOPUSZCZONY",
      [INSPECTION_FIELDS.admission]: "DOPUSZCZONO DO UZYTKU Z OGRANICZENIAMI",
    }));

    expect(mapped.inspectionResult).toBe("WARUNKOWO DOPUSZCZONY");
    expect(mapped.inspectionAdmission).toBe("DOPUSZCZONO DO UZYTKU Z OGRANICZENIAMI");
  });

  it.each(["ZF", "UMÓWIONE"])(
    "never exposes Stan Admin %s as the customer-facing status",
    (adminStatus) => {
      const mapped = mapInspection(record("recMissingEmmaStatus", {
        [INSPECTION_FIELDS.emmaStatus]: "",
        [INSPECTION_FIELDS.adminStatus]: adminStatus,
        [INSPECTION_FIELDS.validation]: "OK",
      }));

      expect(mapped.currentStatus).toBeNull();
      expect(mapped.inspectionAdminStatus).toBe(adminStatus);
    },
  );

  it.each([
    [1800, 1800], [3600, 3600], [5400, 5400], ["1200", 1200],
    [undefined, null], [null, null], ["", null], ["abc", null],
  ])("maps estimated duration safely from %j", (input, expected) => {
    const mapped = mapInspection(record("recDuration", {
      [INSPECTION_FIELDS.estimatedDuration]: input,
    }));
    expect(mapped.sourceSnapshot.estimatedDurationSeconds).toBe(expected);
  });

  it("preserves every linked Device ID without silently truncating", () => {
    const mapped = mapInspection(record("recMulti", {
      [INSPECTION_FIELDS.deviceLink]: ["recA", "recB", "recC", "recB"],
    }));
    expect(mapped.deviceAirtableIds).toEqual(["recA", "recB", "recC"]);
  });
});

function record(id: string, fields: Record<string, unknown>): AirtableRecord {
  return {
    id,
    createdTime: "2026-08-01T08:00:00.000Z",
    fields,
  };
}
