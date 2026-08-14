import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationAssetRole,
  CommunicationSourceEntityType,
  EventType,
  StoredFileKind,
} from "../generated/prisma/enums.js";
import { publicAssetAccessWhere } from "../assets/public-files.js";
import type { PortalAuthorizationContext } from "./public.js";
import type { PortalEntryContext } from "./service.js";
import {
  DEFAULT_PORTAL_ACCESS_LEVEL,
  PortalAccessLevel,
  visibleCaseSql,
  visibleDeviceSql,
  type PortalAccessPolicy,
  type ResolvedPortalAccess,
} from "./policy.js";

export type PortalCaseFilter = "ALL" | "ACTION" | "REPAIR" | "INSPECTION";

export type PortalHistoryItem = {
  title: string;
  description: string | null;
  changedAt: Date;
};

export type PortalDocument = {
  id: string;
  fileName: string;
  title: string;
  kind: "DOCUMENT" | "IMAGE";
  role: string;
  documentType: string;
  sourceRecordId: string;
  caseType: "REPAIR" | "INSPECTION";
  deviceName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  caseNumber: string | null;
  caseDate: Date | null;
  createdAt: Date;
};

export type PortalCaseListItem = {
  type: "REPAIR" | "INSPECTION";
  sourceRecordId: string;
  deviceId: string | null;
  devices: PortalCaseDevice[];
  deviceName: string;
  manufacturer: string | null;
  model: string | null;
  manufacturerModel: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  caseNumber: string | null;
  clientOrderNumber: string | null;
  currentStatus: string;
  lastChangedAt: Date | null;
  requiresAction: boolean;
  reportedAt: Date | null;
  inspectionPerformedAt: Date | null;
  validUntil: Date | null;
  description: string | null;
  history: PortalHistoryItem[];
  documents: PortalDocument[];
  photos: PortalDocument[];
};

export type PortalCaseDevice = {
  sourceRecordId: string;
  deviceName: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  currentDeviceAccessible?: boolean;
};

export type PortalDevice = {
  sourceRecordId: string;
  deviceName: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  currentStatus: string;
  validUntil: Date | null;
  inspectionPerformedAt: Date | null;
  inspectionResult: string | null;
};

export type PortalDeviceDetail = PortalDevice & {
  cases: PortalPage<PortalCaseListItem>;
  lockedCaseCount: number;
};

export type PortalPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type HospitalPortalViewModel = {
  hospital: { shortName: string; name: string; address: string | null };
  serviceProviderName: string;
  summary: { requiresAction: number; repairs: number; inspections: number; devices: number };
  accessLevel: PortalAccessLevel;
  teaser: {
    totalDevices: number; visibleDevices: number; lockedDevices: number;
    totalRepairs: number; visibleRepairs: number; lockedRepairs: number;
    totalInspections: number; visibleInspections: number; lockedInspections: number;
  };
  upgradeUrl: string;
  initialCases: PortalPage<PortalCaseListItem>;
  focusedCase: PortalCaseListItem | null;
};

export type PortalDataScope = {
  hospitalId: string;
  accessLevel: PortalAccessLevel;
  communicationDeliveryId: string;
  contextType: "REPAIR" | "INSPECTION_TASK";
  contextId: string;
};

type StoredHospital = { shortName: string | null; name: string | null; address: string | null };
type StoredEvent = { eventType: string; oldValue: unknown; newValue: unknown; detectedAt: Date };

export type StoredPortalCase = {
  id: string;
  airtableRecordId: string;
  businessNumber: string | null;
  clientOrderNumber: string | null;
  emmaCustomerStatus: string | null;
  taskCustomerStatus?: string | null;
  hospitalName: string | null;
  deviceName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  currentStatus: string | null;
  faultDescription: string | null;
  sourceCreatedAt: Date | null;
  reportedAt: Date | null;
  sourceModifiedAt: Date | null;
  inspectionDueDate: Date | null;
  inspectionPerformedAt: Date | null;
  inspectionResult: string | null;
  inspectionValidUntil: Date | null;
  events: StoredEvent[];
};

export type PortalCaseCursorKey = {
  type: "REPAIR" | "INSPECTION";
  sourceRecordId: string;
  sortKey: bigint;
};

type SummaryCountRow = {
  repairs: bigint;
  inspections: bigint;
  requiresAction: bigint;
};

type TotalCountRow = { repairs: bigint; inspections: bigint };
type CountRow = { count: bigint };

export type PortalDeviceCursorKey = { sourceRecordId: string; sortKey: bigint };

type PageKey = PortalCaseCursorKey;
type DeviceKey = PortalDeviceCursorKey;

export class InvalidPortalCursorError extends Error {
  readonly code = "INVALID_CURSOR";
  constructor() { super("INVALID_PORTAL_CURSOR"); }
}

export interface HospitalPortalStore {
  findHospital(scope: string): Promise<StoredHospital | null>;
  getSummaryCounts(scope: PortalDataScope): Promise<HospitalPortalViewModel["summary"]>;
  getTeaserCounts(scope: PortalDataScope): Promise<HospitalPortalViewModel["teaser"]>;
  pageCases(scope: PortalDataScope, options: {
    filter: PortalCaseFilter;
    query: string | null;
    cursor: string | null;
    limit: number;
    deviceId?: string;
    hospitalWideDevice?: boolean;
  }): Promise<PortalPage<PortalCaseListItem>>;
  findScopedCase(scope: PortalDataScope, sourceRecordId: string): Promise<PortalCaseListItem | null>;
  resolveFocusedCase(scope: PortalDataScope): Promise<PortalCaseListItem | null>;
  pageDevices(scope: PortalDataScope, options: {
    query: string | null;
    cursor: string | null;
    limit: number;
  }): Promise<PortalPage<PortalDevice>>;
  findScopedDevice(
    scope: PortalDataScope,
    sourceRecordId: string,
    limit: number,
    cursor?: string | null,
  ): Promise<PortalDeviceDetail | null>;
  listDocuments?(scope: PortalDataScope, query: string | null): Promise<PortalDocument[]>;
}

