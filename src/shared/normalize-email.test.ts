import { describe, expect, it } from "vitest";
import { normalizeEmail } from "./normalize-email.js";

describe("normalizeEmail", () => {
  it("trims surrounding whitespace and lowercases the address", () => {
    expect(normalizeEmail("  User.Name+Tag@Example.COM \n")).toBe(
      "user.name+tag@example.com",
    );
  });

  it("keeps an already normalized address unchanged", () => {
    expect(normalizeEmail("user@example.com")).toBe("user@example.com");
  });
});
