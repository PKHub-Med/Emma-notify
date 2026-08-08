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
  AIRTABLE_POLL_SECONDS: z.coerce.number().int().positive().default(60),
  AIRTABLE_SYNC_OVERLAP_SECONDS: z.coerce.number().int().nonnegative().default(120),
  DIGEST_QUIET_MINUTES: z.coerce.number().int().nonnegative().default(1),
  RESEND_API_KEY: z.string().default(""),
  EMAIL_FROM: z.string().default(""),
});

export type WorkerConfig = BaseConfig & {
  airtableBaseId: string;
  airtablePat: string;
  airtablePollSeconds: number;
  airtableSyncOverlapSeconds: number;
  digestQuietMinutes: number;
  resendApiKey: string | null;
  emailFrom: string | null;
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
    airtablePollSeconds: parsed.data.AIRTABLE_POLL_SECONDS,
    airtableSyncOverlapSeconds: parsed.data.AIRTABLE_SYNC_OVERLAP_SECONDS,
    digestQuietMinutes: parsed.data.DIGEST_QUIET_MINUTES,
    resendApiKey: parsed.data.RESEND_API_KEY.trim() || null,
    emailFrom: parsed.data.EMAIL_FROM.trim() || null,
    timezone: parsed.data.TIMEZONE,
    emailMode: parsed.data.EMAIL_MODE,
    testEmail: parsed.data.TEST_EMAIL || null,
    productionEmailsEnabled: parsed.data.PRODUCTION_EMAILS_ENABLED,
    linkTtlDays: parsed.data.LINK_TTL_DAYS,
  };
}