type PortalAssetRow = {
  id: string;
  role: CommunicationAssetRole;
  displayOrder: number;
  createdAt: Date;
  storedFile: {
    id: string;
    sourceRecordId: string;
    sourceEntityType: CommunicationSourceEntityType;
    kind: StoredFileKind;
    originalFileName: string;
  };
};

type PortalAssetCaseContext = {
  type: "REPAIR" | "INSPECTION";
  sourceRecordId: string;
  deviceName: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  caseNumber: string | null;
  caseDate: Date | null;
};

const CASE_SELECT = {
  id: true,
  airtableRecordId: true,
  businessNumber: true,
  clientOrderNumber: true,
  emmaCustomerStatus: true,
  hospitalName: true,
  deviceName: true,
  manufacturer: true,
  model: true,
  serialNumber: true,
  inventoryNumber: true,
  currentStatus: true,
  faultDescription: true,
  sourceCreatedAt: true,
  reportedAt: true,
  sourceModifiedAt: true,
  inspectionDueDate: true,
  inspectionPerformedAt: true,
  inspectionResult: true,
  inspectionValidUntil: true,
  events: {
    where: {
      visibleToCustomer: true,
      eventType: { in: [EventType.SERVICE_STATUS_CHANGED, EventType.INSPECTION_STATUS_CHANGED] },
    },
    orderBy: { detectedAt: "asc" },
    select: { eventType: true, oldValue: true, newValue: true, detectedAt: true },
  },
} satisfies Prisma.TrackedCaseSelect;

const CASE_LIST_SELECT = {
  ...CASE_SELECT,
  events: false,
} satisfies Prisma.TrackedCaseSelect;

export class PrismaHospitalPortalStore implements HospitalPortalStore {
  constructor(private readonly prisma: PrismaClient) {}

  findHospital(scope: string): Promise<StoredHospital | null> {
    return this.prisma.trackedHospital.findUnique({
      where: { airtableRecordId: scope },
      select: { shortName: true, name: true, address: true },
    });
  }

