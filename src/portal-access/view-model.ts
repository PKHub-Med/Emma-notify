import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { EventType } from "../generated/prisma/enums.js";
import type { PortalAuthorizationContext } from "./public.js";
import type { PortalEntryContext } from "./service.js";

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
  repairs: string[];
  inspections: string[];
};

export type HospitalPortalViewModel = {
  hospital: {
    shortName: string;
    name: string;
    address: string | null;
  };
  serviceProviderName: string;
  summary: {
    requiresAction: number;
    repairs: number;
    inspections: number;
  };
  cases: PortalCaseListItem[];
  repairs: PortalCaseListItem[];
  inspections: PortalCaseListItem[];
  devices: PortalDevice[];
  documents: PortalDocument[];
  focusedCaseId: string | null;
};

type StoredHospital = {
  shortName: string | null;
  name: string | null;
  address: string | null;
};

type StoredEvent = {
  eventType: string;
  oldValue: unknown;
  newValue: unknown;
  detectedAt: Date;
};

export type StoredPortalCase = {
  airtableRecordId: string;
  businessNumber: string | null;
  clientOrderNumber: string | null;
  emmaCustomerStatus: string | null;
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
  sourceModifiedAt: Date | null;
  inspectionDueDate: Date | null;
  events: StoredEvent[];
};

export type StoredPortalTask = {
  airtableRecordId: string;
  emmaCustomerStatus: string | null;
  linkedInspectionRecordIds: unknown;
  linkedServiceOrderRecordIds: unknown;
  updatedAt: Date;
};

export interface HospitalPortalStore {
  findHospital(sourceHospitalRecordId: string): Promise<StoredHospital | null>;
  findRepairs(sourceHospitalRecordId: string): Promise<StoredPortalCase[]>;
  findTasks(sourceHospitalRecordId: string): Promise<StoredPortalTask[]>;
  findInspections(sourceRecordIds: readonly string[]): Promise<StoredPortalCase[]>;
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
  sourceModifiedAt: true,
  inspectionDueDate: true,
  events: {
    where: {
      visibleToCustomer: true,
      eventType: { in: [EventType.SERVICE_STATUS_CHANGED, EventType.INSPECTION_STATUS_CHANGED] },
    },
    orderBy: { detectedAt: "asc" },
    select: {
      eventType: true,
      oldValue: true,
      newValue: true,
      detectedAt: true,
    },
  },
} satisfies Prisma.TrackedCaseSelect;

export class PrismaHospitalPortalStore implements HospitalPortalStore {
  constructor(private readonly prisma: PrismaClient) {}

  findHospital(sourceHospitalRecordId: string): Promise<StoredHospital | null> {
    return this.prisma.trackedHospital.findUnique({
      where: { airtableRecordId: sourceHospitalRecordId },
      select: { shortName: true, name: true, address: true },
    });
  }

  findRepairs(sourceHospitalRecordId: string): Promise<StoredPortalCase[]> {
    return this.prisma.trackedCase.findMany({
      where: {
        caseType: "SERVICE_ORDER",
        sourceHospitalRecordId,
        active: true,
      },
      select: CASE_SELECT,
    });
  }

  findTasks(sourceHospitalRecordId: string): Promise<StoredPortalTask[]> {
    return this.prisma.trackedTask.findMany({
      where: { sourceHospitalRecordId },
      select: {
        airtableRecordId: true,
        emmaCustomerStatus: true,
        linkedInspectionRecordIds: true,
        linkedServiceOrderRecordIds: true,
        updatedAt: true,
      },
    });
  }

  findInspections(sourceRecordIds: readonly string[]): Promise<StoredPortalCase[]> {
    if (sourceRecordIds.length === 0) return Promise.resolve([]);
    return this.prisma.trackedCase.findMany({
      where: {
        caseType: "INSPECTION",
        airtableRecordId: { in: [...sourceRecordIds] },
        active: true,
      },
      select: CASE_SELECT,
    });
  }
}

