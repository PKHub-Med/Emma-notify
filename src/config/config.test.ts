import { describe, expect, it } from "vitest";
import { loadApiConfig } from "./api.js";
import { loadWorkerConfig } from "./worker.js";

const databaseUrl = "postgresql://user:password@localhost:5432/emma_notify";
const accessLinkSigningSecret = "test-access-link-signing-secret-32-bytes-minimum";
const publicBaseUrl = "https://notify.example.org/";
const workerEnvironment = {
  DATABASE_URL: databaseUrl,
  AIRTABLE_BASE_ID: "appExample",
  AIRTABLE_PAT: "patExample",
  ACCESS_LINK_SIGNING_SECRET: accessLinkSigningSecret,
  PUBLIC_BASE_URL: publicBaseUrl,
};

describe("loadApiConfig", () => {
  it("accepts API environment without Airtable variables", () => {
    const config = loadApiConfig({
      DATABASE_URL: databaseUrl,
      ACCESS_LINK_SIGNING_SECRET: accessLinkSigningSecret,
    });

    expect(config).toMatchObject({
      databaseUrl,
      port: 3000,
      timezone: "Europe/Warsaw",
      emailMode: "TEST",
      productionEmailsEnabled: false,
      linkTtlDays: 30,
    });
  });

  it("rejects a missing or too-short AccessLink signing secret", () => {
    expect(() => loadApiConfig({ DATABASE_URL: databaseUrl })).toThrow(
      /ACCESS_LINK_SIGNING_SECRET/,
    );
    expect(() => loadApiConfig({
      DATABASE_URL: databaseUrl,
      ACCESS_LINK_SIGNING_SECRET: "too-short",
    })).toThrow(/ACCESS_LINK_SIGNING_SECRET/);
  });
});

describe("loadWorkerConfig", () => {
  it("parses the production switch strictly after trim and lowercase", () => {
    const common = workerEnvironment;
    expect(loadWorkerConfig({
      ...common,
      PRODUCTION_EMAILS_ENABLED: "false",
    }).productionEmailsEnabled).toBe(false);
    expect(loadWorkerConfig({
      ...common,
      PRODUCTION_EMAILS_ENABLED: " TRUE ",
    }).productionEmailsEnabled).toBe(true);
    expect(loadWorkerConfig(common).productionEmailsEnabled).toBe(false);
  });

  it("rejects a missing AIRTABLE_PAT", () => {
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: databaseUrl,
        AIRTABLE_BASE_ID: "appExample",
        ACCESS_LINK_SIGNING_SECRET: accessLinkSigningSecret,
        PUBLIC_BASE_URL: publicBaseUrl,
      }),
    ).toThrow(/AIRTABLE_PAT/);
  });

  it("accepts the required worker environment and applies defaults", () => {
    const config = loadWorkerConfig(workerEnvironment);

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
      publicBaseUrl: "https://notify.example.org",
      tiemedFallbackEmail: null,
      communicationTimezone: "Europe/Warsaw",
      communicationEmailsEnabled: false,
      communicationSendNotBefore: null,
      emailReplyTo: "serwis@tiemed.pl",
    });
  });

  it("parses communication activation safely without crashing on an invalid timestamp", () => {
    expect(loadWorkerConfig({
      ...workerEnvironment,
      COMMUNICATION_EMAILS_ENABLED: "true",
      COMMUNICATION_SEND_NOT_BEFORE: "2026-08-15T10:00:00.000Z",
    }).communicationSendNotBefore?.toISOString()).toBe("2026-08-15T10:00:00.000Z");
    expect(loadWorkerConfig({
      ...workerEnvironment,
      COMMUNICATION_EMAILS_ENABLED: "true",
      COMMUNICATION_SEND_NOT_BEFORE: "invalid",
    }).communicationSendNotBefore).toBeNull();
  });

  it("uses configurable Reply-To with the Tiemed default", () => {
    expect(loadWorkerConfig(workerEnvironment).emailReplyTo).toBe("serwis@tiemed.pl");
    expect(loadWorkerConfig({ ...workerEnvironment, EMAIL_REPLY_TO: "reply@example.test" }).emailReplyTo).toBe("reply@example.test");
  });

  it("accepts an IANA communication timezone and rejects an invalid one", () => {
    expect(loadWorkerConfig({
      ...workerEnvironment,
      COMMUNICATION_TIMEZONE: "Europe/London",
    }).communicationTimezone).toBe("Europe/London");
    expect(() => loadWorkerConfig({
      ...workerEnvironment,
      COMMUNICATION_TIMEZONE: "UTC+2",
    })).toThrow(/COMMUNICATION_TIMEZONE/);
  });

  it("accepts an optional Tiemed fallback email", () => {
    expect(loadWorkerConfig({
      ...workerEnvironment,
      TIEMED_FALLBACK_EMAIL: "fallback@example.test",
    }).tiemedFallbackEmail).toBe("fallback@example.test");
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
        ACCESS_LINK_SIGNING_SECRET: accessLinkSigningSecret,
        PUBLIC_BASE_URL: publicBaseUrl,
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
