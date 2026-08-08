import { z } from "zod";
import {
  baseEnvironmentShape,
  createConfigurationError,
  type BaseConfig,
} from "./base.js";

const apiEnvironmentSchema = z.object({
  ...baseEnvironmentShape,
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
});

export type ApiConfig = BaseConfig & {
  port: number;
};

export function loadApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const parsed = apiEnvironmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw createConfigurationError(parsed.error);
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    port: parsed.data.PORT,
    timezone: parsed.data.TIMEZONE,
    emailMode: parsed.data.EMAIL_MODE,
    testEmail: parsed.data.TEST_EMAIL || null,
    productionEmailsEnabled: parsed.data.PRODUCTION_EMAILS_ENABLED,
    linkTtlDays: parsed.data.LINK_TTL_DAYS,
  };
}
