import { describe, expect, it } from "vitest";
import {
  resolveRecipient,
  resolveRepairEmailRecipient,
  type Contact,
} from "./recipient.js";

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

describe("resolveRepairEmailRecipient", () => {
  it("trims and validates EMMA: mail DT without a contact lookup", () => {
    expect(resolveRepairEmailRecipient(" Repair@Hospital.PL ")).toMatchObject({
      airtableContactRecordId: "EMMA_MAIL_DT",
      email: "Repair@Hospital.PL",
      normalizedEmail: "repair@hospital.pl",
      eligible: true,
      resolutionSource: "EMMA_MAIL_DT",
    });
  });

  it("rejects an empty value", () => {
    expect(resolveRepairEmailRecipient("   ")).toMatchObject({
      eligible: false,
      eligibilityReason: "MISSING_EMAIL",
      normalizedEmail: null,
    });
  });

  it("rejects an invalid value", () => {
    expect(resolveRepairEmailRecipient("not-an-email")).toMatchObject({
      eligible: false,
      eligibilityReason: "INVALID_EMAIL",
      normalizedEmail: null,
    });
  });
});
