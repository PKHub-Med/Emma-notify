import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationDeliveryStatus,
  CommunicationSourceEntityType,
  type CommunicationScenario,
} from "../generated/prisma/enums.js";
import {
  assertSigningSecret,
  generatePublicId,
} from "../access-links/token.js";
import { signPortalGrantToken } from "./token.js";

export type PortalEntryContext = {
  type: "SERVICE_ORDER" | "TASK";
  sourceRecordId: string;
  scenario: CommunicationScenario;
  linkedInspectionRecordIds?: string[];
  linkedServiceOrderRecordIds?: string[];
};

export type PortalAccessGrantRecord = {
  publicId: string;
  communicationDeliveryId: string;
  sourceHospitalRecordId: string;
  entryContext: PortalEntryContext;
  expiresAt: Date;
  createdAt: Date;
};

export type PortalDeliverySource = {
  id: string;
  status: CommunicationDeliveryStatus;
  event: {
    sourceEntityType: CommunicationSourceEntityType;
    sourceRecordId: string;
    scenario: CommunicationScenario;
    eventSnapshot: unknown;
  };
};

export interface PortalAccessGrantStore {
  findDelivery(deliveryId: string): Promise<PortalDeliverySource | null>;
  findByDeliveryId(deliveryId: string): Promise<PortalAccessGrantRecord | null>;
  create(record: PortalAccessGrantRecord): Promise<PortalAccessGrantRecord>;
}

export class PrismaPortalAccessGrantStore implements PortalAccessGrantStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findDelivery(deliveryId: string): Promise<PortalDeliverySource | null> {
    const delivery = await this.prisma.communicationDelivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true,
        status: true,
        communicationEvent: {
          select: {
            sourceEntityType: true,
            sourceRecordId: true,
            scenario: true,
            eventSnapshot: true,
          },
        },
      },
    });
    return delivery ? {
      id: delivery.id,
      status: delivery.status,
      event: delivery.communicationEvent,
    } : null;
  }

  findByDeliveryId(deliveryId: string): Promise<PortalAccessGrantRecord | null> {
    return this.prisma.portalAccessGrant.findUnique({
      where: { communicationDeliveryId: deliveryId },
      select: {
        publicId: true,
        communicationDeliveryId: true,
        sourceHospitalRecordId: true,
        entryContext: true,
        expiresAt: true,
        createdAt: true,
      },
    }) as unknown as Promise<PortalAccessGrantRecord | null>;
  }

  create(record: PortalAccessGrantRecord): Promise<PortalAccessGrantRecord> {
    return this.prisma.portalAccessGrant.create({
      data: {
        ...record,
        entryContext: record.entryContext as Prisma.InputJsonObject,
      },
      select: {
        publicId: true,
        communicationDeliveryId: true,
        sourceHospitalRecordId: true,
        entryContext: true,
        expiresAt: true,
        createdAt: true,
      },
    }) as unknown as Promise<PortalAccessGrantRecord>;
  }
}

export class PortalAccessGrantService {
  private readonly publicBaseUrl: string;

  constructor(
    private readonly store: PortalAccessGrantStore,
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

  async getOrCreatePortalAccessGrant(
    deliveryId: string,
    now = new Date(),
  ): Promise<{ grant: PortalAccessGrantRecord; url: string }> {
    const existing = await this.store.findByDeliveryId(deliveryId);
    if (existing) return this.result(existing);

    const delivery = await this.store.findDelivery(deliveryId);
    if (!delivery) throw new Error("COMMUNICATION_DELIVERY_NOT_FOUND");
    if (delivery.status !== CommunicationDeliveryStatus.READY &&
      delivery.status !== CommunicationDeliveryStatus.SENDING) {
      throw new Error("COMMUNICATION_DELIVERY_NOT_READY");
    }
    const sourceHospitalRecordId = stringFromSnapshot(
      delivery.event.eventSnapshot,
      "sourceHospitalRecordId",
    );
    if (!sourceHospitalRecordId) throw new Error("MISSING_HOSPITAL_SCOPE");
    const entryContext = buildEntryContext(delivery);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const createdAt = new Date(now);
      const record: PortalAccessGrantRecord = {
        publicId: (this.options.generatePublicId ?? generatePublicId)(),
        communicationDeliveryId: delivery.id,
        sourceHospitalRecordId,
        entryContext,
        createdAt,
        expiresAt: new Date(
          createdAt.getTime() + this.options.ttlDays * 24 * 60 * 60_000,
        ),
      };
      try {
        return this.result(await this.store.create(record));
      } catch (error: unknown) {
        if (!isUniqueConstraintError(error)) throw error;
        const concurrent = await this.store.findByDeliveryId(delivery.id);
        if (concurrent) return this.result(concurrent);
      }
    }
    throw new Error("PORTAL_ACCESS_GRANT_CREATION_FAILED");
  }

  private result(grant: PortalAccessGrantRecord) {
    const token = signPortalGrantToken(grant, this.options.signingSecret);
    return { grant, url: `${this.publicBaseUrl}/p/${token}` };
  }
}

function buildEntryContext(delivery: PortalDeliverySource): PortalEntryContext {
  const base = {
    type: delivery.event.sourceEntityType,
    sourceRecordId: delivery.event.sourceRecordId,
    scenario: delivery.event.scenario,
  } as const;
  if (delivery.event.sourceEntityType === CommunicationSourceEntityType.SERVICE_ORDER) {
    return base;
  }
  return {
    ...base,
    linkedInspectionRecordIds: stringArrayFromSnapshot(
      delivery.event.eventSnapshot,
      "linkedInspectionRecordIds",
    ),
    linkedServiceOrderRecordIds: stringArrayFromSnapshot(
      delivery.event.eventSnapshot,
      "linkedServiceOrderRecordIds",
    ),
  };
}

function stringFromSnapshot(snapshot: unknown, key: string): string | null {
  if (!isObject(snapshot)) return null;
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArrayFromSnapshot(snapshot: unknown, key: string): string[] {
  if (!isObject(snapshot) || !Array.isArray(snapshot[key])) return [];
  return [...new Set(snapshot[key].filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0))];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
    (error instanceof Error && error.message === "PORTAL_ACCESS_GRANT_UNIQUE_CONFLICT");
}
