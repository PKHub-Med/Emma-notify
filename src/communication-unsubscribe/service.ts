import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { CommunicationDeliveryStatus, CommunicationRecipientType } from "../generated/prisma/enums.js";
import { assertSigningSecret, generatePublicId } from "../access-links/token.js";
import { signUnsubscribeToken, type UnsubscribeTokenPayload } from "./token.js";

export type UnsubscribeGrantRecord = UnsubscribeTokenPayload & { createdAt: Date };
type DeliverySource = { id: string; status: CommunicationDeliveryStatus; recipientType: CommunicationRecipientType; normalizedEmail: string | null; eventSnapshot: unknown };

export interface UnsubscribeGrantStore {
  findDelivery(id: string): Promise<DeliverySource | null>;
  findByDeliveryId(id: string): Promise<UnsubscribeGrantRecord | null>;
  create(record: UnsubscribeGrantRecord): Promise<UnsubscribeGrantRecord>;
}

export class PrismaUnsubscribeGrantStore implements UnsubscribeGrantStore {
  constructor(private readonly prisma: PrismaClient) {}
  async findDelivery(id: string): Promise<DeliverySource | null> {
    const row = await this.prisma.communicationDelivery.findUnique({ where: { id }, select: {
      id: true, status: true, communicationEvent: { select: { eventSnapshot: true } },
      communicationEventRecipient: { select: { recipientType: true, normalizedEmail: true } },
    } });
    return row ? { id: row.id, status: row.status, eventSnapshot: row.communicationEvent.eventSnapshot, ...row.communicationEventRecipient } : null;
  }
  findByDeliveryId(id: string) { return this.prisma.communicationUnsubscribeGrant.findUnique({ where: { communicationDeliveryId: id } }); }
  create(record: UnsubscribeGrantRecord) { return this.prisma.communicationUnsubscribeGrant.create({ data: record }); }
}

export class CommunicationUnsubscribeGrantService {
  private readonly baseUrl: string;
  constructor(private readonly store: UnsubscribeGrantStore, private readonly options: { signingSecret: string; publicBaseUrl: string; ttlDays: number; generatePublicId?: () => string }) {
    assertSigningSecret(options.signingSecret);
    this.baseUrl = options.publicBaseUrl.replace(/\/+$/, "");
  }
  async getOrCreateUnsubscribeGrant(deliveryId: string, now = new Date()) {
    const existing = await this.store.findByDeliveryId(deliveryId);
    if (existing) return this.result(existing);
    const delivery = await this.store.findDelivery(deliveryId);
    if (!delivery) throw new Error("COMMUNICATION_DELIVERY_NOT_FOUND");
    if (delivery.status !== CommunicationDeliveryStatus.READY &&
        delivery.status !== CommunicationDeliveryStatus.SENDING) {
      throw new Error("COMMUNICATION_DELIVERY_NOT_READY");
    }
    const hospital = snapshotString(delivery.eventSnapshot, "sourceHospitalRecordId");
    if (!hospital) throw new Error("MISSING_HOSPITAL_SCOPE");
    const record: UnsubscribeGrantRecord = {
      publicId: (this.options.generatePublicId ?? generatePublicId)(), communicationDeliveryId: delivery.id,
      sourceHospitalRecordId: hospital, normalizedEmail: delivery.normalizedEmail,
      canOptOut: delivery.recipientType === CommunicationRecipientType.CLIENT && Boolean(delivery.normalizedEmail),
      createdAt: new Date(now), expiresAt: new Date(now.getTime() + this.options.ttlDays * 86_400_000),
    };
    try { return this.result(await this.store.create(record)); }
    catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      const concurrent = await this.store.findByDeliveryId(delivery.id);
      if (!concurrent) throw error;
      return this.result(concurrent);
    }
  }
  private result(grant: UnsubscribeGrantRecord) {
    const token = signUnsubscribeToken(grant, this.options.signingSecret);
    return { grant, url: `${this.baseUrl}/u/${token}` };
  }
}

function snapshotString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}
