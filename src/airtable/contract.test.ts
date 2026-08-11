import { describe, expect, it } from "vitest";
import {
  AIRTABLE_TABLE_IDS,
  EMPLOYEE_FIELDS,
  HOSPITAL_FIELDS,
  SERVICE_ORDER_FIELDS,
  TASK_FIELDS,
} from "./field-ids.js";

describe("central Airtable contract", () => {
  it("contains all seven table IDs", () => {
    expect(AIRTABLE_TABLE_IDS).toEqual({
      tasks: "tblHWODYlfsTQ7NB9",
      hospitals: "tbl7kenGjadPvAfFk",
      employees: "tbloCLVsTqG7HrSI2",
      serviceOrders: "tblJSUtmWrc1feldG",
      inspections: "tblPiDXQXcAWKogIk",
      contacts: "tblOAizKjQYDhIzEx",
      devices: "tblnEZZVI2ws2dyx4",
    });
  });

  it("contains the confirmed task Field IDs", () => {
    expect(TASK_FIELDS).toEqual({
      sequenceNumber: "fld4gbrsoGZu9ypaG",
      day: "fldAImlfkzvwvBWM3",
      activity: "fld9RzXBJhbtuByps",
      assigneeLinks: "fldycuqcSGGjlRrNn",
      completed: "fldoDQQssvNrgpghY",
      status: "fldf9YgAt4q2MfJaL",
      serviceOrderLinks: "fldAxDKX1dJEUygTx",
      inspectionLinks: "flde1xjYgUXSSpHCu",
      contactLinks: "fld3jpkvIZrCAQVbR",
      selectedContactLinks: "fldCfGEH3o4QnieTs",
      selectedContactEmailLookup: "fld86wH67E8Hpl5au",
      emmaCustomerStatus: "fldiTY6M5rQLoOFvd",
      emmaMailTemplate: "fldgGORaQ08utJddW",
    });
  });

  it("contains the confirmed employee Field IDs", () => {
    expect(EMPLOYEE_FIELDS).toEqual({
      name: "fldCfUljvDxoyKWX1",
      email: "fld0xDzhFfgViUwo3",
      businessPhone: "fldhdaEbQTNF4QFiU",
      photo: "fldwS6s82oI4xHMFW",
    });
  });

  it("keeps the legacy service status and exposes the confirmed EMMA fields", () => {
    expect(SERVICE_ORDER_FIELDS.caseSubtype).toBe("fldZUjAkbnVhSIfrV");
    expect(SERVICE_ORDER_FIELDS.customerStatus).toBe("fldN0dGXaGv40EHsk");
    expect(SERVICE_ORDER_FIELDS.emmaCustomerStatus).toBe("fldOi8KDzJ1zwMaWJ");
    expect(SERVICE_ORDER_FIELDS.emmaMailTemplate).toBe("fldfqDFr9bJ4DiMRe");
  });

  it("contains the confirmed hospital Field IDs", () => {
    expect(HOSPITAL_FIELDS).toEqual({
      shortName: "fld9aOOjHnhDsOuIb",
      name: "fldUmRpewNPAV2Hsg",
      contactPerson: "fldReyFvfPZX7EZ3m",
      phone: "flddtk8KJ1nReHzUS",
      email: "fldLGnabgacNEYm6U",
      inspectionLinks: "fldtL8710IwyekVwz",
      serviceOrderLinks: "fld0VjaaGJAbfKgkS",
      address: "fld5ZQIXlTTIXyDr9",
      contactLinks: "fldNyY3MjrWXUcw7q",
      sourceModifiedAt: "fld8VR6YogRo6aG0f",
    });
  });
});
