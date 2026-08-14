import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { PortalAccessLevel } from "../generated/prisma/enums.js";

export { PortalAccessLevel };

export const DEFAULT_PORTAL_ACCESS_LEVEL = PortalAccessLevel.COMMUNICATION;

export type ResolvedPortalAccess = {
  hospitalId: string;
  accessLevel: PortalAccessLevel;
};

export type PortalVisibilityScope = ResolvedPortalAccess & {
  communicationDeliveryId?: string;
};

export interface PortalAccessPolicy {
  resolve(sourceHospitalRecordId: string): Promise<ResolvedPortalAccess>;
}

export class PrismaPortalAccessPolicy implements PortalAccessPolicy {
  constructor(private readonly prisma: PrismaClient) {}

  async resolve(sourceHospitalRecordId: string): Promise<ResolvedPortalAccess> {
    const entitlement = await this.prisma.hospitalPortalEntitlement.findUnique({
      where: { sourceHospitalRecordId },
      select: { accessLevel: true },
    });
    return {
      hospitalId: sourceHospitalRecordId,
      accessLevel: entitlement?.accessLevel ?? DEFAULT_PORTAL_ACCESS_LEVEL,
    };
  }
}

export function visibleCaseSql(
  access: PortalVisibilityScope,
  caseType: "SERVICE_ORDER" | "INSPECTION",
): Prisma.Sql {
  if (access.accessLevel === PortalAccessLevel.FULL) return Prisma.empty;
  const sourceMatch = caseType === "SERVICE_ORDER"
    ? Prisma.sql`(
        communication_event."sourceEntityType" = 'SERVICE_ORDER'
        AND communication_event."sourceRecordId" = c."airtableRecordId"
      )`
    : Prisma.sql`(
        communication_event."sourceEntityType" = 'TASK'
        AND communication_event.scenario IN (
          'INSPECTION_DATE_PROPOSED',
          'INSPECTION_DATE_CONFIRMED',
          'INSPECTION_REMINDER',
          'INSPECTION_COMPLETED'
        )
        AND COALESCE(communication_event."eventSnapshot"->'linkedInspectionRecordIds', '[]'::jsonb)
          ? c."airtableRecordId"
      )`;
  const grantContext = access.communicationDeliveryId
    ? Prisma.sql`OR EXISTS (
        SELECT 1
        FROM "CommunicationDelivery" grant_delivery
        JOIN "CommunicationEvent" communication_event
          ON communication_event.id = grant_delivery."communicationEventId"
        WHERE grant_delivery.id = ${access.communicationDeliveryId}
          AND grant_delivery.status = 'SENT'
          AND communication_event."eventSnapshot"->>'sourceHospitalRecordId' = ${access.hospitalId}
          AND ${sourceMatch}
      )`
    : Prisma.empty;
  return Prisma.sql`AND (
    EXISTS (
      SELECT 1
      FROM "CommunicationEvent" communication_event
      JOIN "CommunicationDelivery" communication_delivery
        ON communication_delivery."communicationEventId" = communication_event.id
      JOIN "CommunicationEventRecipient" communication_recipient
        ON communication_recipient.id = communication_delivery."communicationEventRecipientId"
      WHERE communication_delivery.status = 'SENT'
        AND communication_recipient."recipientType" = 'CLIENT'
        AND communication_event."eventSnapshot"->>'sourceHospitalRecordId' = ${access.hospitalId}
        AND ${sourceMatch}
    )
    ${grantContext}
  )`;
}

export function visibleDeviceSql(access: PortalVisibilityScope): Prisma.Sql {
  if (access.accessLevel === PortalAccessLevel.FULL) return Prisma.empty;
  return Prisma.sql`AND EXISTS (
    SELECT 1
    FROM "TrackedCaseDevice" visible_device_link
    JOIN "TrackedCase" c ON c.id = visible_device_link."trackedCaseId"
    WHERE visible_device_link."deviceAirtableId" = d."airtableRecordId"
      AND c.active = true
      AND c."sourceHospitalRecordId" = ${access.hospitalId}
      AND (
        (c."caseType" = 'SERVICE_ORDER' ${visibleCaseSql(access, "SERVICE_ORDER")})
        OR
        (c."caseType" = 'INSPECTION' ${visibleCaseSql(access, "INSPECTION")})
      )
  )`;
}
