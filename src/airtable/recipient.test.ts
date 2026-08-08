import { describe, expect, it } from "vitest";
import { resolveRecipient, type Contact } from "./recipient.js";

function contact(contactableValue: string, email: string | null): Contact {
  return {
    airtableRecordId: "recContact",
    name: "Test Contact",
    email,
    contactableValue,
  };
}

describe("resolveRecipient", () => {
  it.each(["TAK", "tak", " TAK "])("accepts contactable flag %s", (flag) => {
    const result = resolveRecipient(
      "recContact",
      contact(flag, " User@Example.COM "),
    );
    expect(result).toMatchObject({
      eligible: true,
      eligibilityReason: "ELIGIBLE",
      normalizedEmail: "user@example.com",
    });
  });

  it("rejects a contact marked NIE", () => {
    expect(resolveRecipient("recContact", contact("NIE", "user@example.com")))
      .toMatchObject({
        eligible: false,
        eligibilityReason: "FLAG_NOT_CONTACTABLE",
      });
  });

  it("rejects an empty email", () => {
    expect(resolveRecipient("recContact", contact("TAK", null))).toMatchObject({
      eligible: false,
      eligibilityReason: "MISSING_EMAIL",
    });
  });

  it("rejects an invalid email", () => {
    expect(resolveRecipient("recContact", contact("TAK", "invalid"))).toMatchObject({
      eligible: false,
      eligibilityReason: "INVALID_EMAIL",
    });
  });
});
