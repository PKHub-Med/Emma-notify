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

const strictBooleanString = z.preprocess(
  (value) => value === undefined
    ? "false"
    : typeof value === "string" ? value.trim().toLowerCase() : value,
  z.enum(["true", "false"]),
).transform((value) => value === "true");

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
  EMAIL_REPLY_TO: z.email().default("serwis@tiemed.pl"),
  ACCESS_LINK_SIGNING_SECRET: accessLinkSigningSecretSchema,
  PUBLIC_BASE_URL: publicBaseUrlSchema,
  TIEMED_FALLBACK_EMAIL: z.union([z.email(), z.literal("")]).default(""),
  COMMUNICATION_TIMEZONE: z.string().min(1).default("Europe/Warsaw").refine(
    isIanaTimezone,
    "Invalid IANA timezone",
  ),
  COMMUNICATION_EMAILS_ENABLED: strictBooleanString,
  COMMUNICATION_SEND_NOT_BEFORE: z.string().default(""),
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
  emailReplyTo: string;
  accessLinkSigningSecret: string;
  publicBaseUrl: string;
  tiemedFallbackEmail: string | null;
  communicationTimezone: string;
  communicationEmailsEnabled: boolean;
  communicationSendNotBefore: Date | null;
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
    emailReplyTo: parsed.data.EMAIL_REPLY_TO,
    accessLinkSigningSecret: parsed.data.ACCESS_LINK_SIGNING_SECRET,
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL,
    tiemedFallbackEmail: parsed.data.TIEMED_FALLBACK_EMAIL.trim() || null,
    communicationTimezone: parsed.data.COMMUNICATION_TIMEZONE,
    communicationEmailsEnabled: parsed.data.COMMUNICATION_EMAILS_ENABLED,
    communicationSendNotBefore: parseIsoTimestamp(
      parsed.data.COMMUNICATION_SEND_NOT_BEFORE,
    ),
    timezone: parsed.data.TIMEZONE,
    emailMode: parsed.data.EMAIL_MODE,
    testEmail: parsed.data.TEST_EMAIL || null,
    productionEmailsEnabled: parsed.data.PRODUCTION_EMAILS_ENABLED,
    linkTtlDays: parsed.data.LINK_TTL_DAYS,
    serviceName: parsed.data.SERVICE_NAME,
  };
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parseIsoTimestamp(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ||
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)
    ? null
    : parsed;
}
