import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const requiredEnvironment: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/emma_notify",
  AIRTABLE_BASE_ID: "appExample",
  AIRTABLE_PAT: "patExample",
};

describe("loadConfig", () => {
  it("loads required values and applies safe defaults", () => {
    const config = loadConfig(requiredEnvironment);

    expect(config).toMatchObject({
      port: 3000,
      digestQuietMinutes: 1,
      timezone: "Europe/Warsaw",
      emailMode: "TEST",
      productionEmailsEnabled: false,
      linkTtlDays: 30,
    });
  });

  it("parses explicit numeric and boolean values", () => {
    const config = loadConfig({
      ...requiredEnvironment,
      PORT: "8080",
      DIGEST_QUIET_MINUTES: "5",
      PRODUCTION_EMAILS_ENABLED: "true",
      LINK_TTL_DAYS: "14",
    });

    expect(config.port).toBe(8080);
    expect(config.digestQuietMinutes).toBe(5);
    expect(config.productionEmailsEnabled).toBe(true);
    expect(config.linkTtlDays).toBe(14);
  });

  it("rejects missing required values", () => {
    expect(() => loadConfig({})).toThrow("Invalid environment configuration");
  });

  it("rejects ambiguous boolean values", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        PRODUCTION_EMAILS_ENABLED: "yes",
      }),
    ).toThrow("Invalid environment configuration");
  });
});
