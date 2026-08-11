import { signHmacBearerToken, verifyHmacBearerToken } from "../access-links/token.js";

export type UnsubscribeTokenPayload = {
  publicId: string;
  communicationDeliveryId: string;
  sourceHospitalRecordId: string;
  normalizedEmail: string | null;
  canOptOut: boolean;
  expiresAt: Date;
};

function canonical(payload: UnsubscribeTokenPayload): string {
  return ["emma-communication-unsubscribe-v1", payload.publicId, payload.communicationDeliveryId,
    payload.sourceHospitalRecordId, payload.normalizedEmail ?? "", String(payload.canOptOut),
    payload.expiresAt.toISOString()].join("\n");
}

export function signUnsubscribeToken(payload: UnsubscribeTokenPayload, secret: string): string {
  return signHmacBearerToken(payload.publicId, canonical(payload), secret);
}

export function verifyUnsubscribeToken(token: string, payload: UnsubscribeTokenPayload, secret: string): boolean {
  return verifyHmacBearerToken(token, payload.publicId, canonical(payload), secret);
}
