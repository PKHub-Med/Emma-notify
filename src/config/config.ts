import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AIRTABLE_BASE_ID: z.string().min(1, "AIRTABLE_BASE_ID is required"),
  AIRTABLE_PAT: z.string().min(1, "AIRTABLE_PAT is required"),
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  DIGEST_QUIET_MINUTES: z.coerce.number().int().nonnegative().default(1),
  TIMEZONE: z.string().min(1).default("Europe/Warsaw"),
  EMAIL_MODE: z.enum(["TEST", "PRODUCTION"]).default("TEST"),
  TEST_EMAIL: z.union([z.email(), z.literal("")]).default(""),
  PRODUCTION_EMAILS_ENABLED: booleanString.default(false),
  LINK_TTL_DAYS: z.coerce.number().int().positive().default(30),
});

export type AppConfig = {
  databaseUrl: string;
  airtableBaseId: string;
  airtablePat: string;
  port: number;
  digestQuietMinutes: number;
  timezone: string;
  emailMode: "TEST" | "PRODUCTION";
  testEmail: string | null;
  productionEmailsEnabled: boolean;
  linkTtlDays: number;
};

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(environment);

  if (!parsed.success) {
    const details = z.prettifyError(parsed.error);
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    airtableBaseId: parsed.data.AIRTABLE_BASE_ID,
    airtablePat: parsed.data.AIRTABLE_PAT,
    port: parsed.data.PORT,
    digestQuietMinutes: parsed.data.DIGEST_QUIET_MINUTES,
    timezone: parsed.data.TIMEZONE,
    emailMode: parsed.data.EMAIL_MODE,
    testEmail: parsed.data.TEST_EMAIL || null,
    productionEmailsEnabled: parsed.data.PRODUCTION_EMAILS_ENABLED,
    linkTtlDays: parsed.data.LINK_TTL_DAYS,
  };
}
