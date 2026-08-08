import { z } from "zod";
import {
  baseEnvironmentShape,
  createConfigurationError,
  type BaseConfig,
} from "./base.js";

const workerEnvironmentSchema = z.object({
  ...baseEnvironmentShape,
  AIRTABLE_BASE_ID: z.string().min(1),
  AIRTABLE_PAT: z.string().min(1),
  DIGEST_QUIET_MINUTES: z.coerce.number().int().nonnegative().default(1),
});

export type WorkerConfig = BaseConfig & {
  airtableBaseId: string;
  airtablePat: string;
  digestQuietMinutes: number;
};

export function loadWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = workerEnvironmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw createConfigurationError(parsed.error);
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    airtableBaseId: parsed.data.AIRTABLE_BASE_ID,
    airtablePat: parsed.data.AIRTABLE_PAT,
    digestQuietMinutes: parsed.data.DIGEST_QUIET_MINUTES,
    timezone: parsed.data.TIMEZONE,
    emailMode: parsed.data.EMAIL_MODE,
    testEmail: parsed.data.TEST_EMAIL || null,
    productionEmailsEnabled: parsed.data.PRODUCTION_EMAILS_ENABLED,
    linkTtlDays: parsed.data.LINK_TTL_DAYS,
  };
}
