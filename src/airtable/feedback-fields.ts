import { AIRTABLE_TABLE_IDS } from "./field-ids.js";

/**
 * Write-back columns that show the outcome of Emma communication next to the
 * Airtable record. They are local (non-synced) columns in the "Emma neu" base,
 * so writing them does not change the synced "Last mod emma" values.
 *
 * These IDs must never be added to any field list used by synchronization.
 */
export type FeedbackTableKey = "SERVICE_ORDER" | "TASK" | "INSPECTION";

export type FeedbackFieldIds = {
  type: string;
  status: string;
  date: string;
  recipient: string;
  reason: string;
  history: string;
};

export const FEEDBACK_TABLE_IDS: Record<FeedbackTableKey, string> = {
  SERVICE_ORDER: AIRTABLE_TABLE_IDS.serviceOrders,
  TASK: AIRTABLE_TABLE_IDS.tasks,
  INSPECTION: AIRTABLE_TABLE_IDS.inspections,
};

export const FEEDBACK_FIELDS: Record<FeedbackTableKey, FeedbackFieldIds> = {
  SERVICE_ORDER: {
    type: "fldGTgbpXmzP8JzSt",
    status: "fldlgZrTubUcWwzkl",
    date: "fldMLoFiQg9VY911j",
    recipient: "fld7IzyqnoS3QiGk4",
    reason: "fld4ke98S1C4nAEYt",
    history: "fld8cl6mZq5TRdDLC",
  },
  TASK: {
    type: "fldMeiW9hO4oVIq0I",
    status: "fldoaexK4F8py7knL",
    date: "fldMscRMLsXfqQh2P",
    recipient: "fldrCLvE8m2k739uD",
    reason: "fld9Y8tM2hmnmgKIJ",
    history: "fldjq0uxsvsliCP8M",
  },
  INSPECTION: {
    type: "fld6CVVTGcizSAowq",
    status: "fldKDq7QBpa4ZZJem",
    date: "fldn1h1RGpEeypesc",
    recipient: "fldzWgLHiyHfgHEhs",
    reason: "fldIXTOl43pJYpVUE",
    history: "fldLlPQFZOB1RHkSa",
  },
};

export const ALL_FEEDBACK_FIELD_IDS: readonly string[] = Object.values(FEEDBACK_FIELDS)
  .flatMap((fields) => Object.values(fields));

/** Option names of the "EMMA: ostatni mail – typ" single selects. */
export const FEEDBACK_SCENARIO_LABELS = {
  REPAIR_RECEIVED: "Przyjęcie naprawy",
  REPAIR_DELAYED_PARTS: "Opóźnienie – części",
  REPAIR_COMPLETED: "Naprawa zakończona",
  INSPECTION_DATE_PROPOSED: "Propozycja terminu",
  INSPECTION_DATE_CONFIRMED: "Potwierdzenie terminu",
  INSPECTION_REMINDER: "Przypomnienie",
  INSPECTION_COMPLETED: "Przeglądy zakończone",
} as const;

export type FeedbackScenario = keyof typeof FEEDBACK_SCENARIO_LABELS;

/** Option names of the "EMMA: ostatni mail – status" single selects. */
export const FEEDBACK_STATUS = {
  SCHEDULED: "Zaplanowany",
  SENT: "Wysłany",
  FAILED: "Błąd",
  BLOCKED: "Zablokowany",
  CANCELLED: "Anulowany",
  NOT_SENT: "Nie wysłano",
} as const;

export type FeedbackStatusLabel = typeof FEEDBACK_STATUS[keyof typeof FEEDBACK_STATUS];
