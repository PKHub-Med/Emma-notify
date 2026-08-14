import { z } from "zod";
import {
  baseEnvironmentShape,
  createConfigurationError,
  type BaseConfig,
} from "./base.js";
import { accessLinkSigningSecretSchema } from "./access-link.js";
import { assetEnvironmentShape, mapAssetConfig, type AssetConfig } from "./assets.js";

const apiEnvironmentSchema = z.object({
  ...baseEnvironmentShape,
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  ACCESS_LINK_SIGNING_SECRET: accessLinkSigningSecretSchema,
  PORTAL_PAGE_SIZE: z.coerce.number().int().positive().max(100).default(30),
  PORTAL_UPGRADE_URL: z.string().trim().default("").refine((value) => {
    if (!value) return true;
    try {
      return ["https:", "mailto:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "PORTAL_UPGRADE_URL_INVALID"),
  ...assetEnvironmentShape,
});

export type ApiConfig = BaseConfig & AssetConfig & {
  port: number;
  accessLinkSigningSecret: string;
  portalPageSize: number;
  portalUpgradeUrl: string | null;
};

export function loadApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const parsed = apiEnvironmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw createConfigurationError(parsed.error);
  }

  return {
    ...mapAssetConfig(parsed.data),
    databaseUrl: parsed.data.DATABASE_URL,
    port: parsed.data.PORT,
    accessLinkSigningSecret: parsed.data.ACCESS_LINK_SIGNING_SECRET,
    portalPageSize: parsed.data.PORTAL_PAGE_SIZE,
    portalUpgradeUrl: parsed.data.PORTAL_UPGRADE_URL || null,
    timezone: parsed.data.TIMEZONE,
    emailMode: parsed.data.EMAIL_MODE,
    testEmail: parsed.data.TEST_EMAIL || null,
    productionEmailsEnabled: parsed.data.PRODUCTION_EMAILS_ENABLED,
    linkTtlDays: parsed.data.LINK_TTL_DAYS,
    serviceName: parsed.data.SERVICE_NAME,
  };
}
