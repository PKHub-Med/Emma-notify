import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  AssetProcessingStatus,
  CommunicationDeliveryStatus,
  PortalAccessLevel,
  StoredFileKind,
} from "../generated/prisma/enums.js";
import type { PortalAuthorizationContext } from "../portal-access/public.js";
import type { PortalAccessPolicy } from "../portal-access/policy.js";
import type { ObjectStorage } from "./object-storage.js";

export type PublicAssetVariant = "portal" | "thumb" | "document";

export type PublicAssetObject = {
  kind: StoredFileKind;
  portalObjectKey: string | null;
  thumbnailObjectKey: string | null;
  documentObjectKey: string | null;
};

export type PublicAssetDenialReason =
  | "ASSET_NOT_FOUND"
  | "GRANT_DELIVERY_MISMATCH"
  | "HOSPITAL_SCOPE_MISMATCH"
  | "NOT_EXPOSED"
  | "NOT_READY"
  | "ORPHANED"
  | "ACCESS_POLICY_DENIED"
  | "VARIANT_NOT_FOUND"
  | "FILE_SERVICE_UNAVAILABLE";

export type PublicAssetAuthorization =
  | { asset: PublicAssetObject; reason: null }
  | { asset: null; reason: PublicAssetDenialReason };

export interface PublicAssetStore {
  findAuthorized(
    assetId: string,
    authorization: PortalAuthorizationContext,
  ): Promise<PublicAssetObject | null>;
  authorize?(
    assetId: string,
    authorization: PortalAuthorizationContext,
  ): Promise<PublicAssetAuthorization>;
}

export type PublicAssetAccessScope = {
  hospitalId: string;
  accessLevel: PortalAccessLevel;
  communicationDeliveryId: string;
  communicationBatchMessageId?: string | null;
};

/** One shared predicate for file redirects, case assets and the Documents tab. */
export function publicAssetAccessWhere(
  scope: PublicAssetAccessScope,
): Prisma.CommunicationAssetWhereInput {
  const communicationOnly = scope.accessLevel === PortalAccessLevel.COMMUNICATION;
  return {
    ...(communicationOnly ? {
      exposedAt: { not: null },
      OR: [
        {
          deliveryId: scope.communicationDeliveryId,
          delivery: {
            status: CommunicationDeliveryStatus.SENT,
            communicationEvent: {
              eventSnapshot: { path: ["sourceHospitalRecordId"], equals: scope.hospitalId },
            },
          },
        },
        ...(scope.communicationBatchMessageId ? [{
          delivery: {
            status: CommunicationDeliveryStatus.SENT,
            resendMessageId: scope.communicationBatchMessageId,
            communicationEvent: {
              eventSnapshot: { path: ["sourceHospitalRecordId"], equals: scope.hospitalId },
            },
          },
        }] : []),
      ],
    } : {}),
    storedFile: {
      processingStatus: AssetProcessingStatus.READY,
      orphanedAt: null,
      sourceHospitalRecordId: scope.hospitalId,
    },
  };
}

export class PrismaPublicAssetStore implements PublicAssetStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly accessPolicy: PortalAccessPolicy,
  ) {}

  async findAuthorized(assetId: string, authorization: PortalAuthorizationContext) {
    return (await this.authorize(assetId, authorization)).asset;
  }

  async authorize(
    assetId: string,
    authorization: PortalAuthorizationContext,
  ): Promise<PublicAssetAuthorization> {
    const access = await this.accessPolicy.resolve(authorization.sourceHospitalRecordId);
    const asset = await this.prisma.communicationAsset.findUnique({
      where: { id: assetId },
      select: {
        deliveryId: true,
        exposedAt: true,
        delivery: {
          select: {
            status: true,
            resendMessageId: true,
            communicationEventRecipient: { select: { recipientType: true } },
            communicationEvent: { select: { eventSnapshot: true } },
          },
        },
        storedFile: {
          select: {
            processingStatus: true,
            orphanedAt: true,
            sourceHospitalRecordId: true,
            kind: true,
            portalObjectKey: true,
            thumbnailObjectKey: true,
            documentObjectKey: true,
          },
        },
      },
    });
    if (!asset) return { asset: null, reason: "ASSET_NOT_FOUND" };
    if (asset.storedFile.sourceHospitalRecordId !== access.hospitalId) {
      return { asset: null, reason: "HOSPITAL_SCOPE_MISMATCH" };
    }
    if (asset.storedFile.processingStatus !== AssetProcessingStatus.READY) {
      return { asset: null, reason: "NOT_READY" };
    }
    if (asset.storedFile.orphanedAt !== null) {
      return { asset: null, reason: "ORPHANED" };
    }
    if (access.accessLevel === PortalAccessLevel.COMMUNICATION) {
      if (asset.exposedAt === null) return { asset: null, reason: "NOT_EXPOSED" };
      const eventHospital = snapshotHospital(asset.delivery.communicationEvent.eventSnapshot);
      if (eventHospital !== access.hospitalId) {
        return { asset: null, reason: "HOSPITAL_SCOPE_MISMATCH" };
      }
      const sent = asset.delivery.status === CommunicationDeliveryStatus.SENT;
      const exactGrantDelivery = asset.deliveryId === authorization.communicationDeliveryId;
      const grantDelivery = await this.prisma.communicationDelivery?.findUnique({
        where: { id: authorization.communicationDeliveryId },
        select: { resendMessageId: true, status: true },
      });
      const sameBatch = Boolean(grantDelivery?.status === CommunicationDeliveryStatus.SENT &&
        grantDelivery.resendMessageId &&
        grantDelivery.resendMessageId === asset.delivery.resendMessageId);
      if (!sent) return { asset: null, reason: "ACCESS_POLICY_DENIED" };
      if (!exactGrantDelivery && !sameBatch) {
        return { asset: null, reason: "GRANT_DELIVERY_MISMATCH" };
      }
    }
    const { processingStatus: _processingStatus, orphanedAt: _orphanedAt,
      sourceHospitalRecordId: _sourceHospitalRecordId, ...publicAsset } = asset.storedFile;
    return { asset: publicAsset, reason: null };
  }
}

export interface PublicFileService {
  signedUrl(
    authorization: PortalAuthorizationContext,
    assetId: string,
    variant: PublicAssetVariant,
  ): Promise<string | null>;
  resolve?(
    authorization: PortalAuthorizationContext,
    assetId: string,
    variant: PublicAssetVariant,
  ): Promise<{ url: string | null; reason: PublicAssetDenialReason | null }>;
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
    return (await this.resolve(authorization, assetId, variant)).url;
  }

  async resolve(
    authorization: PortalAuthorizationContext,
    assetId: string,
    variant: PublicAssetVariant,
  ): Promise<{ url: string | null; reason: PublicAssetDenialReason | null }> {
    const authorizationResult = this.store.authorize
      ? await this.store.authorize(assetId, authorization)
      : { asset: await this.store.findAuthorized(assetId, authorization), reason: "ACCESS_POLICY_DENIED" as const };
    const asset = authorizationResult.asset;
    if (!asset) return { url: null, reason: authorizationResult.reason };
    const key = selectKey(asset, variant);
    if (!key) return { url: null, reason: "VARIANT_NOT_FOUND" };
    if (!await this.storage.headObject(key)) return { url: null, reason: "VARIANT_NOT_FOUND" };
    return {
      url: await this.storage.getSignedDownloadUrl(key, this.signedUrlSeconds),
      reason: null,
    };
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

function snapshotHospital(snapshot: unknown): string | null {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>).sourceHospitalRecordId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
