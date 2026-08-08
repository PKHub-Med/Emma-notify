import { describe, expect, it } from "vitest";
import {
  assertTestRecipient,
  resolveActualRecipient,
} from "./recipient.js";

describe("resolveActualRecipient", () => {
  it("always resolves TEST mode to normalized TEST_EMAIL", () => {
    expect(resolveActualRecipient({
      mode: "TEST",
      intendedRecipientEmail: "client@example.com",
      testEmail: " PAWELEKARCZ@GMAIL.COM ",
      productionEmailsEnabled: true,
    })).toBe("pawelekarcz@gmail.com");
  });

  it("rejects a runtime TEST recipient mismatch", () => {
    expect(() => assertTestRecipient({
      mode: "TEST",
      actualRecipientEmail: "client@example.com",
      testEmail: "pawelekarcz@gmail.com",
    })).toThrow("TEST_RECIPIENT_GUARD_FAILED");
  });
});
