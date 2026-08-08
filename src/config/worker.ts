import { z } from "zod";
import {
  baseEnvironmentShape,
  createConfigurationError,
  type BaseConfig,
} from "./base.js";
import {
  accessLinkSigningSecretSchema,
  publicBaseUrlSchema,
} from "./access-link.js";

const workerEnvironmentSchema = z.object({
  ...baseEnvironmentShape,
  AIRTABLE_BASE_ID: z.string().min(1),
  AIRTABLE_PAT: z.string().min(1),
  AIRTABLE_POLL_SECONDS: z.coerce.number().int().positive().default(60),
  AIRTABLE_SYNC_OVERLAP_SECONDS: z.coerce.number().int().nonnegative().default(120),
  DIGEST_QUIET_MINUTES: z.coerce.number().int().nonnegative().default(1),
  RESEND_API_KEY: z.string().default(""),
  RESEND_CASE_DIGEST_TEMPLATE_ID: z.string().default(""),
  EMAIL_FROM: z.string().default(""),
  ACCESS_LINK_SIGNING_SECRET: accessLinkSigningSecretSchema,
  PUBLIC_BASE_URL: publicBaseUrlSchema,
});

export type WorkerConfig = BaseConfig & {
  airtableBaseId: string;
  airtablePat: string;
  airtablePollSeconds: number;
  airtableSyncOverlapSeconds: number;
  digestQuietMinutes: number;
  resendApiKey: string | null;
  resendCaseDigestTemplateId: string | null;
  emailFrom: string | null;
  accessLinkSigningSecret: string;
  publicBaseUrl: string;
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
    resendCaseDigestTemplateId:
      parsed.data.RESEND_CASE_DIGEST_TEMPLATE_ID.trim() || null,
    emailFrom: parsed.data.EMAIL_FROM.trim() || null,
    accessLinkSigningSecret: parsed.data.ACCESS_LINK_SIGNING_SECRET,
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL,
    timezone: parsed.data.TIMEZONE,
    emailMode: parsed.data.EMAIL_MODE,
    testEmail: parsed.data.TEST_EMAIL || null,
    productionEmailsEnabled: parsed.data.PRODUCTION_EMAILS_ENABLED,
    linkTtlDays: parsed.data.LINK_TTL_DAYS,
  };
}
