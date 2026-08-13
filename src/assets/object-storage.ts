import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface ObjectStorage {
  putObject(key: string, body: Uint8Array, contentType: string): Promise<void>;
  headObject(key: string): Promise<{ sizeBytes: number | null; contentType: string | null } | null>;
  getSignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

export type S3ObjectStorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: S3ObjectStorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket, Key: key, Body: body, ContentType: contentType,
    }));
  }

  async headObject(key: string) {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket, Key: key,
      }));
      return {
        sizeBytes: typeof result.ContentLength === "number" ? result.ContentLength : null,
        contentType: result.ContentType ?? null,
      };
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  getSignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.config.bucket, Key: key,
    }), { expiresIn: expiresInSeconds });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}

export function createS3ObjectStorage(config: {
  storageEndpoint: string | null;
  storageRegion: string;
  storageBucket: string | null;
  storageAccessKeyId: string | null;
  storageSecretAccessKey: string | null;
  storageForcePathStyle: boolean;
}): S3ObjectStorage {
  if (!config.storageEndpoint || !config.storageBucket || !config.storageAccessKeyId ||
    !config.storageSecretAccessKey) throw new Error("ASSET_STORAGE_NOT_CONFIGURED");
  return new S3ObjectStorage({
    endpoint: config.storageEndpoint,
    region: config.storageRegion,
    bucket: config.storageBucket,
    accessKeyId: config.storageAccessKeyId,
    secretAccessKey: config.storageSecretAccessKey,
    forcePathStyle: config.storageForcePathStyle,
  });
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.name === "NotFound" || value.$metadata?.httpStatusCode === 404;
}
