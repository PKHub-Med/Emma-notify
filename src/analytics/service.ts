import type { PrismaClient } from "../generated/prisma/client.js";
import type { PortalAuthorizationContext } from "../portal-access/public.js";

export const PORTAL_ANALYTICS_EVENT_TYPES = [
  "PORTAL_VIEW_CONFIRMED", "SCREEN_VIEW", "UPGRADE_CLICK",
] as const;
export type PortalAnalyticsEventType = typeof PORTAL_ANALYTICS_EVENT_TYPES[number];

export type PortalAnalyticsInput = {
  eventType: PortalAnalyticsEventType;
  sessionId: string;
  screen?: string;
  entityType?: "CASE" | "DEVICE";
  entityRecordId?: string;
};

export interface PortalAnalyticsWriter {
  recordLinkClick(authorization: PortalAuthorizationContext): Promise<void>;
  recordPortalEvent(
    authorization: PortalAuthorizationContext,
    input: PortalAnalyticsInput,
  ): Promise<void>;
}

export class PrismaPortalAnalyticsWriter implements PortalAnalyticsWriter {
  constructor(private readonly prisma: PrismaClient) {}

  async recordLinkClick(authorization: PortalAuthorizationContext): Promise<void> {
    await this.prisma.analyticsEvent.create({ data: {
      eventType: "EMAIL_LINK_CLICK",
      portalAccessGrantId: authorization.portalAccessGrantId,
      communicationDeliveryId: authorization.communicationDeliveryId,
      sourceHospitalRecordId: authorization.sourceHospitalRecordId,
      metadata: { ctaId: "portal" },
    } });
  }

  async recordPortalEvent(
    authorization: PortalAuthorizationContext,
    input: PortalAnalyticsInput,
  ): Promise<void> {
    await this.prisma.analyticsEvent.create({ data: {
      eventType: input.eventType,
      sessionId: input.sessionId,
      portalAccessGrantId: authorization.portalAccessGrantId,
      communicationDeliveryId: authorization.communicationDeliveryId,
      sourceHospitalRecordId: authorization.sourceHospitalRecordId,
      ...(input.screen ? { screen: input.screen } : {}),
      ...(input.entityType ? { entityType: input.entityType } : {}),
      ...(input.entityRecordId ? { entityRecordId: input.entityRecordId } : {}),
    } });
  }
}

export type AnalyticsFilters = {
  from: Date;
  to: Date;
  mode: "PRODUCTION" | "TEST" | "ALL";
  scenario?: string;
  hospitalId?: string;
};

type DeliveryRow = Awaited<ReturnType<PrismaAnalyticsAdminService["loadDeliveries"]>>[number];

export class PrismaAnalyticsAdminService {
  constructor(private readonly prisma: PrismaClient) {}

  private async hospitalNames(ids: string[]): Promise<Map<string, { name: string; location: string | null }>> {
    const rows = await this.prisma.trackedHospital.findMany({
      where: { airtableRecordId: { in: ids } },
      select: { airtableRecordId: true, shortName: true, name: true, address: true },
    });
    return new Map(rows.map((row) => [row.airtableRecordId, {
      name: row.shortName || row.name || row.airtableRecordId,
      location: row.name && row.name !== row.shortName ? row.name : row.address,
    }]));
  }

