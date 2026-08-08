import { z } from "zod";
import {
  baseEnvironmentShape,
  createConfigurationError,
  type BaseConfig,
} from "./base.js";
import { accessLinkSigningSecretSchema } from "./access-link.js";

const apiEnvironmentSchema = z.object({
  ...baseEnvironmentShape,
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  ACCESS_LINK_SIGNING_SECRET: accessLinkSigningSecretSchema,
});

export type ApiConfig = BaseConfig & {
  port: number;
  accessLinkSigningSecret: string;
};

export function loadApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const parsed = apiEnvironmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw createConfigurationError(parsed.error);
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    port: parsed.data.PORT,
    accessLinkSigningSecret: parsed.data.ACCESS_LINK_SIGNING_SECRET,
    timezone: parsed.data.TIMEZONE,
    emailMode: parsed.data.EMAIL_MODE,
    testEmail: parsed.data.TEST_EMAIL || null,
    productionEmailsEnabled: parsed.data.PRODUCTION_EMAILS_ENABLED,
    linkTtlDays: parsed.data.LINK_TTL_DAYS,
  };
}
