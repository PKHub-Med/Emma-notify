import type { PrismaClient } from "../generated/prisma/client.js";
import { verifyUnsubscribeToken, type UnsubscribeTokenPayload } from "./token.js";

export interface PublicUnsubscribeStore {
  findByPublicId(id: string): Promise<UnsubscribeTokenPayload | null>;
  optOut(hospital: string, email: string): Promise<void>;
}
export class PrismaPublicUnsubscribeStore implements PublicUnsubscribeStore {
  constructor(private readonly prisma: PrismaClient) {}
  findByPublicId(id: string) { return this.prisma.communicationUnsubscribeGrant.findUnique({ where: { publicId: id } }); }
  async optOut(sourceHospitalRecordId: string, normalizedEmail: string) {
    await this.prisma.communicationOptOut.upsert({
      where: { sourceHospitalRecordId_normalizedEmail: { sourceHospitalRecordId, normalizedEmail } },
      create: { sourceHospitalRecordId, normalizedEmail }, update: {},
    });
  }
}

export class PublicUnsubscribeService {
  constructor(private readonly store: PublicUnsubscribeStore, private readonly secret: string, private readonly now = () => new Date()) {}
  async inspect(token: string) { return this.resolve(token); }
  async confirm(token: string) {
    const grant = await this.resolve(token);
    if (!grant || !grant.canOptOut || !grant.normalizedEmail) return grant ? "NOT_ALLOWED" as const : "NOT_FOUND" as const;
    await this.store.optOut(grant.sourceHospitalRecordId, grant.normalizedEmail);
    return "OPTED_OUT" as const;
  }
  private async resolve(token: string) {
    const publicId = token.split(".", 1)[0] ?? "";
    const grant = await this.store.findByPublicId(publicId);
    if (!grant || grant.expiresAt <= this.now() || !verifyUnsubscribeToken(token, grant, this.secret)) return null;
    return grant;
  }
}

export const unsubscribePage = (canOptOut: boolean) => `<!doctype html><html lang="pl"><meta charset="utf-8"><title>Rezygnacja z powiadomień</title><body><main><h1>Rezygnacja z powiadomień</h1>${canOptOut ? '<p>Potwierdź rezygnację dla tego adresu.</p><form method="post"><button type="submit">Potwierdzam rezygnację</button></form>' : '<p>Systemowych powiadomień Tiemed nie można wyłączyć.</p>'}</main></body></html>`;
export const unsubscribeDonePage = () => `<!doctype html><html lang="pl"><meta charset="utf-8"><title>Rezygnacja zapisana</title><body><main><h1>Rezygnacja zapisana</h1><p>Nie będziemy wysyłać kolejnych powiadomień na ten adres dla tej placówki.</p></main></body></html>`;
