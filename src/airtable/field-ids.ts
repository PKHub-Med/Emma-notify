export const AIRTABLE_TABLE_IDS = {
  serviceOrders: "tblJSUtmWrc1feldG",
  inspections: "tblPiDXQXcAWKogIk",
  contacts: "tblOAizKjQYDhIzEx",
  devices: "tblnEZZVI2ws2dyx4",
} as const;

export const SERVICE_ORDER_FIELDS = {
  businessNumber: "fldvxV5Kvva5i1BJN",
  clientOrderNumber: "fldd7gJIpGiIz8jof",
  caseSubtype: "fldZUjAkbnVhSIfrV",
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
  customerStatus: "fldN0dGXaGv40EHsk",
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

export const SERVICE_ORDER_FIELD_IDS = Object.values(SERVICE_ORDER_FIELDS);
export const INSPECTION_FIELD_IDS = Object.values(INSPECTION_FIELDS);
export const CONTACT_FIELD_IDS = Object.values(CONTACT_FIELDS);
