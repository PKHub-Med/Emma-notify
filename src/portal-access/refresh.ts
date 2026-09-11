import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { PortalRefreshStatus } from "../generated/prisma/enums.js";
import type { PortalAuthorizationContext } from "./public.js";
import type {
  HospitalPortalViewModelService,
  PortalRefreshScopeRecordIds,
} from "./view-model.js";

export type PortalRefreshPublicStatus = {
  requestId: string;
  status: PortalRefreshStatus;
  requestedAt: Date;
  completedAt: Date | null;
};

export interface PortalRefreshRequestStore {
  enqueue(
    authorization: PortalAuthorizationContext,
    refreshScope: PortalRefreshScopeRecordIds,
    requestedAt: Date,
  ): Promise<PortalRefreshPublicStatus>;
  findAuthorized(
    authorization: PortalAuthorizationContext,
    requestId: string,
  ): Promise<PortalRefreshPublicStatus | null>;
}

export class PrismaPortalRefreshRequestStore implements PortalRefreshRequestStore {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueue(
    authorization: PortalAuthorizationContext,
    refreshScope: PortalRefreshScopeRecordIds,
    requestedAt: Date,
  ): Promise<PortalRefreshPublicStatus> {
    const activeKey = `${authorization.portalAccessGrantId}:${refreshScope.scope.hospitalId}`;
    const record = await this.prisma.portalRefreshRequest.upsert({
      where: { activeKey },
      create: {
        portalAccessGrantId: authorization.portalAccessGrantId,
        sourceHospitalRecordId: refreshScope.scope.hospitalId,
        communicationDeliveryId: authorization.communicationDeliveryId,
        accessLevel: refreshScope.scope.accessLevel,
        contextType: refreshScope.scope.contextType,
        contextId: refreshScope.scope.contextId,
        serviceOrderRecordIds: refreshScope.serviceOrderRecordIds as Prisma.InputJsonArray,
        inspectionRecordIds: refreshScope.inspectionRecordIds as Prisma.InputJsonArray,
        deviceRecordIds: refreshScope.deviceRecordIds as Prisma.InputJsonArray,
        taskRecordIds: refreshScope.taskRecordIds as Prisma.InputJsonArray,
        status: PortalRefreshStatus.PENDING,
        activeKey,
        requestedAt,
      },
      update: {},
      select: {
        id: true,
        status: true,
        requestedAt: true,
        completedAt: true,
      },
    });
    return publicStatus(record);
  }

  async findAuthorized(
    authorization: PortalAuthorizationContext,
    requestId: string,
  ): Promise<PortalRefreshPublicStatus | null> {
    const record = await this.prisma.portalRefreshRequest.findFirst({
      where: {
        id: requestId,
        portalAccessGrantId: authorization.portalAccessGrantId,
        sourceHospitalRecordId: authorization.sourceHospitalRecordId,
        communicationDeliveryId: authorization.communicationDeliveryId,
      },
      select: {
        id: true,
        status: true,
        requestedAt: true,
        completedAt: true,
      },
    });
    return record ? publicStatus(record) : null;
  }
}

export class PortalRefreshService {
  constructor(
    private readonly store: PortalRefreshRequestStore,
    private readonly portalViews: Pick<HospitalPortalViewModelService, "resolveRefreshScope">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async request(authorization: PortalAuthorizationContext): Promise<PortalRefreshPublicStatus> {
    const scope = await this.portalViews.resolveRefreshScope(authorization);
    if (scope.scope.hospitalId !== authorization.sourceHospitalRecordId) {
      throw new Error("PORTAL_REFRESH_SCOPE_MISMATCH");
    }
    return this.store.enqueue(authorization, scope, this.now());
  }

  status(
    authorization: PortalAuthorizationContext,
    requestId: string,
  ): Promise<PortalRefreshPublicStatus | null> {
    return this.store.findAuthorized(authorization, requestId);
  }
}

function publicStatus(record: {
  id: string;
  status: PortalRefreshStatus;
  requestedAt: Date;
  completedAt: Date | null;
}): PortalRefreshPublicStatus {
  return {
    requestId: record.id,
    status: record.status,
    requestedAt: record.requestedAt,
    completedAt: record.completedAt,
  };
}
