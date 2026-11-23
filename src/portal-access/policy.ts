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
  /**
   * Set when the link was sent to a department contact (e.g. the department
   * nurse) instead of the hospital technical department. Every case, device
   * and file is then limited to that one department, on any access level.
   */
  departmentKey?: string | null;
};

/**
 * Narrows cases to one department (Oddziały). Repairs carry the department in
 * their own snapshot; inspections belong to a department through the Task that
 * schedules them. Without a department key nothing is narrowed.
 */
export function departmentCaseSql(
  access: PortalVisibilityScope,
  caseType: "SERVICE_ORDER" | "INSPECTION",
): Prisma.Sql {
  if (!access.departmentKey) return Prisma.empty;
  if (caseType === "SERVICE_ORDER") {
    return Prisma.sql`AND c."sourceSnapshot"->>'departmentUnitKey' = ${access.departmentKey}`;
  }
  return Prisma.sql`AND EXISTS (
    SELECT 1 FROM "TrackedTask" department_task
    WHERE department_task.active = true
      AND department_task."sourceHospitalRecordId" = ${access.hospitalId}
      AND department_task."linkedInspectionRecordIds" ? c."airtableRecordId"
      AND department_task."sourceSnapshot"->>'departmentUnitKey' = ${access.departmentKey}
  )`;
}

type DepartmentScopeSource = Pick<PrismaClient, "communicationDelivery" | "trackedTask">;

/**
 * Department scope of a portal link. A link is department-scoped only when the
 * email went to a Task's department contact: the recipient is the selected
 * contact or the department e-mail and is not the hospital technical
 * department. Repairs, Tiemed fallbacks and technical-department recipients
 * keep the hospital-wide view.
 */
export type PortalDepartmentScope = { key: string; name: string | null };

export async function resolvePortalDepartmentScope(
  prisma: DepartmentScopeSource,
  communicationDeliveryId: string | undefined,
  hospitalId: string,
): Promise<PortalDepartmentScope | null> {
  // Lightweight test doubles may omit these delegates; treat as hospital-wide.
  if (!communicationDeliveryId ||
    typeof prisma.communicationDelivery?.findUnique !== "function" ||
    typeof prisma.trackedTask?.findUnique !== "function") return null;
  const delivery = await prisma.communicationDelivery.findUnique({
    where: { id: communicationDeliveryId },
    select: {
      communicationEvent: { select: { sourceEntityType: true, sourceRecordId: true } },
      communicationEventRecipient: {
        select: { recipientType: true, normalizedEmail: true, email: true },
      },
    },
  }) as {
    communicationEvent?: { sourceEntityType?: string; sourceRecordId?: string } | null;
    communicationEventRecipient?: {
      recipientType?: string; normalizedEmail?: string | null; email?: string | null;
    } | null;
  } | null;
  const event = delivery?.communicationEvent;
  const eventRecipient = delivery?.communicationEventRecipient;
  if (event?.sourceEntityType !== "TASK" || !event.sourceRecordId ||
    eventRecipient?.recipientType !== "CLIENT") return null;
  const recipient = (eventRecipient.normalizedEmail ?? eventRecipient.email ?? "")
    .trim().toLowerCase();
  if (!recipient) return null;
  const task = await prisma.trackedTask.findUnique({
    where: { airtableRecordId: event.sourceRecordId },
    select: { sourceHospitalRecordId: true, sourceSnapshot: true },
  }) as { sourceHospitalRecordId: string | null; sourceSnapshot: unknown } | null;
  if (!task || task.sourceHospitalRecordId !== hospitalId) return null;
  const snapshot = isRecord(task.sourceSnapshot) ? task.sourceSnapshot : {};
  const key = typeof snapshot.departmentUnitKey === "string" && snapshot.departmentUnitKey.trim()
    ? snapshot.departmentUnitKey : null;
  if (!key) return null;
  if (snapshotEmails(snapshot.technicalDepartmentEmails).includes(recipient)) return null;
  const departmentContacts = [
    ...snapshotEmails(snapshot.selectedContactEmails),
    ...snapshotEmails(snapshot.departmentUnitEmails),
  ];
  if (!departmentContacts.includes(recipient)) return null;
  const name = typeof snapshot.departmentUnit === "string" && snapshot.departmentUnit.trim()
    ? snapshot.departmentUnit.trim() : null;
  return { key, name };
}

function snapshotEmails(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  const department = departmentCaseSql(access, caseType);
  if (access.accessLevel === PortalAccessLevel.FULL) return department;
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
        JOIN "CommunicationDelivery" batch_delivery
          ON batch_delivery."resendMessageId" = grant_delivery."resendMessageId"
        JOIN "CommunicationEvent" communication_event
          ON communication_event.id = batch_delivery."communicationEventId"
        WHERE grant_delivery.id = ${access.communicationDeliveryId}
          AND grant_delivery.status = 'SENT'
          AND batch_delivery.status = 'SENT'
          AND grant_delivery."resendMessageId" IS NOT NULL
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
  ) ${department}`;
}

export function visibleDeviceSql(access: PortalVisibilityScope): Prisma.Sql {
  if (access.accessLevel === PortalAccessLevel.FULL && !access.departmentKey) return Prisma.empty;
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
