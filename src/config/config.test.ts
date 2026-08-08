import { describe, expect, it } from "vitest";
import { loadApiConfig } from "./api.js";
import { loadWorkerConfig } from "./worker.js";

const databaseUrl = "postgresql://user:password@localhost:5432/emma_notify";

describe("loadApiConfig", () => {
  it("accepts API environment without Airtable variables", () => {
    const config = loadApiConfig({ DATABASE_URL: databaseUrl });

    expect(config).toMatchObject({
      databaseUrl,
      port: 3000,
      timezone: "Europe/Warsaw",
      emailMode: "TEST",
      productionEmailsEnabled: false,
      linkTtlDays: 30,
    });
  });
});

describe("loadWorkerConfig", () => {
  it("rejects a missing AIRTABLE_PAT", () => {
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: databaseUrl,
        AIRTABLE_BASE_ID: "appExample",
      }),
    ).toThrow(/AIRTABLE_PAT/);
  });

  it("accepts the required worker environment and applies defaults", () => {
    const config = loadWorkerConfig({
      DATABASE_URL: databaseUrl,
      AIRTABLE_BASE_ID: "appExample",
      AIRTABLE_PAT: "patExample",
    });

    expect(config).toMatchObject({
      databaseUrl,
      airtableBaseId: "appExample",
      airtablePat: "patExample",
      airtablePollSeconds: 60,
      airtableSyncOverlapSeconds: 120,
      digestQuietMinutes: 1,
      timezone: "Europe/Warsaw",
      emailMode: "TEST",
      productionEmailsEnabled: false,
      linkTtlDays: 30,
    });
  });

  it("never includes secret values in validation errors", () => {
    const secretDatabaseUrl =
      "postgresql://secret-user:secret-password@database.example/emma";
    const secretAirtablePat = "pat-super-secret-value";
    let errorMessage = "";

    try {
      loadWorkerConfig({
        DATABASE_URL: secretDatabaseUrl,
        AIRTABLE_BASE_ID: "appExample",
        AIRTABLE_PAT: secretAirtablePat,
        PRODUCTION_EMAILS_ENABLED: "invalid",
      });
    } catch (error: unknown) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain("PRODUCTION_EMAILS_ENABLED");
    expect(errorMessage).not.toContain(secretDatabaseUrl);
    expect(errorMessage).not.toContain(secretAirtablePat);
  });
});
