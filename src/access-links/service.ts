import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  assertSigningSecret,
  generatePublicId,
  signAccessLink,
} from "./token.js";

export type AccessLinkRecord = {
  publicId: string;
  digestId: string;
  expiresAt: Date;
  createdAt: Date;
};

export interface AccessLinkStore {
  findByDigestId(digestId: string): Promise<AccessLinkRecord | null>;
  create(input: AccessLinkRecord): Promise<AccessLinkRecord>;
}

export interface DigestAccessLinkProvider {
  getOrCreateDigestAccessLink(digestId: string, now?: Date): Promise<string>;
}

export class PrismaAccessLinkStore implements AccessLinkStore {
  constructor(private readonly prisma: PrismaClient) {}

  findByDigestId(digestId: string): Promise<AccessLinkRecord | null> {
    return this.prisma.accessLink.findUnique({
      where: { digestId },
      select: { publicId: true, digestId: true, expiresAt: true, createdAt: true },
    });
  }

  create(input: AccessLinkRecord): Promise<AccessLinkRecord> {
    return this.prisma.accessLink.create({
      data: input,
      select: { publicId: true, digestId: true, expiresAt: true, createdAt: true },
    });
  }
}

export class AccessLinkService implements DigestAccessLinkProvider {
  private readonly publicBaseUrl: string;

  constructor(
    private readonly store: AccessLinkStore,
    private readonly options: {
      signingSecret: string;
      publicBaseUrl: string;
      ttlDays: number;
      generatePublicId?: () => string;
    },
  ) {
    assertSigningSecret(options.signingSecret);
    if (!Number.isInteger(options.ttlDays) || options.ttlDays <= 0) {
      throw new Error("LINK_TTL_DAYS_INVALID");
    }
    const url = new URL(options.publicBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("PUBLIC_BASE_URL_INVALID");
    }
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, "");
  }

  async getOrCreateDigestAccessLink(
    digestId: string,
    now = new Date(),
  ): Promise<string> {
    const existing = await this.store.findByDigestId(digestId);
    if (existing) return this.buildUrl(existing);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const createdAt = new Date(now);
      const record: AccessLinkRecord = {
        publicId: (this.options.generatePublicId ?? generatePublicId)(),
        digestId,
        createdAt,
        expiresAt: new Date(
          createdAt.getTime() + this.options.ttlDays * 24 * 60 * 60_000,
        ),
      };
      try {
        return this.buildUrl(await this.store.create(record));
      } catch (error: unknown) {
        if (!isUniqueConstraintError(error)) throw error;
        const concurrent = await this.store.findByDigestId(digestId);
        if (concurrent) return this.buildUrl(concurrent);
      }
    }
    throw new Error("ACCESS_LINK_CREATION_FAILED");
  }

  private buildUrl(record: AccessLinkRecord): string {
    const token = signAccessLink(record, this.options.signingSecret);
    return `${this.publicBaseUrl}/d/${token}`;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" ||
    error instanceof Error && error.message === "ACCESS_LINK_UNIQUE_CONFLICT";
}
