import type { PrismaClient } from "../generated/prisma/client.js";
import { AssetProcessingStatus, StoredFileKind } from "../generated/prisma/enums.js";
import type { PortalAuthorizationContext } from "../portal-access/public.js";
import type { ObjectStorage } from "./object-storage.js";

export type PublicAssetVariant = "portal" | "thumb" | "document";

export type PublicAssetObject = {
  kind: StoredFileKind;
  portalObjectKey: string | null;
  thumbnailObjectKey: string | null;
  documentObjectKey: string | null;
};

export interface PublicAssetStore {
  findAuthorized(
    assetId: string,
    authorization: PortalAuthorizationContext,
  ): Promise<PublicAssetObject | null>;
}

export class PrismaPublicAssetStore implements PublicAssetStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findAuthorized(assetId: string, authorization: PortalAuthorizationContext) {
    const asset = await this.prisma.communicationAsset.findFirst({
      where: {
        id: assetId,
        deliveryId: authorization.communicationDeliveryId,
        exposedAt: { not: null },
        storedFile: {
          processingStatus: AssetProcessingStatus.READY,
          orphanedAt: null,
          sourceHospitalRecordId: authorization.sourceHospitalRecordId,
        },
      },
      select: {
        storedFile: {
          select: {
            kind: true,
            portalObjectKey: true,
            thumbnailObjectKey: true,
            documentObjectKey: true,
          },
        },
      },
    });
    return asset?.storedFile ?? null;
  }
}

export interface PublicFileService {
  signedUrl(
    authorization: PortalAuthorizationContext,
    assetId: string,
    variant: PublicAssetVariant,
  ): Promise<string | null>;
}

export class StoredPublicFileService implements PublicFileService {
  constructor(
    private readonly store: PublicAssetStore,
    private readonly storage: ObjectStorage,
    private readonly signedUrlSeconds: number,
  ) {}

  async signedUrl(
    authorization: PortalAuthorizationContext,
    assetId: string,
    variant: PublicAssetVariant,
  ): Promise<string | null> {
    const asset = await this.store.findAuthorized(assetId, authorization);
    if (!asset) return null;
    const key = selectKey(asset, variant);
    if (!key) return null;
    return this.storage.getSignedDownloadUrl(key, this.signedUrlSeconds);
  }
}

function selectKey(asset: PublicAssetObject, variant: PublicAssetVariant): string | null {
  if (asset.kind === StoredFileKind.IMAGE) {
    if (variant === "portal") return asset.portalObjectKey;
    if (variant === "thumb") return asset.thumbnailObjectKey;
    return null;
  }
  return variant === "document" ? asset.documentObjectKey : null;
}
