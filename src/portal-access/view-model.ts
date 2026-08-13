import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { EventType } from "../generated/prisma/enums.js";
import type { PortalAuthorizationContext } from "./public.js";
import type { PortalEntryContext } from "./service.js";

export type PortalCaseFilter = "ALL" | "ACTION" | "REPAIR" | "INSPECTION";

export type PortalHistoryItem = {
  title: string;
  description: string | null;
  changedAt: Date;
};

export type PortalDocument = {
  id: string;
  fileName: string;
  documentType: string | null;
  deviceName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  caseNumber: string | null;
};

export type PortalCaseListItem = {
  type: "REPAIR" | "INSPECTION";
  sourceRecordId: string;
  deviceId: string | null;
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

export type PortalDevice = {
  sourceRecordId: string;
  deviceName: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  currentStatus: string;
  validUntil: Date | null;
};

export type PortalDeviceDetail = PortalDevice & {
  cases: PortalPage<PortalCaseListItem>;
};

export type PortalPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type HospitalPortalViewModel = {
  hospital: { shortName: string; name: string; address: string | null };
  serviceProviderName: string;
  summary: { requiresAction: number; repairs: number; inspections: number };
  initialCases: PortalPage<PortalCaseListItem>;
  focusedCase: PortalCaseListItem | null;
};

type StoredHospital = { shortName: string | null; name: string | null; address: string | null };
type StoredEvent = { eventType: string; oldValue: unknown; newValue: unknown; detectedAt: Date };

export type StoredPortalCase = {
  airtableRecordId: string;
  businessNumber: string | null;
  clientOrderNumber: string | null;
  emmaCustomerStatus: string | null;
  taskCustomerStatus?: string | null;
  hospitalName: string | null;
  deviceAirtableId: string | null;
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

export type PortalDeviceCursorKey = { sourceRecordId: string; sortKey: bigint };

type PageKey = PortalCaseCursorKey;
type DeviceKey = PortalDeviceCursorKey;

export class InvalidPortalCursorError extends Error {
  readonly code = "INVALID_CURSOR";
  constructor() { super("INVALID_PORTAL_CURSOR"); }
}

export interface HospitalPortalStore {
  findHospital(scope: string): Promise<StoredHospital | null>;
  getSummaryCounts(scope: string): Promise<HospitalPortalViewModel["summary"]>;
  pageCases(scope: string, options: {
    filter: PortalCaseFilter;
    query: string | null;
    cursor: string | null;
    limit: number;
    deviceId?: string;
  }): Promise<PortalPage<PortalCaseListItem>>;
  findScopedCase(scope: string, sourceRecordId: string): Promise<PortalCaseListItem | null>;
  resolveFocusedCase(scope: string, entry: PortalEntryContext): Promise<PortalCaseListItem | null>;
  pageDevices(scope: string, options: {
    query: string | null;
    cursor: string | null;
    limit: number;
  }): Promise<PortalPage<PortalDevice>>;
  findScopedDevice(scope: string, sourceRecordId: string, limit: number): Promise<PortalDeviceDetail | null>;
}

const CASE_SELECT = {
  airtableRecordId: true,
  businessNumber: true,
  clientOrderNumber: true,
  emmaCustomerStatus: true,
  hospitalName: true,
  deviceAirtableId: true,
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

  async getSummaryCounts(scope: string): Promise<HospitalPortalViewModel["summary"]> {
    const rows = await this.prisma.$queryRaw<SummaryCountRow[]>(Prisma.sql`
      WITH scoped AS (${scopedCasesSql(scope)})
      SELECT
        COUNT(*) FILTER (WHERE type = 'REPAIR') AS repairs,
        COUNT(*) FILTER (WHERE type = 'INSPECTION') AS inspections,
        COUNT(*) FILTER (WHERE UPPER(TRIM(status)) IN ('OCZEKUJEMY NA DECYZJĘ', 'DO REALIZACJI')) AS "requiresAction"
      FROM scoped
    `);
    const row = rows[0];
    return {
      repairs: Number(row?.repairs ?? 0n),
      inspections: Number(row?.inspections ?? 0n),
      requiresAction: Number(row?.requiresAction ?? 0n),
    };
  }

  async pageCases(scope: string, options: {
    filter: PortalCaseFilter;
    query: string | null;
    cursor: string | null;
    limit: number;
    deviceId?: string;
  }): Promise<PortalPage<PortalCaseListItem>> {
    const cursor = decodePortalCaseCursor(options.cursor);
    const filterSql = caseFilterSql(options.filter);
    const searchSql = searchFilterSql(options.query);
    const deviceSql = options.deviceId
      ? Prisma.sql`AND "deviceId" = ${options.deviceId}`
      : Prisma.empty;
    const cursorSql = cursor
      ? Prisma.sql`AND ("sortKey", type, "sourceRecordId") < (${cursor.sortKey}, ${cursor.type}, ${cursor.sourceRecordId})`
      : Prisma.empty;
    const keys = await this.prisma.$queryRaw<PageKey[]>(Prisma.sql`
      WITH scoped AS (${scopedCasesSql(scope)})
      SELECT type, "sourceRecordId", "sortKey"
      FROM scoped
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

  async findScopedCase(scope: string, sourceRecordId: string): Promise<PortalCaseListItem | null> {
    const keys = await this.prisma.$queryRaw<PageKey[]>(Prisma.sql`
      WITH scoped AS (${scopedCasesSql(scope)})
      SELECT type, "sourceRecordId", "sortKey" FROM scoped
      WHERE "sourceRecordId" = ${sourceRecordId}
      LIMIT 1
    `);
    return (await this.loadCases(scope, keys, true))[0] ?? null;
  }

  async resolveFocusedCase(scope: string, entry: PortalEntryContext): Promise<PortalCaseListItem | null> {
    if (entry.type === "SERVICE_ORDER") return this.findScopedCase(scope, entry.sourceRecordId);
    const task = await this.prisma.trackedTask.findFirst({
      where: { airtableRecordId: entry.sourceRecordId, sourceHospitalRecordId: scope },
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

  async pageDevices(scope: string, options: {
    query: string | null;
    cursor: string | null;
    limit: number;
  }): Promise<PortalPage<PortalDevice>> {
    const cursor = decodePortalDeviceCursor(options.cursor);
    const searchSql = deviceSearchFilterSql(options.query);
    const cursorSql = cursor
      ? Prisma.sql`AND ("sortKey", "deviceId") < (${cursor.sortKey}, ${cursor.sourceRecordId})`
      : Prisma.empty;
    const keys = await this.prisma.$queryRaw<DeviceKey[]>(Prisma.sql`
      WITH scoped AS (${scopedCasesSql(scope)}), devices AS (
        SELECT DISTINCT ON ("deviceId") "deviceId" AS "sourceRecordId", "sortKey",
          "deviceName", manufacturer, model, "serialNumber", "inventoryNumber", status, "validUntil"
        FROM scoped WHERE "deviceId" IS NOT NULL
        ORDER BY "deviceId", "sortKey" DESC
      )
      SELECT "sourceRecordId", "sortKey" FROM devices
      WHERE 1=1 ${searchSql} ${cursorSql}
      ORDER BY "sortKey" DESC, "sourceRecordId" DESC
      LIMIT ${options.limit + 1}
    `);
    const hasMore = keys.length > options.limit;
    const selected = keys.slice(0, options.limit);
    const items = await Promise.all(selected.map((key) => this.loadDevice(scope, key.sourceRecordId)));
    const last = selected.at(-1);
    return {
      items: items.filter((item): item is PortalDevice => item !== null),
      nextCursor: hasMore && last ? encodePortalDeviceCursor(last) : null,
    };
  }

  async findScopedDevice(scope: string, sourceRecordId: string, limit: number): Promise<PortalDeviceDetail | null> {
    const device = await this.loadDevice(scope, sourceRecordId);
    if (!device) return null;
    return {
      ...device,
      cases: await this.pageCases(scope, {
        filter: "ALL", query: null, cursor: null, limit, deviceId: sourceRecordId,
      }),
    };
  }

  private async loadDevice(scope: string, sourceRecordId: string): Promise<PortalDevice | null> {
    const keys = await this.prisma.$queryRaw<Array<{
      sourceRecordId: string; deviceName: string | null; manufacturer: string | null;
      model: string | null; serialNumber: string | null; inventoryNumber: string | null;
      status: string | null; validUntil: Date | null;
    }>>(Prisma.sql`
      WITH scoped AS (${scopedCasesSql(scope)})
      SELECT "deviceId" AS "sourceRecordId", "deviceName", manufacturer, model,
        "serialNumber", "inventoryNumber", status, "validUntil"
      FROM scoped WHERE "deviceId" = ${sourceRecordId}
      ORDER BY "sortKey" DESC LIMIT 1
    `);
    const row = keys[0];
    return row ? {
      sourceRecordId: row.sourceRecordId,
      deviceName: row.deviceName || "Urządzenie medyczne",
      manufacturer: row.manufacturer,
      model: row.model,
      serialNumber: row.serialNumber,
      inventoryNumber: row.inventoryNumber,
      currentStatus: row.status || "Brak informacji",
      validUntil: row.validUntil,
    } : null;
  }

  private async loadCases(
    scope: string,
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
        sourceHospitalRecordId: scope,
        OR: inspectionIds.map((id) => ({ linkedInspectionRecordIds: { array_contains: [id] } })),
      },
      orderBy: { updatedAt: "desc" },
      select: { emmaCustomerStatus: true, linkedInspectionRecordIds: true },
    });
    const taskStatus = new Map<string, string | null>();
    for (const task of tasks) {
      for (const id of stringArray(task.linkedInspectionRecordIds)) {
        if (!taskStatus.has(id)) taskStatus.set(id, task.emmaCustomerStatus);
      }
    }
    const rowById = new Map(rows.map((row) => [row.airtableRecordId, row]));
    return keys.flatMap((key) => {
      const row = rowById.get(key.sourceRecordId);
      return row ? [mapCase({
        ...row,
        taskCustomerStatus: taskStatus.get(key.sourceRecordId) ?? null,
      }, key.type)] : [];
    });
  }
}

export class HospitalPortalViewModelService {
  readonly pageSize: number;

  constructor(
    private readonly store: HospitalPortalStore,
    private readonly serviceProviderName = "Tiemed",
    pageSize = 30,
  ) {
    this.pageSize = clampLimit(pageSize, 30);
  }

  async build(authorization: PortalAuthorizationContext): Promise<HospitalPortalViewModel> {
    const scope = authorization.sourceHospitalRecordId;
    const [hospital, summary, initialCases, focusedCase] = await Promise.all([
      this.store.findHospital(scope),
      this.store.getSummaryCounts(scope),
      this.store.pageCases(scope, { filter: "ALL", query: null, cursor: null, limit: this.pageSize }),
      this.store.resolveFocusedCase(scope, authorization.entryContext),
    ]);
    return {
      hospital: {
        shortName: hospital?.shortName || hospital?.name || "Szpital",
        name: hospital?.name || hospital?.shortName || "Szpital",
        address: hospital?.address ?? null,
      },
      serviceProviderName: this.serviceProviderName,
      summary,
      initialCases,
      focusedCase,
    };
  }

  listCases(authorization: PortalAuthorizationContext, options: {
    filter?: string; query?: string; cursor?: string; limit?: number;
  }): Promise<PortalPage<PortalCaseListItem>> {
    const cursor = options.cursor || null;
    if (cursor) decodePortalCaseCursor(cursor);
    return this.store.pageCases(authorization.sourceHospitalRecordId, {
      filter: parseFilter(options.filter),
      query: normalizeSearch(options.query),
      cursor,
      limit: clampLimit(options.limit, this.pageSize),
    });
  }

  getCase(authorization: PortalAuthorizationContext, id: string): Promise<PortalCaseListItem | null> {
    return this.store.findScopedCase(authorization.sourceHospitalRecordId, id);
  }

  listDevices(authorization: PortalAuthorizationContext, options: {
    query?: string; cursor?: string; limit?: number;
  }): Promise<PortalPage<PortalDevice>> {
    const cursor = options.cursor || null;
    if (cursor) decodePortalDeviceCursor(cursor);
    return this.store.pageDevices(authorization.sourceHospitalRecordId, {
      query: normalizeSearch(options.query), cursor,
      limit: clampLimit(options.limit, this.pageSize),
    });
  }

  getDevice(authorization: PortalAuthorizationContext, id: string): Promise<PortalDeviceDetail | null> {
    return this.store.findScopedDevice(authorization.sourceHospitalRecordId, id, this.pageSize);
  }
}

function scopedCasesSql(scope: string): Prisma.Sql {
  return Prisma.sql`
    SELECT 'REPAIR'::text AS type, c."airtableRecordId" AS "sourceRecordId",
      c."deviceAirtableId" AS "deviceId", c."deviceName", c.manufacturer, c.model,
      c."serialNumber", c."inventoryNumber",
      COALESCE(c."emmaCustomerStatus", c."currentStatus", 'Brak informacji') AS status,
      FLOOR(EXTRACT(EPOCH FROM COALESCE((SELECT MAX(e."detectedAt") FROM "CaseEvent" e
        WHERE e."trackedCaseId" = c.id AND e."visibleToCustomer" = true),
        c."sourceModifiedAt", c."sourceCreatedAt", TIMESTAMP '1970-01-01 00:00:00')) * 1000)::bigint AS "sortKey",
      NULL::timestamp AS "validUntil", c."businessNumber", c."clientOrderNumber"
    FROM "TrackedCase" c
    WHERE c."caseType" = 'SERVICE_ORDER' AND c.active = true
      AND c."sourceHospitalRecordId" = ${scope}
    UNION ALL
    SELECT 'INSPECTION'::text AS type, c."airtableRecordId" AS "sourceRecordId",
      c."deviceAirtableId" AS "deviceId", c."deviceName", c.manufacturer, c.model,
      c."serialNumber", c."inventoryNumber",
      COALESCE((SELECT t."emmaCustomerStatus" FROM "TrackedTask" t
        WHERE t."sourceHospitalRecordId" = ${scope}
          AND t."linkedInspectionRecordIds" ? c."airtableRecordId"
        ORDER BY t."updatedAt" DESC LIMIT 1), c."currentStatus", 'Brak informacji') AS status,
      FLOOR(EXTRACT(EPOCH FROM COALESCE((SELECT MAX(e."detectedAt") FROM "CaseEvent" e
        WHERE e."trackedCaseId" = c.id AND e."visibleToCustomer" = true),
        c."sourceModifiedAt", c."sourceCreatedAt", TIMESTAMP '1970-01-01 00:00:00')) * 1000)::bigint AS "sortKey",
      c."inspectionDueDate" AS "validUntil", c."businessNumber", c."clientOrderNumber"
    FROM "TrackedCase" c
    WHERE c."caseType" = 'INSPECTION' AND c.active = true
      AND EXISTS (SELECT 1 FROM "TrackedTask" t
        WHERE t."sourceHospitalRecordId" = ${scope}
          AND t."linkedInspectionRecordIds" ? c."airtableRecordId")
  `;
}

function caseFilterSql(filter: PortalCaseFilter): Prisma.Sql {
  if (filter === "REPAIR") return Prisma.sql`AND type = 'REPAIR'`;
  if (filter === "INSPECTION") return Prisma.sql`AND type = 'INSPECTION'`;
  if (filter === "ACTION") return Prisma.sql`AND UPPER(TRIM(status)) IN ('OCZEKUJEMY NA DECYZJĘ', 'DO REALIZACJI')`;
  return Prisma.empty;
}

function searchFilterSql(query: string | null): Prisma.Sql {
  if (!query) return Prisma.empty;
  const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  return Prisma.sql`AND CONCAT_WS(' ', "deviceName", manufacturer, model, "serialNumber", "inventoryNumber", "businessNumber", "clientOrderNumber", status) ILIKE ${pattern} ESCAPE '\\'`;
}

function deviceSearchFilterSql(query: string | null): Prisma.Sql {
  if (!query) return Prisma.empty;
  const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  return Prisma.sql`AND CONCAT_WS(' ', "deviceName", manufacturer, model, "serialNumber", "inventoryNumber") ILIKE ${pattern} ESCAPE '\\'`;
}

function mapCase(stored: StoredPortalCase, type: "REPAIR" | "INSPECTION"): PortalCaseListItem {
  const currentStatus = stored.taskCustomerStatus || stored.emmaCustomerStatus || stored.currentStatus || "Brak informacji";
  const history = stored.events.map((event) => ({
    title: event.eventType === "INSPECTION_STATUS_CHANGED" ? "Zmiana statusu przeglądu" : "Zmiana statusu",
    description: changeDescription(event.oldValue, event.newValue),
    changedAt: event.detectedAt,
  }));
  return {
    type, sourceRecordId: stored.airtableRecordId, deviceId: stored.deviceAirtableId,
    deviceName: stored.deviceName || "Urządzenie medyczne",
    manufacturer: stored.manufacturer, model: stored.model,
    manufacturerModel: joinNonEmpty([stored.manufacturer, stored.model]),
    serialNumber: stored.serialNumber, inventoryNumber: stored.inventoryNumber,
    caseNumber: stored.businessNumber, clientOrderNumber: stored.clientOrderNumber,
    currentStatus,
    lastChangedAt: history.at(-1)?.changedAt ?? stored.sourceModifiedAt ?? stored.sourceCreatedAt,
    requiresAction: requiresCustomerAction(currentStatus),
    reportedAt: type === "REPAIR" ? stored.reportedAt : null,
    inspectionPerformedAt: null,
    validUntil: type === "INSPECTION" ? stored.inspectionDueDate : null,
    description: stored.faultDescription, history, documents: [], photos: [],
  };
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
