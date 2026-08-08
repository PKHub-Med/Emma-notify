import { normalizeEmail } from "../shared/normalize-email.js";

export type EmailMode = "TEST" | "PRODUCTION";

export type RecipientErrorCode =
  | "TEST_EMAIL_MISSING"
  | "PRODUCTION_EMAILS_BLOCKED"
  | "INVALID_RECIPIENT"
  | "TEST_RECIPIENT_GUARD_FAILED";

export class RecipientSafetyError extends Error {
  constructor(readonly code: RecipientErrorCode) {
    super(code);
    this.name = "RecipientSafetyError";
  }
}

export function resolveActualRecipient(input: {
  mode: EmailMode;
  intendedRecipientEmail: string;
  testEmail: string | null;
  productionEmailsEnabled: boolean;
}): string {
  if (input.mode === "TEST") {
    const testEmail = normalizeOptionalEmail(input.testEmail);
    if (!testEmail) throw new RecipientSafetyError("TEST_EMAIL_MISSING");
    return testEmail;
  }

  if (!input.productionEmailsEnabled) {
    throw new RecipientSafetyError("PRODUCTION_EMAILS_BLOCKED");
  }

  const intendedRecipient = normalizeEmail(input.intendedRecipientEmail);
  if (!intendedRecipient) {
    throw new RecipientSafetyError("INVALID_RECIPIENT");
  }
  return intendedRecipient;
}

export function assertTestRecipient(input: {
  mode: EmailMode;
  actualRecipientEmail: string;
  testEmail: string | null;
}): void {
  if (input.mode !== "TEST") return;
  const actual = normalizeEmail(input.actualRecipientEmail);
  const expected = normalizeOptionalEmail(input.testEmail);
  if (!expected || actual !== expected) {
    throw new RecipientSafetyError("TEST_RECIPIENT_GUARD_FAILED");
  }
}

function normalizeOptionalEmail(email: string | null): string | null {
  if (!email) return null;
  return normalizeEmail(email) || null;
}
