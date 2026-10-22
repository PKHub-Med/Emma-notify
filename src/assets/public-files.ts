import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  AssetProcessingStatus,
  PortalAccessLevel,
  StoredFileKind,
} from "../generated/prisma/enums.js";
import type { PortalAuthorizationContext } from "../portal-access/public.js";
import type { PortalAccessPolicy } from "../portal-access/policy.js";
import { visibleCaseSql } from "../portal-access/policy.js";
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
): Prisma.CaseAssetWhereInput {
  return {
    active: true,
    sourceHospitalRecordId: scope.hospitalId,
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
    const asset = await this.prisma.caseAsset.findUnique({
      where: { id: assetId },
      select: {
        active: true,
        sourceRecordId: true,
        sourceEntityType: true,
        sourceHospitalRecordId: true,
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
    if (asset.sourceHospitalRecordId !== access.hospitalId ||
      asset.storedFile.sourceHospitalRecordId !== access.hospitalId) {
      return { asset: null, reason: "HOSPITAL_SCOPE_MISMATCH" };
    }
    if (asset.storedFile.processingStatus !== AssetProcessingStatus.READY) {
      return { asset: null, reason: "NOT_READY" };
    }
    if (!asset.active || asset.storedFile.orphanedAt !== null) {
      return { asset: null, reason: "ORPHANED" };
    }
    if (access.accessLevel === PortalAccessLevel.COMMUNICATION) {
      const caseType = asset.sourceEntityType === "SERVICE_ORDER" ? "SERVICE_ORDER"
        : asset.sourceEntityType === "INSPECTION" ? "INSPECTION" : null;
      if (!caseType || !await this.isVisibleCommunicationCase(
        access.hospitalId, authorization.communicationDeliveryId,
        caseType, asset.sourceRecordId,
      )) return { asset: null, reason: "ACCESS_POLICY_DENIED" };
    }
    const { processingStatus: _processingStatus, orphanedAt: _orphanedAt,
      sourceHospitalRecordId: _sourceHospitalRecordId, ...publicAsset } = asset.storedFile;
    return { asset: publicAsset, reason: null };
  }

  private async isVisibleCommunicationCase(
    hospitalId: string,
    communicationDeliveryId: string,
    caseType: "SERVICE_ORDER" | "INSPECTION",
    sourceRecordId: string,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT c.id FROM "TrackedCase" c
      WHERE c.active = true
        AND c."sourceHospitalRecordId" = ${hospitalId}
        AND c."caseType" = CAST(${caseType} AS "CaseType")
        AND c."airtableRecordId" = ${sourceRecordId}
        ${visibleCaseSql({
          hospitalId,
          accessLevel: PortalAccessLevel.COMMUNICATION,
          communicationDeliveryId,
        }, caseType)}
      LIMIT 1
    `);
    return rows.length === 1;
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
