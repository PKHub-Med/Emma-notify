import { z } from "zod";
import { CONTACT_FIELDS } from "./field-ids.js";
import type { AirtableRecord } from "./types.js";
import { toOptionalString } from "./values.js";
import { normalizeEmail } from "../shared/normalize-email.js";

export type EligibilityReason =
  | "ELIGIBLE"
  | "FLAG_NOT_CONTACTABLE"
  | "MISSING_EMAIL"
  | "INVALID_EMAIL";

export type Contact = {
  airtableRecordId: string;
  name: string | null;
  email: string | null;
  contactableValue: string | null;
};

export type ResolvedRecipient = {
  airtableContactRecordId: string;
  name: string | null;
  email: string | null;
  normalizedEmail: string | null;
  eligible: boolean;
  eligibilityReason: EligibilityReason;
  resolutionSource: "CONTACT_LINK";
};

export function mapContact(record: AirtableRecord): Contact {
  return {
    airtableRecordId: record.id,
    name: toOptionalString(record.fields[CONTACT_FIELDS.name]),
    email: toOptionalString(record.fields[CONTACT_FIELDS.email]),
    contactableValue: toOptionalString(record.fields[CONTACT_FIELDS.contactable]),
  };
}

export function resolveRecipient(
  airtableContactRecordId: string,
  contact: Contact | undefined,
): ResolvedRecipient {
  const name = contact?.name ?? null;
  const email = contact?.email ?? null;
  const isContactable = contact?.contactableValue?.trim().toUpperCase() === "TAK";

  if (!isContactable) {
    return recipient(
      airtableContactRecordId,
      name,
      email,
      null,
      false,
      "FLAG_NOT_CONTACTABLE",
    );
  }

  if (!email) {
    return recipient(
      airtableContactRecordId,
      name,
      null,
      null,
      false,
      "MISSING_EMAIL",
    );
  }

  const normalizedEmail = normalizeEmail(email);
  if (!z.email().safeParse(normalizedEmail).success) {
    return recipient(
      airtableContactRecordId,
      name,
      email,
      normalizedEmail,
      false,
      "INVALID_EMAIL",
    );
  }

  return recipient(
    airtableContactRecordId,
    name,
    email,
    normalizedEmail,
    true,
    "ELIGIBLE",
  );
}

function recipient(
  airtableContactRecordId: string,
  name: string | null,
  email: string | null,
  normalizedEmail: string | null,
  eligible: boolean,
  eligibilityReason: EligibilityReason,
): ResolvedRecipient {
  return {
    airtableContactRecordId,
    name,
    email,
    normalizedEmail,
    eligible,
    eligibilityReason,
    resolutionSource: "CONTACT_LINK",
  };
}
