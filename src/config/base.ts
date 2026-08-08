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
