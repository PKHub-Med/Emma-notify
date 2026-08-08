import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type SignedAccessLinkPayload = {
  publicId: string;
  digestId: string;
  expiresAt: Date;
};

export function generatePublicId(): string {
  return randomBytes(18).toString("base64url");
}

export function signAccessLink(
  payload: SignedAccessLinkPayload,
  signingSecret: string,
): string {
  assertSigningSecret(signingSecret);
  const signature = createHmac("sha256", signingSecret)
    .update(canonicalPayload(payload), "utf8")
    .digest("base64url");
  return `${payload.publicId}.${signature}`;
}

export function verifyAccessLinkToken(
  token: string,
  payload: SignedAccessLinkPayload,
  signingSecret: string,
): boolean {
  assertSigningSecret(signingSecret);
  const parsed = parseAccessLinkToken(token);
  if (!parsed || parsed.publicId !== payload.publicId) return false;
  const expected = signAccessLink(payload, signingSecret).split(".")[1];
  if (!expected) return false;
  const actualBuffer = Buffer.from(parsed.signature, "base64url");
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer);
}

export function parseAccessLinkToken(token: string): {
  publicId: string;
  signature: string;
} | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [publicId, signature] = parts;
  if (!publicId || !signature ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(publicId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return null;
  }
  return { publicId, signature };
}

export function assertSigningSecret(signingSecret: string): void {
  if (Buffer.byteLength(signingSecret, "utf8") < 32) {
    throw new Error("ACCESS_LINK_SIGNING_SECRET_INVALID");
  }
}

function canonicalPayload(payload: SignedAccessLinkPayload): string {
  return [
    "emma-access-link-v1",
    payload.publicId,
    payload.digestId,
    payload.expiresAt.toISOString(),
  ].join("\n");
}
