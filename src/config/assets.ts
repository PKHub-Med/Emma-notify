import { z } from "zod";

const booleanString = z.preprocess(
  (value) => value === undefined ? "false" : typeof value === "string" ? value.trim().toLowerCase() : value,
  z.enum(["true", "false"]),
).transform((value) => value === "true");

export const assetEnvironmentShape = {
  COMMUNICATION_ASSETS_ENABLED: booleanString,
  ASSET_PROCESSOR_SECONDS: z.coerce.number().int().positive().default(15),
  ASSET_PROCESSOR_CONCURRENCY: z.coerce.number().int().positive().max(10).default(3),
  COMMUNICATION_ASSET_PREP_TIMEOUT_SECONDS: z.coerce.number().int().nonnegative().default(90),
  ASSET_MAX_IMAGE_SOURCE_BYTES: z.coerce.number().int().positive().default(20_971_520),
  ASSET_MAX_DOCUMENT_SOURCE_BYTES: z.coerce.number().int().positive().default(52_428_800),
  ASSET_MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(50_000_000),
  ASSET_PORTAL_MAX_DIMENSION: z.coerce.number().int().positive().default(1_920),
  ASSET_THUMB_MAX_DIMENSION: z.coerce.number().int().positive().default(400),
  ASSET_PORTAL_WEBP_QUALITY: z.coerce.number().int().min(1).max(100).default(82),
  ASSET_THUMB_WEBP_QUALITY: z.coerce.number().int().min(1).max(100).default(78),
  RAILWAY_STORAGE_ENDPOINT: z.string().default(""),
  RAILWAY_STORAGE_REGION: z.string().default("auto"),
  RAILWAY_STORAGE_BUCKET: z.string().default(""),
  RAILWAY_STORAGE_ACCESS_KEY_ID: z.string().default(""),
  RAILWAY_STORAGE_SECRET_ACCESS_KEY: z.string().default(""),
  RAILWAY_STORAGE_FORCE_PATH_STYLE: booleanString,
  ASSET_SIGNED_URL_SECONDS: z.coerce.number().int().positive().max(3_600).default(300),
} as const;

export type AssetConfig = {
  communicationAssetsEnabled: boolean;
  assetProcessorSeconds: number;
  assetProcessorConcurrency: number;
  communicationAssetPrepTimeoutSeconds: number;
  assetMaxImageSourceBytes: number;
  assetMaxDocumentSourceBytes: number;
  assetMaxImagePixels: number;
  assetPortalMaxDimension: number;
  assetThumbMaxDimension: number;
  assetPortalWebpQuality: number;
  assetThumbWebpQuality: number;
  storageEndpoint: string | null;
  storageRegion: string;
  storageBucket: string | null;
  storageAccessKeyId: string | null;
  storageSecretAccessKey: string | null;
  storageForcePathStyle: boolean;
  assetSignedUrlSeconds: number;
};

export function mapAssetConfig(data: Record<keyof typeof assetEnvironmentShape, unknown>): AssetConfig {
  const config: AssetConfig = {
    communicationAssetsEnabled: data.COMMUNICATION_ASSETS_ENABLED as boolean,
    assetProcessorSeconds: data.ASSET_PROCESSOR_SECONDS as number,
    assetProcessorConcurrency: data.ASSET_PROCESSOR_CONCURRENCY as number,
    communicationAssetPrepTimeoutSeconds: data.COMMUNICATION_ASSET_PREP_TIMEOUT_SECONDS as number,
    assetMaxImageSourceBytes: data.ASSET_MAX_IMAGE_SOURCE_BYTES as number,
    assetMaxDocumentSourceBytes: data.ASSET_MAX_DOCUMENT_SOURCE_BYTES as number,
    assetMaxImagePixels: data.ASSET_MAX_IMAGE_PIXELS as number,
    assetPortalMaxDimension: data.ASSET_PORTAL_MAX_DIMENSION as number,
    assetThumbMaxDimension: data.ASSET_THUMB_MAX_DIMENSION as number,
    assetPortalWebpQuality: data.ASSET_PORTAL_WEBP_QUALITY as number,
    assetThumbWebpQuality: data.ASSET_THUMB_WEBP_QUALITY as number,
    storageEndpoint: nullable(data.RAILWAY_STORAGE_ENDPOINT),
    storageRegion: data.RAILWAY_STORAGE_REGION as string,
    storageBucket: nullable(data.RAILWAY_STORAGE_BUCKET),
    storageAccessKeyId: nullable(data.RAILWAY_STORAGE_ACCESS_KEY_ID),
    storageSecretAccessKey: nullable(data.RAILWAY_STORAGE_SECRET_ACCESS_KEY),
    storageForcePathStyle: data.RAILWAY_STORAGE_FORCE_PATH_STYLE as boolean,
    assetSignedUrlSeconds: data.ASSET_SIGNED_URL_SECONDS as number,
  };
  if (config.communicationAssetsEnabled && (!config.storageEndpoint || !config.storageBucket ||
    !config.storageAccessKeyId || !config.storageSecretAccessKey)) {
    throw new Error("CONFIGURATION_ERROR: RAILWAY_STORAGE_* variables are required when COMMUNICATION_ASSETS_ENABLED=true");
  }
  return config;
}

export function hasAssetStorageConfig(config: Pick<AssetConfig,
  "storageEndpoint" | "storageBucket" | "storageAccessKeyId" | "storageSecretAccessKey"
>): boolean {
  return Boolean(
    config.storageEndpoint && config.storageBucket &&
    config.storageAccessKeyId && config.storageSecretAccessKey,
  );
}

function nullable(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