export class HospitalPortalViewModelService {
  constructor(
    private readonly store: HospitalPortalStore,
    private readonly serviceProviderName = "Tiemed",
  ) {}

  async build(authorization: PortalAuthorizationContext): Promise<HospitalPortalViewModel> {
    const scope = authorization.sourceHospitalRecordId;
    const [hospital, repairs, tasks] = await Promise.all([
      this.store.findHospital(scope),
      this.store.findRepairs(scope),
      this.store.findTasks(scope),
    ]);
    const inspectionIds = unique(tasks.flatMap((task) => stringArray(task.linkedInspectionRecordIds)));
    const inspections = await this.store.findInspections(inspectionIds);
    const taskByInspectionId = newestTaskByLinkedId(tasks, "linkedInspectionRecordIds");

    const repairItems = repairs.map((item) => mapCase(item, "REPAIR"));
    const inspectionItems = inspections.map((item) => mapCase(
      item,
      "INSPECTION",
      taskByInspectionId.get(item.airtableRecordId)?.emmaCustomerStatus ?? null,
    ));
    const cases = [...repairItems, ...inspectionItems].sort(compareCases);
    const devices = buildDevices(cases);
    const fallbackHospitalName = repairs.find((item) => nonEmpty(item.hospitalName))?.hospitalName;

    return {
      hospital: {
        shortName: hospital?.shortName || hospital?.name || fallbackHospitalName || "Szpital",
        name: hospital?.name || hospital?.shortName || fallbackHospitalName || "Szpital",
        address: hospital?.address ?? null,
      },
      serviceProviderName: this.serviceProviderName,
      summary: {
        requiresAction: cases.filter((item) => item.requiresAction).length,
        repairs: repairItems.length,
        inspections: inspectionItems.length,
      },
      cases,
      repairs: repairItems.sort(compareCases),
      inspections: inspectionItems.sort(compareCases),
      devices,
      documents: [],
      focusedCaseId: resolveFocusedCase(
        authorization.entryContext,
        repairItems,
        inspectionItems,
        tasks,
      ),
    };
  }
}

function mapCase(
  stored: StoredPortalCase,
  type: "REPAIR" | "INSPECTION",
  taskCustomerStatus: string | null = null,
): PortalCaseListItem {
  const currentStatus = taskCustomerStatus || stored.emmaCustomerStatus ||
    stored.currentStatus || "Brak informacji";
  const history = stored.events.map((event) => ({
    title: event.eventType === "INSPECTION_STATUS_CHANGED"
      ? "Zmiana statusu przeglądu"
      : "Zmiana statusu",
    description: changeDescription(event.oldValue, event.newValue),
    changedAt: event.detectedAt,
  }));
  const lastChangedAt = history.at(-1)?.changedAt ?? stored.sourceModifiedAt ??
    stored.sourceCreatedAt;
  return {
    type,
    sourceRecordId: stored.airtableRecordId,
    deviceId: stored.deviceAirtableId,
    deviceName: stored.deviceName || "Urządzenie medyczne",
    manufacturer: stored.manufacturer,
    model: stored.model,
    manufacturerModel: joinNonEmpty([stored.manufacturer, stored.model]),
    serialNumber: stored.serialNumber,
    inventoryNumber: stored.inventoryNumber,
    caseNumber: stored.businessNumber,
    clientOrderNumber: stored.clientOrderNumber,
    currentStatus,
    lastChangedAt,
    requiresAction: requiresCustomerAction(currentStatus),
    reportedAt: type === "REPAIR" ? stored.sourceCreatedAt : null,
    inspectionPerformedAt: null,
    validUntil: type === "INSPECTION" ? stored.inspectionDueDate : null,
    description: stored.faultDescription,
    history,
    documents: [],
    photos: [],
  };
}