  async loadDeliveries(filters: AnalyticsFilters) {
    return this.prisma.communicationDelivery.findMany({
      where: {
        status: "SENT",
        sentAt: { gte: filters.from, lte: filters.to },
        ...(filters.mode === "ALL" ? {} : { emailMode: filters.mode }),
        ...(filters.scenario ? { scenario: filters.scenario as never } : {}),
        ...(filters.hospitalId ? { portalAccessGrant: {
          sourceHospitalRecordId: filters.hospitalId,
        } } : {}),
      },
      select: {
        id: true, sentAt: true, scenario: true, emailMode: true,
        actualRecipientEmail: true,
        communicationEventRecipient: { select: { email: true, normalizedEmail: true } },
        portalAccessGrant: { select: { sourceHospitalRecordId: true } },
        analyticsEvents: {
          where: { createdAt: { gte: filters.from, lte: filters.to } },
          select: {
            id: true, createdAt: true, eventType: true, sessionId: true,
            screen: true, entityType: true, entityRecordId: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { sentAt: "desc" },
      take: 2000,
    });
  }

  private async enriched(filters: AnalyticsFilters) {
    const deliveries = await this.loadDeliveries(filters);
    const ids = [...new Set(deliveries.flatMap((row) =>
      row.portalAccessGrant ? [row.portalAccessGrant.sourceHospitalRecordId] : []))];
    const names = await this.hospitalNames(ids);
    return { deliveries, names };
  }

  async summary(filters: AnalyticsFilters) {
    const { deliveries, names } = await this.enriched(filters);
    const has = (row: DeliveryRow, type: string) => row.analyticsEvents.some((event) => event.eventType === type);
    const confirmedHospitals = new Set(deliveries.filter((row) => has(row, "PORTAL_VIEW_CONFIRMED"))
      .flatMap((row) => row.portalAccessGrant ? [row.portalAccessGrant.sourceHospitalRecordId] : []));
    const engaged = deliveries.filter((row) => new Set(row.analyticsEvents
      .filter((event) => event.eventType === "SCREEN_VIEW" && event.screen)
      .map((event) => event.screen)).size >= 2).length;
    const hospitals = aggregateHospitals(deliveries, names);
    const activity = mapActivity(deliveries, names).slice(0, 8);
    return {
      filter: serializeFilter(filters),
      kpis: {
        sent: deliveries.length,
        linkClicked: deliveries.filter((row) => has(row, "EMAIL_LINK_CLICK")).length,
        portalConfirmed: deliveries.filter((row) => has(row, "PORTAL_VIEW_CONFIRMED")).length,
        activeHospitals: confirmedHospitals.size,
        upgradeClicked: deliveries.filter((row) => has(row, "UPGRADE_CLICK")).length,
      },
      funnel: {
        sent: deliveries.length,
        linkClicked: deliveries.filter((row) => has(row, "EMAIL_LINK_CLICK")).length,
        portalConfirmed: deliveries.filter((row) => has(row, "PORTAL_VIEW_CONFIRMED")).length,
        twoScreens: engaged,
        upgradeClicked: deliveries.filter((row) => has(row, "UPGRADE_CLICK")).length,
      },
      hospitals,
      activity,
    };
  }

  async hospitals(filters: AnalyticsFilters) {
    const { deliveries, names } = await this.enriched(filters);
    return { filter: serializeFilter(filters), hospitals: aggregateHospitals(deliveries, names) };
  }

  async hospital(filters: AnalyticsFilters, hospitalId: string) {
    const scoped = { ...filters, hospitalId };
    const { deliveries, names } = await this.enriched(scoped);
    const hospital = aggregateHospitals(deliveries, names)[0] ?? {
      id: hospitalId, name: names.get(hospitalId)?.name ?? hospitalId,
      location: names.get(hospitalId)?.location ?? null, mails: 0, link: 0,
      portal: 0, screens: 0, upgrade: 0, lastActivity: null,
    };
    const screenCounts = new Map<string, number>();
    for (const event of deliveries.flatMap((row) => row.analyticsEvents)) {
      if (event.eventType === "SCREEN_VIEW" && event.screen) {
        screenCounts.set(event.screen, (screenCounts.get(event.screen) ?? 0) + 1);
      }
    }
    return {
      filter: serializeFilter(scoped), hospital,
      screens: [...screenCounts].map(([screen, views]) => ({ screen, views }))
        .sort((a, b) => b.views - a.views),
      deliveries: mapDeliveries(deliveries, names),
      activity: mapActivity(deliveries, names),
    };
  }

  async deliveries(filters: AnalyticsFilters) {
    const { deliveries, names } = await this.enriched(filters);
    return { filter: serializeFilter(filters), deliveries: mapDeliveries(deliveries, names) };
  }

  async activity(filters: AnalyticsFilters) {
    const { deliveries, names } = await this.enriched(filters);
    return { filter: serializeFilter(filters), activity: mapActivity(deliveries, names) };
  }
}

function aggregateHospitals(deliveries: DeliveryRow[], names: Map<string, { name: string; location: string | null }>) {
  const rows = new Map<string, ReturnType<typeof emptyHospital>>();
  for (const delivery of deliveries) {
    const id = delivery.portalAccessGrant?.sourceHospitalRecordId;
    if (!id) continue;
    const row = rows.get(id) ?? emptyHospital(id, names);
    row.mails += 1;
    if (delivery.analyticsEvents.some((event) => event.eventType === "EMAIL_LINK_CLICK")) row.link += 1;
    if (delivery.analyticsEvents.some((event) => event.eventType === "PORTAL_VIEW_CONFIRMED")) row.portal += 1;
    if (delivery.analyticsEvents.some((event) => event.eventType === "UPGRADE_CLICK")) row.upgrade += 1;
    row.screens += delivery.analyticsEvents.filter((event) => event.eventType === "SCREEN_VIEW").length;
    for (const event of delivery.analyticsEvents) {
      if (!row.lastActivity || event.createdAt > row.lastActivity) row.lastActivity = event.createdAt;
    }
    rows.set(id, row);
  }
  return [...rows.values()].sort((a, b) => (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0));
}

function emptyHospital(id: string, names: Map<string, { name: string; location: string | null }>) {
  return { id, name: names.get(id)?.name ?? id, location: names.get(id)?.location ?? null,
    mails: 0, link: 0, portal: 0, screens: 0, upgrade: 0, lastActivity: null as Date | null };
}

function mapDeliveries(deliveries: DeliveryRow[], names: Map<string, { name: string; location: string | null }>) {
  return deliveries.map((row) => {
    const hospitalId = row.portalAccessGrant?.sourceHospitalRecordId ?? null;
    const screens = [...new Set(row.analyticsEvents.filter((event) => event.eventType === "SCREEN_VIEW")
      .flatMap((event) => event.screen ? [event.screen] : []))];
    return {
      id: row.id, sentAt: row.sentAt, hospitalId,
      hospitalName: hospitalId ? names.get(hospitalId)?.name ?? hospitalId : "Brak grantu portalu",
      recipient: row.actualRecipientEmail || row.communicationEventRecipient.email || row.communicationEventRecipient.normalizedEmail,
      scenario: row.scenario, mode: row.emailMode,
      linkClicked: row.analyticsEvents.some((event) => event.eventType === "EMAIL_LINK_CLICK"),
      portalConfirmed: row.analyticsEvents.some((event) => event.eventType === "PORTAL_VIEW_CONFIRMED"),
      screens,
      screenViewCount: row.analyticsEvents.filter((event) => event.eventType === "SCREEN_VIEW").length,
      sessionCount: new Set(row.analyticsEvents.flatMap((event) => event.sessionId ? [event.sessionId] : [])).size,
      upgradeClicked: row.analyticsEvents.some((event) => event.eventType === "UPGRADE_CLICK"),
    };
  });
}

function mapActivity(deliveries: DeliveryRow[], names: Map<string, { name: string; location: string | null }>) {
  return deliveries.flatMap((row) => {
    const hospitalId = row.portalAccessGrant?.sourceHospitalRecordId ?? null;
    const recipient = row.actualRecipientEmail || row.communicationEventRecipient.email || row.communicationEventRecipient.normalizedEmail;
    return row.analyticsEvents.map((event) => ({
      id: event.id, createdAt: event.createdAt, eventType: event.eventType,
      screen: event.screen, entityType: event.entityType, entityRecordId: event.entityRecordId,
      sessionId: event.sessionId, deliveryId: row.id, recipient,
      scenario: row.scenario, hospitalId,
      hospitalName: hospitalId ? names.get(hospitalId)?.name ?? hospitalId : "Brak grantu portalu",
    }));
  }).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 1000);
}

function serializeFilter(filters: AnalyticsFilters) {
  return { from: filters.from.toISOString(), to: filters.to.toISOString(), mode: filters.mode,
    scenario: filters.scenario ?? null, hospitalId: filters.hospitalId ?? null };
}