  async getSummaryCounts(scope: PortalDataScope): Promise<HospitalPortalViewModel["summary"]> {
    const [rows, visibleDeviceRows] = await Promise.all([
      this.prisma.$queryRaw<SummaryCountRow[]>(Prisma.sql`
      WITH scoped AS (${scopedCasesSql(scope)})
      SELECT
        COUNT(*) FILTER (WHERE type = 'REPAIR') AS repairs,
        COUNT(*) FILTER (WHERE type = 'INSPECTION') AS inspections,
        COUNT(*) FILTER (WHERE UPPER(TRIM(status)) IN ('OCZEKUJEMY NA DECYZJĘ', 'DO REALIZACJI')) AS "requiresAction"
      FROM scoped
    `),
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT COUNT(*) AS count FROM "TrackedDevice" d
        WHERE d."sourceHospitalRecordId" = ${scope.hospitalId}
          ${visibleDeviceSql(scope)}
      `),
    ]);
    const row = rows[0];
    return {
      repairs: Number(row?.repairs ?? 0n),
      inspections: Number(row?.inspections ?? 0n),
      requiresAction: Number(row?.requiresAction ?? 0n),
      devices: Number(visibleDeviceRows[0]?.count ?? 0n),
    };
  }

  async getTeaserCounts(scope: PortalDataScope): Promise<HospitalPortalViewModel["teaser"]> {
    const [visible, totals, totalDevices] = await Promise.all([
      this.getSummaryCounts(scope),
      this.prisma.$queryRaw<TotalCountRow[]>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE c."caseType" = 'SERVICE_ORDER') AS repairs,
          COUNT(*) FILTER (WHERE c."caseType" = 'INSPECTION') AS inspections
        FROM "TrackedCase" c
        WHERE c.active = true AND c."sourceHospitalRecordId" = ${scope.hospitalId}
      `),
      this.prisma.trackedDevice.count({
        where: { sourceHospitalRecordId: scope.hospitalId },
      }),
    ]);
    const totalRepairs = Number(totals[0]?.repairs ?? 0n);
    const totalInspections = Number(totals[0]?.inspections ?? 0n);
    return {
      totalDevices, visibleDevices: visible.devices,
      lockedDevices: Math.max(0, totalDevices - visible.devices),
      totalRepairs, visibleRepairs: visible.repairs,
      lockedRepairs: Math.max(0, totalRepairs - visible.repairs),
      totalInspections, visibleInspections: visible.inspections,
      lockedInspections: Math.max(0, totalInspections - visible.inspections),
    };
  }

  async pageCases(scope: PortalDataScope, options: {
    filter: PortalCaseFilter;
    query: string | null;
    cursor: string | null;
    limit: number;
    deviceId?: string;
    hospitalWideDevice?: boolean;
  }): Promise<PortalPage<PortalCaseListItem>> {
    const cursor = decodePortalCaseCursor(options.cursor);
    const filterSql = caseFilterSql(options.filter);
    const searchSql = searchFilterSql(options.query, scope.hospitalId);
    const deviceSql = options.deviceId
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "TrackedCaseDevice" case_device
          WHERE case_device."trackedCaseId" = scoped_case."trackedCaseId"
            AND case_device."deviceAirtableId" = ${options.deviceId})`
      : Prisma.empty;
    const cursorSql = cursor
      ? Prisma.sql`AND (
          "sortKey" < CAST(${cursor.sortKey.toString()} AS bigint)
          OR ("sortKey" = CAST(${cursor.sortKey.toString()} AS bigint) AND type < ${cursor.type})
          OR ("sortKey" = CAST(${cursor.sortKey.toString()} AS bigint) AND type = ${cursor.type}
            AND "sourceRecordId" < ${cursor.sourceRecordId})
        )`
      : Prisma.empty;
    const keys = await this.prisma.$queryRaw<PageKey[]>(Prisma.sql`
      WITH scoped AS (${scopedCasesSql(scope)})
      SELECT type, "sourceRecordId", "sortKey"
      FROM scoped scoped_case
      WHERE 1=1 ${filterSql} ${searchSql} ${deviceSql} ${cursorSql}
      ORDER BY "sortKey" DESC, type DESC, "sourceRecordId" DESC
      LIMIT ${options.limit + 1}
    `);
    const hasMore = keys.length > options.limit;
    const selected = keys.slice(0, options.limit);
    const items = await this.loadCases(scope, selected, false);
    const last = selected.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodePortalCaseCursor(last) : null,
    };
  }

  async findScopedCase(scope: PortalDataScope, sourceRecordId: string): Promise<PortalCaseListItem | null> {
    const keys = await this.prisma.$queryRaw<PageKey[]>(Prisma.sql`
      WITH scoped AS (${scopedCasesSql(scope)})
      SELECT type, "sourceRecordId", "sortKey" FROM scoped
      WHERE "sourceRecordId" = ${sourceRecordId}
      LIMIT 1
    `);
    return (await this.loadCases(scope, keys, true))[0] ?? null;
  }

  async resolveFocusedCase(scope: PortalDataScope): Promise<PortalCaseListItem | null> {
    if (scope.contextType === "REPAIR") return this.findScopedCase(scope, scope.contextId);
    const task = await this.prisma.trackedTask.findFirst({
      where: { airtableRecordId: scope.contextId, sourceHospitalRecordId: scope.hospitalId },
      select: { linkedInspectionRecordIds: true, linkedServiceOrderRecordIds: true },
    });
    if (!task) return null;
    for (const id of [
      ...stringArray(task.linkedInspectionRecordIds),
      ...stringArray(task.linkedServiceOrderRecordIds),
    ]) {
      const item = await this.findScopedCase(scope, id);
      if (item) return item;
    }
    return null;
  }

  async pageDevices(scope: PortalDataScope, options: {
    query: string | null;
    cursor: string | null;
    limit: number;
  }): Promise<PortalPage<PortalDevice>> {
    const cursor = decodePortalDeviceCursor(options.cursor);
    const searchSql = deviceSearchFilterSql(options.query);
    const cursorSql = cursor
      ? Prisma.sql`AND (
          FLOOR(EXTRACT(EPOCH FROM COALESCE(d."sourceModifiedAt", d."sourceCreatedAt", TIMESTAMP '1970-01-01')) * 1000)::bigint < CAST(${cursor.sortKey.toString()} AS bigint)
          OR (FLOOR(EXTRACT(EPOCH FROM COALESCE(d."sourceModifiedAt", d."sourceCreatedAt", TIMESTAMP '1970-01-01')) * 1000)::bigint = CAST(${cursor.sortKey.toString()} AS bigint)
            AND d."airtableRecordId" < ${cursor.sourceRecordId})
        )`
      : Prisma.empty;
    const keys = await this.prisma.$queryRaw<DeviceKey[]>(Prisma.sql`
      SELECT d."airtableRecordId" AS "sourceRecordId",
        FLOOR(EXTRACT(EPOCH FROM COALESCE(d."sourceModifiedAt", d."sourceCreatedAt", TIMESTAMP '1970-01-01')) * 1000)::bigint AS "sortKey"
      FROM "TrackedDevice" d
      WHERE d."sourceHospitalRecordId" = ${scope.hospitalId}
        ${visibleDeviceSql(scope)}
        ${searchSql} ${cursorSql}
      ORDER BY "sortKey" DESC, "sourceRecordId" DESC
      LIMIT ${options.limit + 1}
    `);
    const hasMore = keys.length > options.limit;
    const selected = keys.slice(0, options.limit);
    const items = await this.loadDevices(scope, selected.map((key) => key.sourceRecordId));
    const last = selected.at(-1);
    return {
      items: items.filter((item): item is PortalDevice => item !== null),
      nextCursor: hasMore && last ? encodePortalDeviceCursor(last) : null,
    };
  }

  async findScopedDevice(
    scope: PortalDataScope,
    sourceRecordId: string,
    limit: number,
    cursor: string | null = null,
  ): Promise<PortalDeviceDetail | null> {
    const device = await this.loadDevice(scope, sourceRecordId);
    if (!device) return null;
    const cases = await this.pageCases(scope, {
      filter: "ALL", query: null, cursor, limit, deviceId: sourceRecordId,
    });
    const counts = await this.deviceCaseCounts(scope, sourceRecordId);
    return {
      ...device,
      cases,
      lockedCaseCount: Math.max(0, counts.total - counts.visible),
    };
  }

  async listDocuments(scope: PortalDataScope, query: string | null): Promise<PortalDocument[]> {
    const matchingCaseIds = query ? await this.searchCaseIds(scope, query) : [];
    const searchWhere: Prisma.CommunicationAssetWhereInput = query ? {
      OR: [
        { storedFile: { originalFileName: { contains: query, mode: "insensitive" } } },
        ...(matchingCaseIds.length > 0
          ? [{ storedFile: { sourceRecordId: { in: matchingCaseIds } } }]
          : []),
      ],
    } : {};
    const assets = await this.prisma.communicationAsset.findMany({
      where: {
        AND: [
          publicAssetAccessWhere(scope),
          { storedFile: { kind: StoredFileKind.DOCUMENT } },
          searchWhere,
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: PORTAL_ASSET_SELECT,
    });
    const unique = deduplicateAssets(assets);
    const cases = await this.loadVisibleAssetCaseSnapshots(
      scope,
      unique.map((asset) => asset.storedFile.sourceRecordId),
    );
    return mapPortalAssets(unique, cases).filter((asset) => asset.kind === "DOCUMENT");
  }

  private async deviceCaseCounts(
    scope: PortalDataScope,
    sourceRecordId: string,
  ): Promise<{ total: number; visible: number }> {
    const [totalRows, visibleRows] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT COUNT(*) AS count FROM "TrackedCase" c
        JOIN "TrackedCaseDevice" cd ON cd."trackedCaseId" = c.id
        WHERE c.active = true AND c."sourceHospitalRecordId" = ${scope.hospitalId}
          AND cd."deviceAirtableId" = ${sourceRecordId}
      `),
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        WITH scoped AS (${scopedCasesSql(scope)})
        SELECT COUNT(*) AS count FROM scoped
        JOIN "TrackedCaseDevice" cd ON cd."trackedCaseId" = scoped."trackedCaseId"
        WHERE cd."deviceAirtableId" = ${sourceRecordId}
      `),
    ]);
    return {
      total: Number(totalRows[0]?.count ?? 0n),
      visible: Number(visibleRows[0]?.count ?? 0n),
    };
  }

  private async loadDevice(scope: PortalDataScope, sourceRecordId: string): Promise<PortalDevice | null> {
    return (await this.loadDevices(scope, [sourceRecordId]))[0] ?? null;
  }

  private async loadDevices(
    scope: PortalDataScope,
    sourceRecordIds: readonly string[],
  ): Promise<PortalDevice[]> {
    if (sourceRecordIds.length === 0) return [];
    const authorizedRows = await this.prisma.$queryRaw<Array<{ airtableRecordId: string }>>(Prisma.sql`
      SELECT d."airtableRecordId" FROM "TrackedDevice" d
      WHERE d."sourceHospitalRecordId" = ${scope.hospitalId}
        AND d."airtableRecordId" IN (${Prisma.join(sourceRecordIds)})
        ${visibleDeviceSql(scope)}
    `);
    const authorizedIds = authorizedRows.map((row) => row.airtableRecordId);
    if (authorizedIds.length === 0) return [];
    const devices = await this.prisma.trackedDevice.findMany({
      where: {
        airtableRecordId: { in: authorizedIds },
        sourceHospitalRecordId: scope.hospitalId,
      },
      select: {
        airtableRecordId: true, name: true, manufacturer: true, model: true,
        serialNumber: true, inventoryNumber: true, deviceStatus: true,
      },
    });
    const inspections = await this.prisma.$queryRaw<Array<{
      deviceAirtableId: string;
      inspectionPerformedAt: Date | null;
      inspectionResult: string | null;
      inspectionValidUntil: Date | null;
    }>>(Prisma.sql`
      SELECT DISTINCT ON (cd."deviceAirtableId")
        cd."deviceAirtableId", c."inspectionPerformedAt", c."inspectionResult",
        c."inspectionValidUntil"
      FROM "TrackedCase" c
      JOIN "TrackedCaseDevice" cd ON cd."trackedCaseId" = c.id
      WHERE c."caseType" = 'INSPECTION' AND c.active = true
        AND c."sourceHospitalRecordId" = ${scope.hospitalId}
        ${visibleCaseSql(scope, "INSPECTION")}
        AND c."inspectionPerformedAt" IS NOT NULL
        AND cd."deviceAirtableId" IN (${Prisma.join(authorizedIds)})
      ORDER BY cd."deviceAirtableId", c."inspectionPerformedAt" DESC,
        c."sourceModifiedAt" DESC NULLS LAST, c."airtableRecordId" DESC
    `);
    const inspectionsByDevice = new Map(inspections.map((item) =>
      [item.deviceAirtableId, item]));
    const devicesById = new Map(devices.map((device) => [device.airtableRecordId, device]));
    return authorizedIds.flatMap((sourceRecordId) => {
      const device = devicesById.get(sourceRecordId);
      if (!device) return [];
      const inspection = inspectionsByDevice.get(sourceRecordId);
      return [{
        sourceRecordId: device.airtableRecordId,
        deviceName: device.name || "Urządzenie medyczne",
        manufacturer: device.manufacturer,
        model: device.model,
        serialNumber: device.serialNumber,
        inventoryNumber: device.inventoryNumber,
        currentStatus: device.deviceStatus || "Brak informacji",
        validUntil: inspection?.inspectionValidUntil ?? null,
        inspectionPerformedAt: inspection?.inspectionPerformedAt ?? null,
        inspectionResult: inspection?.inspectionResult ?? null,
      }];
    });
  }

  private async loadCases(
    scope: PortalDataScope,
    keys: readonly PageKey[],
    includeDetails: boolean,
  ): Promise<PortalCaseListItem[]> {
    if (keys.length === 0) return [];
    const ids = keys.map((key) => key.sourceRecordId);
    const rows: StoredPortalCase[] = includeDetails
      ? await this.prisma.trackedCase.findMany({
          where: { airtableRecordId: { in: ids } }, select: CASE_SELECT,
        })
      : (await this.prisma.trackedCase.findMany({
          where: { airtableRecordId: { in: ids } }, select: CASE_LIST_SELECT,
        })).map((row) => ({ ...row, events: [] }));
    const inspectionIds = keys.filter((key) => key.type === "INSPECTION").map((key) => key.sourceRecordId);
    const tasks = inspectionIds.length === 0 ? [] : await this.prisma.trackedTask.findMany({
      where: {
        sourceHospitalRecordId: scope.hospitalId,
        OR: inspectionIds.map((id) => ({ linkedInspectionRecordIds: { array_contains: [id] } })),
      },
      orderBy: { updatedAt: "desc" },
      select: { emmaCustomerStatus: true, linkedInspectionRecordIds: true },
    });
    const caseIds = rows.map((row) => row.id);
    const caseDeviceLinks = caseIds.length === 0 ? [] : await this.prisma.trackedCaseDevice.findMany({
      where: { trackedCaseId: { in: caseIds } },
      orderBy: [{ trackedCaseId: "asc" }, { deviceAirtableId: "asc" }],
      select: { trackedCaseId: true, deviceAirtableId: true },
    });
    const linkedDeviceIds = [...new Set(caseDeviceLinks.map((link) => link.deviceAirtableId))];
    const linkedDevices = linkedDeviceIds.length === 0 ? [] : await this.prisma.trackedDevice.findMany({
      where: {
        airtableRecordId: { in: linkedDeviceIds },
        sourceHospitalRecordId: scope.hospitalId,
      },
      select: {
        airtableRecordId: true, name: true, manufacturer: true, model: true,
        serialNumber: true, inventoryNumber: true,
      },
    });
    const linkedDeviceById = new Map(linkedDevices.map((device) => [device.airtableRecordId, device]));
    const caseRowById = new Map(rows.map((row) => [row.id, row]));
    const devicesByCase = new Map<string, PortalCaseDevice[]>();
    for (const link of caseDeviceLinks) {
      const device = linkedDeviceById.get(link.deviceAirtableId);
      const caseSnapshot = caseRowById.get(link.trackedCaseId);
      const items = devicesByCase.get(link.trackedCaseId) ?? [];
      items.push({
        sourceRecordId: link.deviceAirtableId,
        deviceName: device?.name || caseSnapshot?.deviceName || "Urządzenie medyczne",
        manufacturer: device?.manufacturer ?? caseSnapshot?.manufacturer ?? null,
        model: device?.model ?? caseSnapshot?.model ?? null,
        serialNumber: device?.serialNumber ?? caseSnapshot?.serialNumber ?? null,
        inventoryNumber: device?.inventoryNumber ?? caseSnapshot?.inventoryNumber ?? null,
        currentDeviceAccessible: Boolean(device),
      });
      devicesByCase.set(link.trackedCaseId, items);
    }
    const taskStatus = new Map<string, string | null>();
    for (const task of tasks) {
      for (const id of stringArray(task.linkedInspectionRecordIds)) {
        if (!taskStatus.has(id)) taskStatus.set(id, task.emmaCustomerStatus);
      }
    }
    const rowById = new Map(rows.map((row) => [row.airtableRecordId, row]));
    const items = keys.flatMap((key) => {
      const row = rowById.get(key.sourceRecordId);
      return row ? [mapCase({
        ...row,
        taskCustomerStatus: taskStatus.get(key.sourceRecordId) ?? null,
      }, key.type, devicesByCase.get(row.id) ?? [])] : [];
    });
    if (includeDetails) await this.attachCaseAssets(scope, items, rows);
    return items;
  }

  private async attachCaseAssets(
    scope: PortalDataScope,
    cases: PortalCaseListItem[],
    snapshots: StoredPortalCase[],
  ): Promise<void> {
    if (cases.length === 0) return;
    const sourceIds = cases.map((item) => item.sourceRecordId);
    const assets = await this.prisma.communicationAsset.findMany({
      where: {
        AND: [
          publicAssetAccessWhere(scope),
          {
            storedFile: {
              sourceRecordId: { in: sourceIds },
              sourceEntityType: { in: [
                CommunicationSourceEntityType.SERVICE_ORDER,
                CommunicationSourceEntityType.INSPECTION,
              ] },
            },
          },
        ],
      },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
      select: PORTAL_ASSET_SELECT,
    });
    const mapped = mapPortalAssets(
      deduplicateAssets(assets),
      new Map(cases.flatMap((item) => {
        const snapshot = snapshots.find((row) => row.airtableRecordId === item.sourceRecordId);
        return snapshot ? [[item.sourceRecordId, assetCaseContext(snapshot, item.type)] as const] : [];
      })),
    );
    for (const item of cases) {
      const caseAssets = mapped.filter((asset) => asset.sourceRecordId === item.sourceRecordId);
      item.documents = caseAssets.filter((asset) => asset.kind === "DOCUMENT");
      item.photos = caseAssets.filter((asset) => asset.kind === "IMAGE");
    }
  }

  private async searchCaseIds(scope: PortalDataScope, query: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ sourceRecordId: string }>>(Prisma.sql`
      WITH scoped AS (${scopedCasesSql(scope)})
      SELECT "sourceRecordId" FROM scoped scoped_case
      WHERE 1=1 ${searchFilterSql(query, scope.hospitalId)}
    `);
    return rows.map((row) => row.sourceRecordId);
  }

  private async loadVisibleAssetCaseSnapshots(
    scope: PortalDataScope,
    sourceRecordIds: readonly string[],
  ): Promise<Map<string, PortalAssetCaseContext>> {
    if (sourceRecordIds.length === 0) return new Map();
    const uniqueIds = [...new Set(sourceRecordIds)];
    const keys = await this.prisma.$queryRaw<PageKey[]>(Prisma.sql`
      WITH scoped AS (${scopedCasesSql(scope)})
      SELECT type, "sourceRecordId", "sortKey" FROM scoped
      WHERE "sourceRecordId" IN (${Prisma.join(uniqueIds)})
    `);
    if (keys.length === 0) return new Map();
    const rows = await this.prisma.trackedCase.findMany({
      where: {
        airtableRecordId: { in: keys.map((key) => key.sourceRecordId) },
        sourceHospitalRecordId: scope.hospitalId,
      },
      select: {
        airtableRecordId: true,
        businessNumber: true,
        deviceName: true,
        manufacturer: true,
        model: true,
        serialNumber: true,
        reportedAt: true,
        inspectionPerformedAt: true,
      },
    });
    const rowById = new Map(rows.map((row) => [row.airtableRecordId, row]));
    return new Map(keys.flatMap((key) => {
      const row = rowById.get(key.sourceRecordId);
      return row ? [[key.sourceRecordId, assetCaseContext(row, key.type)] as const] : [];
    }));
  }
}

const PORTAL_ASSET_SELECT = {
  id: true,
  role: true,
  displayOrder: true,
  createdAt: true,
  storedFile: {
    select: {
      id: true,
      sourceRecordId: true,
      sourceEntityType: true,
      kind: true,
      originalFileName: true,
    },
  },
} satisfies Prisma.CommunicationAssetSelect;

export class HospitalPortalViewModelService {
  readonly pageSize: number;

  constructor(
    private readonly store: HospitalPortalStore,
    private readonly serviceProviderName = "Tiemed",
    pageSize = 30,
    private readonly accessPolicy: PortalAccessPolicy = {
      async resolve(hospitalId) {
        return { hospitalId, accessLevel: DEFAULT_PORTAL_ACCESS_LEVEL };
      },
    },
    private readonly upgradeUrl = "mailto:serwis@tiemed.pl?subject=Emma%20FULL",
  ) {
    this.pageSize = clampLimit(pageSize, 30);
  }

  async build(authorization: PortalAuthorizationContext): Promise<HospitalPortalViewModel> {
    const scope = await this.resolveScope(authorization);
    const [hospital, summary, teaser, initialCases, focusedCase] = await Promise.all([
      this.store.findHospital(scope.hospitalId),
      this.store.getSummaryCounts(scope),
      this.store.getTeaserCounts(scope),
      this.store.pageCases(scope, { filter: "ALL", query: null, cursor: null, limit: this.pageSize }),
      this.store.resolveFocusedCase(scope),
    ]);
    return {
      hospital: {
        shortName: hospital?.shortName || hospital?.name || "Szpital",
        name: hospital?.name || hospital?.shortName || "Szpital",
        address: hospital?.address ?? null,
      },
      serviceProviderName: this.serviceProviderName,
      summary, teaser, accessLevel: scope.accessLevel,
      upgradeUrl: this.upgradeUrl,
      initialCases,
      focusedCase,
    };
  }

  async listCases(authorization: PortalAuthorizationContext, options: {
    filter?: string; query?: string; cursor?: string; limit?: number;
  }): Promise<PortalPage<PortalCaseListItem>> {
    const cursor = options.cursor || null;
    if (cursor) decodePortalCaseCursor(cursor);
    return this.store.pageCases(await this.resolveScope(authorization), {
      filter: parseFilter(options.filter),
      query: normalizeSearch(options.query),
      cursor,
      limit: clampLimit(options.limit, this.pageSize),
    });
  }

  async getCase(authorization: PortalAuthorizationContext, id: string): Promise<PortalCaseListItem | null> {
    return this.store.findScopedCase(await this.resolveScope(authorization), id);
  }

  async listDevices(authorization: PortalAuthorizationContext, options: {
    query?: string; cursor?: string; limit?: number;
  }): Promise<PortalPage<PortalDevice>> {
    const cursor = options.cursor || null;
    if (cursor) decodePortalDeviceCursor(cursor);
    return this.store.pageDevices(await this.resolveScope(authorization), {
      query: normalizeSearch(options.query), cursor,
      limit: clampLimit(options.limit, this.pageSize),
    });
  }

  async getDevice(authorization: PortalAuthorizationContext, id: string, options: {
    cursor?: string; limit?: number;
  } = {}): Promise<PortalDeviceDetail | null> {
    const cursor = options.cursor || null;
    if (cursor) decodePortalCaseCursor(cursor);
    return this.store.findScopedDevice(
      await this.resolveScope(authorization),
      id,
      clampLimit(options.limit, this.pageSize),
      cursor,
    );
  }

  async listDocuments(
    authorization: PortalAuthorizationContext,
    options: { query?: string } = {},
  ): Promise<PortalPage<PortalDocument>> {
    const scope = await this.resolveScope(authorization);
    const items = this.store.listDocuments
      ? await this.store.listDocuments(scope, normalizeSearch(options.query))
      : [];
    return { items, nextCursor: null };
  }

  private async resolveScope(
    authorization: PortalAuthorizationContext,
  ): Promise<PortalDataScope> {
    const access = await this.accessPolicy.resolve(authorization.sourceHospitalRecordId);
    return portalDataScope(authorization, access);
  }
}

function scopedCasesSql(scope: PortalDataScope): Prisma.Sql {
  return Prisma.sql`
    SELECT 'REPAIR'::text AS type, c.id AS "trackedCaseId",
      c."airtableRecordId" AS "sourceRecordId", c."deviceName", c.manufacturer, c.model,
      c."serialNumber", c."inventoryNumber",
      COALESCE(c."emmaCustomerStatus", c."currentStatus", 'Brak informacji') AS status,
      FLOOR(EXTRACT(EPOCH FROM COALESCE((SELECT MAX(e."detectedAt") FROM "CaseEvent" e
        WHERE e."trackedCaseId" = c.id AND e."visibleToCustomer" = true),
        c."sourceModifiedAt", c."sourceCreatedAt", TIMESTAMP '1970-01-01 00:00:00')) * 1000)::bigint AS "sortKey",
      NULL::timestamp AS "validUntil", c."businessNumber", c."clientOrderNumber"
    FROM "TrackedCase" c
    WHERE c."caseType" = 'SERVICE_ORDER' AND c.active = true
      AND c."sourceHospitalRecordId" = ${scope.hospitalId}
      ${visibleCaseSql(scope, "SERVICE_ORDER")}
    UNION ALL
    SELECT 'INSPECTION'::text AS type, c.id AS "trackedCaseId",
      c."airtableRecordId" AS "sourceRecordId", c."deviceName", c.manufacturer, c.model,
      c."serialNumber", c."inventoryNumber",
      COALESCE(c."currentStatus", (SELECT t."emmaCustomerStatus" FROM "TrackedTask" t
        WHERE t."sourceHospitalRecordId" = ${scope.hospitalId}
          AND t."linkedInspectionRecordIds" ? c."airtableRecordId"
        ORDER BY t."updatedAt" DESC LIMIT 1), 'Brak informacji') AS status,
      (CASE UPPER(TRIM(COALESCE(c."currentStatus", '')))
        WHEN 'NIESPRAWNE' THEN 3
        WHEN 'WARUNKOWO DOPUSZCZONE' THEN 2
        WHEN 'SPRAWNE' THEN 1
        ELSE 0 END)::bigint * 1000000000000000::bigint
      + FLOOR(EXTRACT(EPOCH FROM COALESCE((SELECT MAX(e."detectedAt") FROM "CaseEvent" e
        WHERE e."trackedCaseId" = c.id AND e."visibleToCustomer" = true),
        c."sourceModifiedAt", c."sourceCreatedAt", TIMESTAMP '1970-01-01 00:00:00')) * 1000)::bigint AS "sortKey",
      c."inspectionValidUntil" AS "validUntil", c."businessNumber", c."clientOrderNumber"
    FROM "TrackedCase" c
    WHERE c."caseType" = 'INSPECTION' AND c.active = true
      AND c."sourceHospitalRecordId" = ${scope.hospitalId}
      ${visibleCaseSql(scope, "INSPECTION")}
  `;
}

export function portalDataScope(
  authorization: PortalAuthorizationContext,
  access: ResolvedPortalAccess = {
    hospitalId: authorization.sourceHospitalRecordId,
    accessLevel: DEFAULT_PORTAL_ACCESS_LEVEL,
  },
): PortalDataScope {
  return {
    hospitalId: access.hospitalId,
    accessLevel: access.accessLevel,
    communicationDeliveryId: authorization.communicationDeliveryId,
    contextType: authorization.entryContext.type === "SERVICE_ORDER" ? "REPAIR" : "INSPECTION_TASK",
    contextId: authorization.entryContext.sourceRecordId,
  };
}

function caseFilterSql(filter: PortalCaseFilter): Prisma.Sql {
  if (filter === "REPAIR") return Prisma.sql`AND type = 'REPAIR'`;
  if (filter === "INSPECTION") return Prisma.sql`AND type = 'INSPECTION'`;
  if (filter === "ACTION") return Prisma.sql`AND UPPER(TRIM(status)) IN ('OCZEKUJEMY NA DECYZJĘ', 'DO REALIZACJI')`;
  return Prisma.empty;
}

function searchFilterSql(query: string | null, hospitalId: string): Prisma.Sql {
  if (!query) return Prisma.empty;
  const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  return Prisma.sql`AND (
    CONCAT_WS(' ', "deviceName", manufacturer, model, "serialNumber", "inventoryNumber", "businessNumber", "clientOrderNumber", status) ILIKE ${pattern} ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM "TrackedCaseDevice" search_link
      JOIN "TrackedDevice" search_device
        ON search_device."airtableRecordId" = search_link."deviceAirtableId"
      WHERE search_link."trackedCaseId" = scoped_case."trackedCaseId"
        AND search_device."sourceHospitalRecordId" = ${hospitalId}
        AND CONCAT_WS(' ', search_device.name, search_device.manufacturer, search_device.model,
          search_device."serialNumber", search_device."inventoryNumber") ILIKE ${pattern} ESCAPE '\\'
    )
  )`;
}

function deviceSearchFilterSql(query: string | null): Prisma.Sql {
  if (!query) return Prisma.empty;
  const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  return Prisma.sql`AND CONCAT_WS(' ', d.name, d.manufacturer, d.model, d."serialNumber", d."inventoryNumber") ILIKE ${pattern} ESCAPE '\\'`;
}

function mapCase(
  stored: StoredPortalCase,
  type: "REPAIR" | "INSPECTION",
  devices: PortalCaseDevice[],
): PortalCaseListItem {
  const currentStatus = type === "INSPECTION"
    ? stored.currentStatus || stored.taskCustomerStatus || stored.emmaCustomerStatus || "Brak informacji"
    : stored.emmaCustomerStatus || stored.currentStatus || "Brak informacji";
  const history = stored.events.map((event) => ({
    title: event.eventType === "INSPECTION_STATUS_CHANGED" ? "Zmiana statusu przeglądu" : "Zmiana statusu",
    description: changeDescription(event.oldValue, event.newValue),
    changedAt: event.detectedAt,
  }));
  const publicDevices = devices.map(({
    currentDeviceAccessible: _currentDeviceAccessible,
    ...device
  }) => device);
  return {
    type, sourceRecordId: stored.airtableRecordId,
    deviceId: devices.length === 1 && devices[0]!.currentDeviceAccessible !== false
      ? devices[0]!.sourceRecordId
      : null,
    devices: publicDevices,
    deviceName: devices.length === 1
      ? devices[0]!.deviceName
      : devices.length > 1 ? `${devices.length} urządzenia` : stored.deviceName || "Urządzenie medyczne",
    manufacturer: devices.length === 1 ? devices[0]!.manufacturer : stored.manufacturer,
    model: devices.length === 1 ? devices[0]!.model : stored.model,
    manufacturerModel: devices.length === 1
      ? joinNonEmpty([devices[0]!.manufacturer, devices[0]!.model])
      : joinNonEmpty([stored.manufacturer, stored.model]),
    serialNumber: devices.length === 1 ? devices[0]!.serialNumber : stored.serialNumber,
    inventoryNumber: devices.length === 1 ? devices[0]!.inventoryNumber : stored.inventoryNumber,
    caseNumber: stored.businessNumber, clientOrderNumber: stored.clientOrderNumber,
    currentStatus,
    lastChangedAt: history.at(-1)?.changedAt ?? stored.sourceModifiedAt ?? stored.sourceCreatedAt,
    requiresAction: requiresCustomerAction(currentStatus),
    reportedAt: type === "REPAIR" ? stored.reportedAt : null,
    inspectionPerformedAt: type === "INSPECTION" ? stored.inspectionPerformedAt : null,
    validUntil: type === "INSPECTION" ? stored.inspectionValidUntil : null,
    description: stored.faultDescription, history, documents: [], photos: [],
  };
}

function deduplicateAssets(assets: readonly PortalAssetRow[]): PortalAssetRow[] {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (seen.has(asset.storedFile.id)) return false;
    seen.add(asset.storedFile.id);
    return true;
  });
}

function mapPortalAssets(
  assets: readonly PortalAssetRow[],
  cases: ReadonlyMap<string, PortalAssetCaseContext>,
): PortalDocument[] {
  const roleCounts = new Map<string, number>();
  return assets.flatMap((asset) => {
    const linkedCase = cases.get(asset.storedFile.sourceRecordId);
    if (!linkedCase) return [];
    const countKey = `${asset.storedFile.sourceRecordId}:${asset.role}`;
    const roleIndex = (roleCounts.get(countKey) ?? 0) + 1;
    roleCounts.set(countKey, roleIndex);
    const title = assetTitle(asset.role, roleIndex);
    return [{
      id: asset.id,
      fileName: asset.storedFile.originalFileName,
      title,
      kind: asset.storedFile.kind,
      role: asset.role,
      documentType: title,
      sourceRecordId: asset.storedFile.sourceRecordId,
      caseType: linkedCase.type,
      deviceName: linkedCase.deviceName,
      manufacturer: linkedCase.manufacturer,
      model: linkedCase.model,
      serialNumber: linkedCase.serialNumber,
      caseNumber: linkedCase.caseNumber,
      caseDate: linkedCase.caseDate,
      createdAt: asset.createdAt,
    }];
  });
}

function assetCaseContext(
  snapshot: {
    airtableRecordId: string;
    businessNumber: string | null;
    deviceName: string | null;
    manufacturer: string | null;
    model: string | null;
    serialNumber: string | null;
    reportedAt: Date | null;
    inspectionPerformedAt: Date | null;
  },
  type: "REPAIR" | "INSPECTION",
): PortalAssetCaseContext {
  return {
    type,
    sourceRecordId: snapshot.airtableRecordId,
    deviceName: snapshot.deviceName || "Urządzenie medyczne",
    manufacturer: snapshot.manufacturer,
    model: snapshot.model,
    serialNumber: snapshot.serialNumber,
    caseNumber: snapshot.businessNumber,
    caseDate: type === "REPAIR" ? snapshot.reportedAt : snapshot.inspectionPerformedAt,
  };
}

function assetTitle(role: CommunicationAssetRole, index: number): string {
  if (role === CommunicationAssetRole.REPAIR_PROTOCOL) return "Protokół naprawy";
  if (role === CommunicationAssetRole.DIAGNOSTIC_PROTOCOL) return "Protokół diagnostyczny";
  if (role === CommunicationAssetRole.PHOTO) return `Zdjęcie ${index}`;
  return index === 1 ? "Dokument przeglądu" : `Dokument przeglądu ${index}`;
}

export function requiresCustomerAction(status: string | null): boolean {
  const normalized = status?.trim().toLocaleUpperCase("pl-PL") ?? "";
  return normalized === "OCZEKUJEMY NA DECYZJĘ" || normalized === "DO REALIZACJI";
}

function parseFilter(value: string | undefined): PortalCaseFilter {
  const normalized = value?.toUpperCase();
  return normalized === "ACTION" || normalized === "REPAIR" || normalized === "INSPECTION"
    ? normalized : "ALL";
}

function normalizeSearch(value: string | undefined): string | null {
  const query = value?.trim();
  return query && query.length >= 2 ? query.slice(0, 200) : null;
}

function clampLimit(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(100, Number.isFinite(value) ? Math.trunc(value!) : fallback));
}

export function encodePortalCaseCursor(key: PortalCaseCursorKey): string {
  return Buffer.from(JSON.stringify({
    v: 1, k: key.sortKey.toString(), t: key.type, i: key.sourceRecordId,
  })).toString("base64url");
}

export function decodePortalCaseCursor(
  value: string | null,
): { sortKey: bigint; type: "REPAIR" | "INSPECTION"; sourceRecordId: string } | null {
  if (!value) return null;
  if (!isBase64Url(value)) throw new InvalidPortalCursorError();
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || (parsed.t !== "REPAIR" && parsed.t !== "INSPECTION") ||
      typeof parsed.i !== "string" || parsed.i.length === 0 ||
      typeof parsed.k !== "string" || !/^-?\d+$/.test(parsed.k)) {
      throw new InvalidPortalCursorError();
    }
    return { sortKey: BigInt(parsed.k), type: parsed.t, sourceRecordId: parsed.i };
  } catch (error: unknown) {
    if (error instanceof InvalidPortalCursorError) throw error;
    throw new InvalidPortalCursorError();
  }
}

export function encodePortalDeviceCursor(key: PortalDeviceCursorKey): string {
  return Buffer.from(JSON.stringify({
    v: 1, k: key.sortKey.toString(), i: key.sourceRecordId,
  })).toString("base64url");
}

export function decodePortalDeviceCursor(
  value: string | null,
): { sortKey: bigint; sourceRecordId: string } | null {
  if (!value) return null;
  if (!isBase64Url(value)) throw new InvalidPortalCursorError();
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || typeof parsed.i !== "string" || parsed.i.length === 0 ||
      typeof parsed.k !== "string" || !/^-?\d+$/.test(parsed.k)) {
      throw new InvalidPortalCursorError();
    }
    return { sortKey: BigInt(parsed.k), sourceRecordId: parsed.i };
  } catch (error: unknown) {
    if (error instanceof InvalidPortalCursorError) throw error;
    throw new InvalidPortalCursorError();
  }
}

function isBase64Url(value: string): boolean {
  return value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value);
}

function changeDescription(oldValue: unknown, newValue: unknown): string | null {
  const oldText = scalarText(oldValue); const newText = scalarText(newValue);
  return oldText && newText ? `${oldText} → ${newText}` : newText;
}

function scalarText(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function joinNonEmpty(values: Array<string | null>): string | null {
  const present = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return present.length > 0 ? present.join(" · ") : null;
}