// Deliberately small, auditable allowlist of exact customer-visible states.
export function requiresCustomerAction(status: string | null): boolean {
  const normalized = status?.trim().toLocaleUpperCase("pl-PL") ?? "";
  return normalized === "OCZEKUJEMY NA DECYZJĘ" || normalized === "DO REALIZACJI";
}

function buildDevices(cases: readonly PortalCaseListItem[]): PortalDevice[] {
  const byId = new Map<string, PortalDevice>();
  for (const item of cases) {
    if (!item.deviceId) continue;
    const existing = byId.get(item.deviceId);
    if (!existing) {
      byId.set(item.deviceId, {
        sourceRecordId: item.deviceId,
        deviceName: item.deviceName,
        manufacturer: item.manufacturer,
        model: item.model,
        serialNumber: item.serialNumber,
        inventoryNumber: item.inventoryNumber,
        currentStatus: item.currentStatus,
        validUntil: item.validUntil,
        repairs: item.type === "REPAIR" ? [item.sourceRecordId] : [],
        inspections: item.type === "INSPECTION" ? [item.sourceRecordId] : [],
      });
      continue;
    }
    if (item.type === "REPAIR") existing.repairs.push(item.sourceRecordId);
    else {
      existing.inspections.push(item.sourceRecordId);
      if (item.validUntil && (!existing.validUntil || item.validUntil > existing.validUntil)) {
        existing.validUntil = item.validUntil;
      }
    }
    if ((item.lastChangedAt?.getTime() ?? 0) > newestLinkedChange(existing, cases)) {
      existing.currentStatus = item.currentStatus;
    }
  }
  return [...byId.values()].sort((a, b) => a.deviceName.localeCompare(b.deviceName, "pl"));
}

function newestLinkedChange(device: PortalDevice, cases: readonly PortalCaseListItem[]): number {
  const linked = new Set([...device.repairs, ...device.inspections]);
  return Math.max(0, ...cases.filter((item) => linked.has(item.sourceRecordId))
    .map((item) => item.lastChangedAt?.getTime() ?? 0));
}

function resolveFocusedCase(
  entry: PortalEntryContext,
  repairs: readonly PortalCaseListItem[],
  inspections: readonly PortalCaseListItem[],
  scopedTasks: readonly StoredPortalTask[],
): string | null {
  if (entry.type === "SERVICE_ORDER") {
    return repairs.some((item) => item.sourceRecordId === entry.sourceRecordId)
      ? entry.sourceRecordId
      : null;
  }
  const task = scopedTasks.find((item) => item.airtableRecordId === entry.sourceRecordId);
  if (!task) return null;
  const allowed = new Set([
    ...repairs.map((item) => item.sourceRecordId),
    ...inspections.map((item) => item.sourceRecordId),
  ]);
  return [
    ...stringArray(task.linkedInspectionRecordIds),
    ...stringArray(task.linkedServiceOrderRecordIds),
  ].find((id) => allowed.has(id)) ?? null;
}

function newestTaskByLinkedId(
  tasks: readonly StoredPortalTask[],
  key: "linkedInspectionRecordIds",
): Map<string, StoredPortalTask> {
  const result = new Map<string, StoredPortalTask>();
  for (const task of tasks) {
    for (const id of stringArray(task[key])) {
      const current = result.get(id);
      if (!current || task.updatedAt > current.updatedAt) result.set(id, task);
    }
  }
  return result;
}

function changeDescription(oldValue: unknown, newValue: unknown): string | null {
  const oldText = scalarText(oldValue);
  const newText = scalarText(newValue);
  return oldText && newText ? `${oldText} → ${newText}` : newText;
}

function scalarText(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean"
    ? String(value)
    : null;
}

function compareCases(a: PortalCaseListItem, b: PortalCaseListItem): number {
  return (b.lastChangedAt?.getTime() ?? 0) - (a.lastChangedAt?.getTime() ?? 0);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function joinNonEmpty(values: Array<string | null>): string | null {
  const present = values.filter(nonEmpty);
  return present.length > 0 ? present.join(" · ") : null;
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
