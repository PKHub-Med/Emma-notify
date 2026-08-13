import {
  signHmacBearerToken,
  verifyHmacBearerToken,
} from "../access-links/token.js";

export type PortalGrantTokenPayload = {
  publicId: string;
  communicationDeliveryId: string;
  sourceHospitalRecordId: string;
  entryContext: {
    type: "SERVICE_ORDER" | "TASK";
    sourceRecordId: string;
  };
  expiresAt: Date;
};

export function signPortalGrantToken(
  payload: PortalGrantTokenPayload,
  signingSecret: string,
): string {
  return signHmacBearerToken(
    payload.publicId,
    canonicalPortalPayload(payload),
    signingSecret,
  );
}

export function verifyPortalGrantToken(
  token: string,
  payload: PortalGrantTokenPayload,
  signingSecret: string,
): boolean {
  return verifyHmacBearerToken(
    token,
    payload.publicId,
    canonicalPortalPayload(payload),
    signingSecret,
  ) || verifyHmacBearerToken(
    token,
    payload.publicId,
    legacyCanonicalPortalPayload(payload),
    signingSecret,
  );
}

function canonicalPortalPayload(payload: PortalGrantTokenPayload): string {
  return [
    "emma-portal-access-grant-v2",
    payload.publicId,
    payload.communicationDeliveryId,
    payload.sourceHospitalRecordId,
    payload.entryContext.type === "SERVICE_ORDER" ? "REPAIR" : "INSPECTION_TASK",
    payload.entryContext.sourceRecordId,
    payload.expiresAt.toISOString(),
  ].join("\n");
}

function legacyCanonicalPortalPayload(payload: PortalGrantTokenPayload): string {
  return [
    "emma-portal-access-grant-v1",
    payload.publicId,
    payload.communicationDeliveryId,
    payload.sourceHospitalRecordId,
    payload.expiresAt.toISOString(),
  ].join("\n");
}
