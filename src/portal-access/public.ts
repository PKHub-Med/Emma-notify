import type { PrismaClient } from "../generated/prisma/client.js";
import {
  assertSigningSecret,
  parseAccessLinkToken,
} from "../access-links/token.js";
import { verifyPortalGrantToken } from "./token.js";
import type { PortalEntryContext } from "./service.js";

export type PublicPortalAccessGrant = {
  id: string;
  publicId: string;
  communicationDeliveryId: string;
  sourceHospitalRecordId: string;
  entryContext: PortalEntryContext;
  expiresAt: Date;
  revokedAt: Date | null;
};

export interface PublicPortalAccessStore {
  findByPublicId(publicId: string): Promise<PublicPortalAccessGrant | null>;
  recordValidOpen(grantId: string, now: Date): Promise<boolean>;
}

export class PrismaPublicPortalAccessStore implements PublicPortalAccessStore {
  constructor(private readonly prisma: PrismaClient) {}

  findByPublicId(publicId: string): Promise<PublicPortalAccessGrant | null> {
    return this.prisma.portalAccessGrant.findUnique({
      where: { publicId },
      select: {
        id: true,
        publicId: true,
        communicationDeliveryId: true,
        sourceHospitalRecordId: true,
        entryContext: true,
        expiresAt: true,
        revokedAt: true,
      },
    }) as Promise<PublicPortalAccessGrant | null>;
  }

  async recordValidOpen(grantId: string, now: Date): Promise<boolean> {
    const result = await this.prisma.portalAccessGrant.updateMany({
      where: { id: grantId, revokedAt: null, expiresAt: { gt: now } },
      data: { openCount: { increment: 1 }, lastOpenedAt: now },
    });
    return result.count === 1;
  }
}

export type PortalAuthorizationContext = {
  sourceHospitalRecordId: string;
  entryContext: PortalEntryContext;
};

export type PortalAccessOpenResult =
  | { outcome: "VALID"; authorization: PortalAuthorizationContext }
  | { outcome: "NOT_FOUND" }
  | { outcome: "INACTIVE" };

export class PublicPortalAccessService {
  constructor(
    private readonly store: PublicPortalAccessStore,
    private readonly signingSecret: string,
  ) {
    assertSigningSecret(signingSecret);
  }

  async open(token: string, now = new Date()): Promise<PortalAccessOpenResult> {
    return this.authorize(token, now, true);
  }

  async authorizeData(token: string, now = new Date()): Promise<PortalAccessOpenResult> {
    return this.authorize(token, now, false);
  }

  private async authorize(
    token: string,
    now: Date,
    recordOpen: boolean,
  ): Promise<PortalAccessOpenResult> {
    const parsed = parseAccessLinkToken(token);
    if (!parsed) return { outcome: "NOT_FOUND" };
    const grant = await this.store.findByPublicId(parsed.publicId);
    if (!grant || !verifyPortalGrantToken(token, grant, this.signingSecret)) {
      return { outcome: "NOT_FOUND" };
    }
    if (grant.revokedAt || grant.expiresAt.getTime() <= now.getTime()) {
      return { outcome: "INACTIVE" };
    }
    if (recordOpen && !await this.store.recordValidOpen(grant.id, now)) {
      return { outcome: "INACTIVE" };
    }
    return {
      outcome: "VALID",
      authorization: {
        sourceHospitalRecordId: grant.sourceHospitalRecordId,
        entryContext: grant.entryContext,
      },
    };
  }
}

export function portalEntryPage(): string {
  return messagePage(
    "Bezpieczny dostęp do portalu",
    "Link został poprawnie zweryfikowany. Portal szpitala zostanie udostępniony w kolejnym etapie.",
  );
}

export function linkExpiredPage(): string {
  return messagePage(
    "Ten link wygasł.",
    "Skontaktuj się z Tiemed, aby ponownie uzyskać dostęp.",
  );
}

export function portalNotFoundPage(): string {
  return messagePage("Nie znaleziono strony.", null);
}

function messagePage(title: string, message: string | null): string {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Emma</title><style>body{margin:0;background:#f6f7f8;color:#17212b;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.wrap{max-width:680px;margin:auto;padding:72px 20px}h1{font-size:clamp(28px,6vw,40px)}p{color:#667085;font-size:17px;line-height:1.6}</style></head><body><main class="wrap"><h1>${escapeHtml(title)}</h1>${message ? `<p>${escapeHtml(message)}</p>` : ""}</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
