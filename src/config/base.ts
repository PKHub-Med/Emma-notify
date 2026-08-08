import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const baseEnvironmentShape = {
  DATABASE_URL: z.string().min(1),
  TIMEZONE: z.string().min(1).default("Europe/Warsaw"),
  EMAIL_MODE: z.enum(["TEST", "PRODUCTION"]).default("TEST"),
  TEST_EMAIL: z.union([z.email(), z.literal("")]).default(""),
  PRODUCTION_EMAILS_ENABLED: booleanString.default(false),
  LINK_TTL_DAYS: z.coerce.number().int().positive().default(30),
};

export type BaseConfig = {
  databaseUrl: string;
  timezone: string;
  emailMode: "TEST" | "PRODUCTION";
  testEmail: string | null;
  productionEmailsEnabled: boolean;
  linkTtlDays: number;
};

const baseEnvironmentSchema = z.object(baseEnvironmentShape);

export function loadBaseConfig(environment: NodeJS.ProcessEnv): BaseConfig {
  const parsed = baseEnvironmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw createConfigurationError(parsed.error);
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    timezone: parsed.data.TIMEZONE,
    emailMode: parsed.data.EMAIL_MODE,
    testEmail: parsed.data.TEST_EMAIL || null,
    productionEmailsEnabled: parsed.data.PRODUCTION_EMAILS_ENABLED,
    linkTtlDays: parsed.data.LINK_TTL_DAYS,
  };
}

export function createConfigurationError(error: z.ZodError): Error {
  const fields = [
    ...new Set(
      error.issues.map((issue) =>
        issue.path.length > 0 ? issue.path.map(String).join(".") : "environment",
      ),
    ),
  ];
  const details = fields.map((field) => `- ${field}: invalid or missing value`);

  return new Error(`Invalid environment configuration:\n${details.join("\n")}`);
}
