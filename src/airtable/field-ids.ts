export const AIRTABLE_TABLE_IDS = {
  tasks: "tblHWODYlfsTQ7NB9",
  hospitals: "tbl7kenGjadPvAfFk",
  employees: "tbloCLVsTqG7HrSI2",
  serviceOrders: "tblJSUtmWrc1feldG",
  inspections: "tblPiDXQXcAWKogIk",
  contacts: "tblOAizKjQYDhIzEx",
  devices: "tblnEZZVI2ws2dyx4",
} as const;

export const TASK_FIELDS = {
  sequenceNumber: "fld4gbrsoGZu9ypaG",
  day: "fldAImlfkzvwvBWM3",
  plannedDay: "fld90rJaXlfO9uF20",
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
  sourceHospitalLink: "fldDQYxpMRt6xaHCE",
} as const;

export const EMPLOYEE_FIELDS = {
  name: "fldCfUljvDxoyKWX1",
  email: "fld0xDzhFfgViUwo3",
  businessPhone: "fldhdaEbQTNF4QFiU",
  photo: "fldwS6s82oI4xHMFW",
} as const;

export const HOSPITAL_FIELDS = {
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
} as const;

export const SERVICE_ORDER_FIELDS = {
  reportedAt: "fld2QkVQLirhVDuU6",
  businessNumber: "fldvxV5Kvva5i1BJN",
  clientOrderNumber: "fldd7gJIpGiIz8jof",
  caseSubtype: "fldZUjAkbnVhSIfrV",
  serviceOrderType: "fldZUjAkbnVhSIfrV",
  caseLocation: "fldhUvutWPKBEPA2D",
  hospitalName: "fldmnLS1Jga5UaHG9",
  deviceName: "fldiFTzPo3PVFnqbc",
  deviceLink: "fldryoc5TRbntdMvj",
  manufacturer: "fldphUP9UYDCqmaCa",
  model: "fld69S0QDY7oK8BsA",
  serialNumber: "fldGWu215LqWbr60f",
  inventoryNumber: "fld7OR6obSjRXgrrx",
  faultDescription: "fldLup2XatqzfVk0T",
  contactLinks: "fldv7yrcmRzlfnoqQ",
  sourceModifiedAt: "fldNWAcmc0wkX2M9M",
  // Legacy "Stan dla klienta" used by the current production worker.
  customerStatus: "fldN0dGXaGv40EHsk",
  emmaCustomerStatus: "fldOi8KDzJ1zwMaWJ",
  emmaMailTemplate: "fldfqDFr9bJ4DiMRe",
  sourceHospitalLink: "fldXGnsGh3ok8WlMe",
} as const;

// Attachment fields are intentionally separate from SERVICE_ORDER_FIELD_IDS.
// They are fetched only by the communication-asset resolver, never by normal sync.
export const SERVICE_ORDER_ATTACHMENT_FIELDS = {
  repairProtocol: "fldbh4MX5xR5zvHdg",
  diagnosticProtocol: "fldYCKAp6TIRoa6RD",
} as const;

export const INSPECTION_FIELDS = {
  businessNumber: "fldKnHp3xigYDqo5U",
  clientOrderNumber: "fldfrwgpvohaKMlmR",
  deviceName: "fldjX0JMYJU17rzIK",
  manufacturer: "fldEcYNNn3UUJ68kp",
  model: "fldDdrXczXp29ISg8",
  inventoryNumber: "fld54a3DwJEtHRfVL",
  serialNumber: "fld5izxI0CGIskOil",
  currentStatus: "fldujTCuvNlwLQSXO",
  contactLinks: "fldSVf3CXUkpmlyme",
  deviceLink: "fldgk1YS1CIW6aWfv",
  hospitalName: "fldPyeqrgpeKrHuhv",
  dueDate: "fldNMzupWUaEKzn7u",
  sourceModifiedAt: "fldd2z5eJg2GsHLgD",
  bookingStatus: "fldZnO530QNvWM4I8",
  scheduledDate: "fldsN3Yu1qFao8B87",
} as const;

export const CONTACT_FIELDS = {
  name: "fldzSBlMWlx9yOqUJ",
  contactable: "fld0eUVo2LBPjaMXo",
  email: "fld6IwoRq2X6KSVQk",
  sourceModifiedAt: "fld69FjUyAHgmVTAF",
} as const;

export const SERVICE_ORDER_FIELD_IDS = uniqueFieldIds(SERVICE_ORDER_FIELDS);
export const INSPECTION_FIELD_IDS = Object.values(INSPECTION_FIELDS);
export const CONTACT_FIELD_IDS = Object.values(CONTACT_FIELDS);
export const TASK_FIELD_IDS = Object.values(TASK_FIELDS);
export const EMPLOYEE_FIELD_IDS = Object.values(EMPLOYEE_FIELDS);
export const HOSPITAL_FIELD_IDS = Object.values(HOSPITAL_FIELDS);

function uniqueFieldIds(fields: Record<string, string>): string[] {
  return [...new Set(Object.values(fields))];
}
