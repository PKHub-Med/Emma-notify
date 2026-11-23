import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationDeliveryStatus,
  CommunicationDiagnosticStatus,
  CommunicationRecipientResolutionStatus,
  CommunicationRecipientType,
  CommunicationScenario,
  CommunicationSourceEntityType,
} from "../generated/prisma/enums.js";
import {
  FEEDBACK_FIELDS,
  FEEDBACK_SCENARIO_LABELS,
  FEEDBACK_STATUS,
  FEEDBACK_TABLE_IDS,
  type FeedbackScenario,
  type FeedbackStatusLabel,
  type FeedbackTableKey,
} from "../airtable/feedback-fields.js";
import {
  AIRTABLE_MAX_RECORDS_PER_WRITE,
  AirtableWriteError,
  type AirtableRecordWriter,
} from "../airtable/writer.js";
import { inspectionCompletedLogicalDigestKey } from "./communication-delivery.js";

/**
 * Communication write-back to Airtable.
 *
 * Every cycle the worker:
 * 1. finds Airtable records whose communication state changed since the
 *    stored cursor (deliveries, recipient resolution, blocking diagnostics),
 * 2. marks them dirty in AirtableFeedbackRecord (a small outbox),
 * 3. recomputes the full set of feedback columns for each dirty record from
 *    PostgreSQL and PATCHes them in batches of 10.
 *
 * The values are always derived from the database, so a write is idempotent and
 * a failed write can simply be retried. Write-back never blocks email sending.
 */

export const FEEDBACK_HISTORY_LIMIT = 5;
const CURSOR_ID = "main";
const CURSOR_OVERLAP_MS = 60_000;
const SETTLE_MS = 2_000;
const DEFAULT_BATCH_LIMIT = 50;
const MAX_WRITE_ATTEMPTS = 5;
const EVENTS_PER_RECORD = 20;
const REASON_MAX_LENGTH = 250;

export type FeedbackTarget = { table: FeedbackTableKey; recordId: string };

export type FeedbackEntry = {
  key: string;
  at: Date;
  scenario: FeedbackScenario;
  status: FeedbackStatusLabel;
  recipient: string | null;
  reason: string | null;
};

export type FeedbackDelivery = {
  id: string;
  status: CommunicationDeliveryStatus;
  scenario: CommunicationScenario;
  scheduledFor: Date;
  sentAt: Date | null;
  failedAt: Date | null;
  nextRetryAt: Date | null;
  updatedAt: Date;
  cancelReason: string | null;
  lastError: string | null;
  emailMode: string | null;
  actualRecipientEmail: string | null;
  recipient: {
    recipientType: CommunicationRecipientType;
    email: string | null;
    recipientKey: string;
    resolutionReason: string | null;
  };
};

export type FeedbackFields = Record<string, string | null>;

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

const REASON_LABELS: Record<string, string> = {
  OPTED_OUT: "Odbiorca wypisał się z powiadomień",
  RECIPIENT_OPTED_OUT: "Odbiorca wypisał się z powiadomień",
  MISSING_HOSPITAL_SCOPE: "Brak jednoznacznie przypisanego szpitala",
  MISSING_HOSPITAL_SCOPE_LEGACY: "Brak jednoznacznie przypisanego szpitala",
  REMINDER_EXPIRED: "Przypomnienie straciło aktualność",
  SOURCE_STATE_CHANGED: "Stan w Airtable zmienił się przed wysyłką",
  INVALID_REMINDER_DATE: "Nieprawidłowa data wizyty",
  PRE_ACTIVATION: "Zdarzenie sprzed uruchomienia wysyłki",
  HISTORICAL_COMPLETED: "Sprawa historyczna",
  EMPTY_COMPLETED: "Brak zakończonych przeglądów",
  TASK_EMMA_MAIL_DT_EMPTY: "Brak adresu klienta – wysłano do Tiemed",
  TASK_RECIPIENT_FALLBACK_MISSING: "Brak adresu w „EMMA: mail DT” i brak adresu zapasowego",
  TASK_RECIPIENT_EMAIL_INVALID: "Nieprawidłowy adres w „EMMA: mail DT”",
  TASK_RECIPIENT_EMAIL_AMBIGUOUS: "Kilka adresów w „EMMA: mail DT”",
  TASK_RECIPIENT_AIRTABLE_READ_FAILED: "Nie udało się odczytać adresu z Airtable",
  REPAIR_RECIPIENT_EMAIL_MISSING: "Brak adresu w „EMMA: mail DT”",
  REPAIR_RECIPIENT_EMAIL_INVALID: "Nieprawidłowy adres w „EMMA: mail DT”",
  REPAIR_RECIPIENT_EMAIL_AMBIGUOUS: "Kilka adresów w „EMMA: mail DT”",
  REPAIR_RECIPIENT_AIRTABLE_READ_FAILED: "Nie udało się odczytać adresu z Airtable",
  REPAIR_RECIPIENT_SCENARIO_CHANGED: "Stan zlecenia zmienił się przed wysyłką",
  REPAIR_RECIPIENT_HOSPITAL_CHANGED: "Szpital zlecenia zmienił się przed wysyłką",
  READY_BUT_HISTORICAL: "Sprawa historyczna – mail nie jest wysyłany",
  PENDING_DATA_EXPIRED: "Brak kompletnych danych w Airtable",
  COMPLETED_SAFETY_LIMIT: "Przekroczony limit bezpieczeństwa wysyłki",
  SCENARIO_NOT_MATCHED: "Stan w Airtable nie pasuje do szablonu maila",
  NO_VALID_CLIENT_EMAIL: "Brak prawidłowego adresu klienta",
  INVALID_RECIPIENT: "Nieprawidłowy odbiorca",
  NO_COMPLETED_INSPECTIONS: "Brak zakończonych przeglądów",
  INSPECTION_SET_INCOMPLETE: "Niekompletna lista przeglądów",
  INSPECTION_RESULT_INCOMPLETE: "Brak wyniku przeglądu",
  INSPECTION_STATE_INCONSISTENT: "Niespójny stan przeglądu",
  INSPECTION_HOSPITAL_SCOPE_MISMATCH: "Przeglądy z różnych szpitali",
  REPAIR_DEVICE_DATA_PENDING: "Brak danych urządzenia",
  TEMPLATE_DATA_MISSING: "Brak danych do treści maila",
  EMAIL_NETWORK_ERROR: "Błąd połączenia z dostawcą poczty",
  RESEND_RATE_LIMITED: "Limit dostawcy poczty – ponowienie",
  RESEND_TRANSIENT_ERROR: "Chwilowy błąd dostawcy poczty",
  RESEND_REQUEST_REJECTED: "Dostawca poczty odrzucił wiadomość",
  RESEND_API_KEY_MISSING: "Brak konfiguracji dostawcy poczty",
  PORTAL_ACCESS_GRANT_FAILED: "Nie udało się utworzyć linku do Emma",
};

export function feedbackReasonLabel(code: string | null | undefined): string | null {
  const trimmed = code?.trim();
  if (!trimmed) return null;
  const blocked = trimmed.match(/^BLOCKED_CLIENT:(.+)$/);
  if (blocked?.[1]) return feedbackReasonLabel(blocked[1]);
  const direct = REASON_LABELS[trimmed];
  if (direct) return direct;
  const symbolic = trimmed.match(/[A-Z][A-Z0-9_]{3,}/g)?.find((part) => REASON_LABELS[part]);
  return (symbolic && REASON_LABELS[symbolic]) || trimmed;
}

export function isFeedbackScenario(value: string): value is FeedbackScenario {
  return Object.prototype.hasOwnProperty.call(FEEDBACK_SCENARIO_LABELS, value);
}

export function deliveryFeedbackEntry(delivery: FeedbackDelivery): FeedbackEntry | null {
  if (!isFeedbackScenario(delivery.scenario)) return null;
  const recipient = delivery.actualRecipientEmail?.trim() || delivery.recipient.email?.trim() || null;
  const test = delivery.emailMode === "TEST";
  const blockedFallback = delivery.recipient.recipientKey.startsWith("BLOCKED:");
  let status: FeedbackStatusLabel;
  let at: Date;
  let reason: string | null = null;

  switch (delivery.status) {
    case CommunicationDeliveryStatus.SENT:
      at = delivery.sentAt ?? delivery.updatedAt;
      if (blockedFallback) {
        status = FEEDBACK_STATUS.BLOCKED;
        const cause = feedbackReasonLabel(delivery.recipient.resolutionReason);
        reason = `Wysłano do Tiemed zamiast do klienta${cause ? `: ${cause}` : ""}`;
      } else {
        status = FEEDBACK_STATUS.SENT;
        if (delivery.recipient.recipientType === CommunicationRecipientType.TIEMED_FALLBACK) {
          reason = feedbackReasonLabel(delivery.recipient.resolutionReason)
            ?? "Wysłano na adres zapasowy Tiemed";
        }
      }
      break;
    case CommunicationDeliveryStatus.FAILED:
      at = delivery.failedAt ?? delivery.updatedAt;
      status = FEEDBACK_STATUS.FAILED;
      reason = feedbackReasonLabel(delivery.lastError) ?? "Błąd wysyłki";
      if (delivery.nextRetryAt) reason += " (ponowienie zaplanowane)";
      break;
    case CommunicationDeliveryStatus.CANCELLED: {
      at = delivery.updatedAt;
      const cancel = delivery.cancelReason ?? "";
      status = cancel === "RECIPIENT_OPTED_OUT" || cancel.startsWith("MISSING_HOSPITAL_SCOPE")
        ? FEEDBACK_STATUS.BLOCKED
        : FEEDBACK_STATUS.CANCELLED;
      reason = feedbackReasonLabel(cancel);
      break;
    }
    default:
      at = delivery.scheduledFor;
      status = FEEDBACK_STATUS.SCHEDULED;
      break;
  }

  return {
    key: `delivery:${delivery.id}`,
    at,
    scenario: delivery.scenario,
    status,
    recipient,
    reason: test ? `[TRYB TESTOWY] ${reason ?? ""}`.trim() : reason,
  };
}

export function buildFeedbackFields(
  table: FeedbackTableKey,
  entries: readonly FeedbackEntry[],
  timeZone: string,
): FeedbackFields | null {
  const unique = new Map<string, FeedbackEntry>();
  for (const entry of entries) {
    const existing = unique.get(entry.key);
    if (!existing || existing.at < entry.at) unique.set(entry.key, entry);
  }
  const sorted = [...unique.values()].sort((left, right) =>
    right.at.getTime() - left.at.getTime() || left.key.localeCompare(right.key));
  const latest = sorted[0];
  if (!latest) return null;
  const fields = FEEDBACK_FIELDS[table];
  const history = sorted.slice(0, FEEDBACK_HISTORY_LIMIT).map((entry) => [
    formatFeedbackDateTime(entry.at, timeZone),
    FEEDBACK_SCENARIO_LABELS[entry.scenario],
    entry.status,
    entry.recipient,
    entry.reason,
  ].filter(Boolean).join(" · "));
  return {
    [fields.type]: FEEDBACK_SCENARIO_LABELS[latest.scenario],
    [fields.status]: latest.status,
    [fields.date]: latest.at.toISOString(),
    [fields.recipient]: latest.recipient,
    [fields.reason]: truncate(latest.reason, REASON_MAX_LENGTH),
    [fields.history]: history.join("\n"),
  };
}

export function feedbackFingerprint(fields: FeedbackFields): string {
  const stable = Object.keys(fields).sort().map((key) => [key, fields[key] ?? null]);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function formatFeedbackDateTime(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("pl-PL", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")}.${part("month")}.${part("year")} ${part("hour")}:${part("minute")}`;
}

export function targetsForEvent(event: {
  sourceEntityType: CommunicationSourceEntityType;
  sourceRecordId: string;
  eventSnapshot: unknown;
}): FeedbackTarget[] {
  if (event.sourceEntityType === CommunicationSourceEntityType.SERVICE_ORDER) {
    return [{ table: "SERVICE_ORDER", recordId: event.sourceRecordId }];
  }
  if (event.sourceEntityType !== CommunicationSourceEntityType.TASK) return [];
  return [
    { table: "TASK", recordId: event.sourceRecordId },
    ...snapshotStringArray(event.eventSnapshot, "linkedInspectionRecordIds")
      .map((recordId) => ({ table: "INSPECTION" as const, recordId })),
  ];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export type PendingFeedbackRecord = {
  id: string;
  table: FeedbackTableKey;
  recordId: string;
  fingerprint: string | null;
  attemptCount: number;
};

export interface AirtableFeedbackStore {
  getOrInitCursor(now: Date): Promise<Date>;
  saveCursor(at: Date): Promise<void>;
  findChangedTargets(since: Date, until: Date): Promise<FeedbackTarget[]>;
  markDirty(targets: readonly FeedbackTarget[], at: Date): Promise<void>;
  claimPending(now: Date, limit: number): Promise<PendingFeedbackRecord[]>;
  loadEntries(target: FeedbackTarget): Promise<FeedbackEntry[]>;
  markWritten(
    id: string,
    fingerprint: string | null,
    startedAt: Date,
    at: Date,
    wroteToAirtable: boolean,
  ): Promise<void>;
  markFailed(record: PendingFeedbackRecord, error: string, at: Date): Promise<void>;
}

const deliverySelect = {
  id: true,
  status: true,
  scenario: true,
  scheduledFor: true,
  sentAt: true,
  failedAt: true,
  nextRetryAt: true,
  updatedAt: true,
  cancelReason: true,
  lastError: true,
  emailMode: true,
  actualRecipientEmail: true,
  communicationEventRecipient: {
    select: { recipientType: true, email: true, recipientKey: true, resolutionReason: true },
  },
} satisfies Prisma.CommunicationDeliverySelect;

type SelectedDelivery = Prisma.CommunicationDeliveryGetPayload<{ select: typeof deliverySelect }>;

export class PrismaAirtableFeedbackStore implements AirtableFeedbackStore {
  constructor(private readonly prisma: PrismaClient) {}

  async getOrInitCursor(now: Date): Promise<Date> {
    // First start: begin from "now". Records from before the rollout stay empty.
    const state = await this.prisma.airtableFeedbackState.upsert({
      where: { id: CURSOR_ID },
      create: { id: CURSOR_ID, cursorAt: now },
      update: {},
      select: { cursorAt: true },
    });
    return state.cursorAt;
  }

  async saveCursor(at: Date): Promise<void> {
    await this.prisma.airtableFeedbackState.updateMany({
      where: { id: CURSOR_ID, cursorAt: { lt: at } },
      data: { cursorAt: at },
    });
  }

  async findChangedTargets(since: Date, until: Date): Promise<FeedbackTarget[]> {
    const window = { gt: since, lte: until };
    const eventSelect = {
      sourceEntityType: true,
      sourceRecordId: true,
      scenario: true,
      eventSnapshot: true,
    } as const;
    const [deliveries, events, diagnostics] = await Promise.all([
      this.prisma.communicationDelivery.findMany({
        where: { updatedAt: window },
        select: { communicationEvent: { select: eventSelect } },
      }),
      this.prisma.communicationEvent.findMany({
        where: { OR: [{ createdAt: window }, { recipientsResolvedAt: window }] },
        select: eventSelect,
      }),
      this.prisma.communicationDiagnostic.findMany({
        where: {
          updatedAt: window,
          scenario: { not: null },
          status: CommunicationDiagnosticStatus.BLOCKED,
          sourceEntityType: {
            in: [CommunicationSourceEntityType.SERVICE_ORDER, CommunicationSourceEntityType.TASK],
          },
        },
        select: { sourceEntityType: true, sourceRecordId: true },
      }),
    ]);

    const changedEvents = [...deliveries.map((delivery) => delivery.communicationEvent), ...events];
    const targets = changedEvents.flatMap(targetsForEvent);

    // One INSPECTION_COMPLETED email covers every Task of the same hospital and
    // day; only the first Task owns the delivery row, so mark its siblings too.
    for (const event of changedEvents) {
      if (event.scenario !== CommunicationScenario.INSPECTION_COMPLETED) continue;
      for (const sibling of await this.findInspectionCompletedSiblings(event.eventSnapshot)) {
        targets.push(...targetsForEvent(sibling));
      }
    }

    for (const diagnostic of diagnostics) {
      if (diagnostic.sourceEntityType === CommunicationSourceEntityType.SERVICE_ORDER) {
        targets.push({ table: "SERVICE_ORDER", recordId: diagnostic.sourceRecordId });
        continue;
      }
      targets.push({ table: "TASK", recordId: diagnostic.sourceRecordId });
      const task = await this.prisma.trackedTask.findUnique({
        where: { airtableRecordId: diagnostic.sourceRecordId },
        select: { linkedInspectionRecordIds: true },
      });
      for (const recordId of jsonStringArray(task?.linkedInspectionRecordIds)) {
        targets.push({ table: "INSPECTION", recordId });
      }
    }
    return uniqueTargets(targets);
  }

  async markDirty(targets: readonly FeedbackTarget[], at: Date): Promise<void> {
    for (const target of targets) {
      const tableId = FEEDBACK_TABLE_IDS[target.table];
      await this.prisma.airtableFeedbackRecord.upsert({
        where: { tableId_recordId: { tableId, recordId: target.recordId } },
        create: { tableId, recordId: target.recordId, pending: true, dirtyAt: at },
        update: { pending: true, dirtyAt: at, attemptCount: 0, nextAttemptAt: null },
      });
    }
  }

  async claimPending(now: Date, limit: number): Promise<PendingFeedbackRecord[]> {
    const rows = await this.prisma.airtableFeedbackRecord.findMany({
      where: {
        pending: true,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { dirtyAt: "asc" },
      take: limit,
      select: { id: true, tableId: true, recordId: true, fingerprint: true, attemptCount: true },
    });
    return rows.flatMap((row) => {
      const table = tableKeyForId(row.tableId);
      return table ? [{
        id: row.id,
        table,
        recordId: row.recordId,
        fingerprint: row.fingerprint,
        attemptCount: row.attemptCount,
      }] : [];
    });
  }

  async loadEntries(target: FeedbackTarget): Promise<FeedbackEntry[]> {
    const eventWhere: Prisma.CommunicationEventWhereInput = target.table === "SERVICE_ORDER"
      ? { sourceEntityType: CommunicationSourceEntityType.SERVICE_ORDER, sourceRecordId: target.recordId }
      : target.table === "TASK"
        ? { sourceEntityType: CommunicationSourceEntityType.TASK, sourceRecordId: target.recordId }
        : {
            sourceEntityType: CommunicationSourceEntityType.TASK,
            eventSnapshot: { path: ["linkedInspectionRecordIds"], array_contains: [target.recordId] },
          };
    const events = await this.prisma.communicationEvent.findMany({
      where: eventWhere,
      orderBy: { detectedAt: "desc" },
      take: EVENTS_PER_RECORD,
      select: {
        id: true,
        scenario: true,
        detectedAt: true,
        recipientsResolvedAt: true,
        processedAt: true,
        eventSnapshot: true,
        recipients: {
          select: {
            recipientType: true,
            email: true,
            normalizedEmail: true,
            recipientKey: true,
            resolutionStatus: true,
            resolutionReason: true,
            delivery: { select: deliverySelect },
          },
        },
      },
    });

    const entries: FeedbackEntry[] = [];
    for (const event of events) {
      if (!isFeedbackScenario(event.scenario)) continue;
      const deliverable = event.recipients.filter((recipient) =>
        recipient.resolutionStatus === CommunicationRecipientResolutionStatus.READY ||
        recipient.resolutionStatus === CommunicationRecipientResolutionStatus.FALLBACK);
      let eventHasEntry = false;

      for (const recipient of event.recipients) {
        if (!recipient.delivery) continue;
        const entry = deliveryFeedbackEntry(toFeedbackDelivery(recipient.delivery));
        if (entry) { entries.push(entry); eventHasEntry = true; }
      }
      if (eventHasEntry) continue;

      if (event.processedAt && event.scenario === CommunicationScenario.INSPECTION_COMPLETED) {
        for (const recipient of deliverable) {
          const key = inspectionCompletedLogicalDigestKey(event, recipient);
          if (!key) continue;
          const shared = await this.prisma.communicationDelivery.findUnique({
            where: { logicalDigestKey: key },
            select: deliverySelect,
          });
          const entry = shared ? deliveryFeedbackEntry(toFeedbackDelivery(shared)) : null;
          if (entry) { entries.push(entry); eventHasEntry = true; }
        }
        if (eventHasEntry) continue;
      }

      if (event.recipientsResolvedAt && deliverable.length === 0) {
        const rejected = event.recipients.find((recipient) => recipient.resolutionReason);
        entries.push({
          key: `event:${event.id}`,
          at: event.recipientsResolvedAt,
          scenario: event.scenario,
          status: FEEDBACK_STATUS.NOT_SENT,
          recipient: rejected?.email ?? null,
          reason: feedbackReasonLabel(rejected?.resolutionReason) ?? "Brak prawidłowego odbiorcy",
        });
        continue;
      }

      if (!event.processedAt) {
        const retrying = event.recipients.some((recipient) =>
          recipient.resolutionStatus === CommunicationRecipientResolutionStatus.FAILED);
        entries.push({
          key: `event:${event.id}`,
          at: event.detectedAt,
          scenario: event.scenario,
          status: FEEDBACK_STATUS.SCHEDULED,
          recipient: deliverable[0]?.email ?? null,
          reason: retrying ? "Ustalanie odbiorcy – ponowienie" : null,
        });
      }
    }

    entries.push(...await this.loadBlockedDiagnosticEntries(target));
    return entries;
  }

  async markWritten(
    id: string,
    fingerprint: string | null,
    startedAt: Date,
    at: Date,
    wroteToAirtable: boolean,
  ): Promise<void> {
    await this.prisma.airtableFeedbackRecord.update({
      where: { id },
      data: {
        fingerprint,
        ...(wroteToAirtable ? { lastWrittenAt: at } : {}),
        attemptCount: 0,
        nextAttemptAt: null,
        lastError: null,
      },
    });
    // A newer change that arrived during the write keeps the record pending.
    await this.prisma.airtableFeedbackRecord.updateMany({
      where: { id, dirtyAt: { lte: startedAt } },
      data: { pending: false },
    });
  }

  async markFailed(record: PendingFeedbackRecord, error: string, at: Date): Promise<void> {
    const attemptCount = record.attemptCount + 1;
    const exhausted = attemptCount >= MAX_WRITE_ATTEMPTS;
    await this.prisma.airtableFeedbackRecord.update({
      where: { id: record.id },
      data: {
        attemptCount,
        lastError: error.slice(0, 500),
        pending: !exhausted,
        nextAttemptAt: exhausted
          ? null
          : new Date(at.getTime() + 30_000 * 2 ** (attemptCount - 1)),
      },
    });
  }

  private async findInspectionCompletedSiblings(snapshot: unknown) {
    const hospital = snapshotValue(snapshot, "sourceHospitalRecordId");
    const day = snapshotValue(snapshot, "day");
    if (typeof hospital !== "string" || !hospital || day === undefined || day === null) return [];
    return this.prisma.communicationEvent.findMany({
      where: {
        scenario: CommunicationScenario.INSPECTION_COMPLETED,
        sourceEntityType: CommunicationSourceEntityType.TASK,
        AND: [
          { eventSnapshot: { path: ["sourceHospitalRecordId"], equals: hospital } },
          { eventSnapshot: { path: ["day"], equals: day as Prisma.InputJsonValue } },
        ],
      },
      select: { sourceEntityType: true, sourceRecordId: true, eventSnapshot: true },
    });
  }

  private async loadBlockedDiagnosticEntries(target: FeedbackTarget): Promise<FeedbackEntry[]> {
    let where: Prisma.CommunicationDiagnosticWhereInput;
    if (target.table === "INSPECTION") {
      const tasks = await this.prisma.trackedTask.findMany({
        where: { linkedInspectionRecordIds: { array_contains: [target.recordId] } },
        select: { airtableRecordId: true },
      });
      if (tasks.length === 0) return [];
      where = {
        sourceEntityType: CommunicationSourceEntityType.TASK,
        sourceRecordId: { in: tasks.map((task) => task.airtableRecordId) },
      };
    } else {
      where = {
        sourceEntityType: target.table === "SERVICE_ORDER"
          ? CommunicationSourceEntityType.SERVICE_ORDER
          : CommunicationSourceEntityType.TASK,
        sourceRecordId: target.recordId,
      };
    }
    const diagnostics = await this.prisma.communicationDiagnostic.findMany({
      where: {
        ...where,
        status: CommunicationDiagnosticStatus.BLOCKED,
        scenario: { not: null },
        communicationDeliveryId: null,
      },
      select: { id: true, scenario: true, reasonCode: true, firstDetectedAt: true },
    });
    return diagnostics.flatMap((diagnostic) =>
      diagnostic.scenario && isFeedbackScenario(diagnostic.scenario)
        ? [{
            key: `diagnostic:${diagnostic.id}`,
            at: diagnostic.firstDetectedAt,
            scenario: diagnostic.scenario,
            status: FEEDBACK_STATUS.BLOCKED,
            recipient: null,
            reason: feedbackReasonLabel(diagnostic.reasonCode),
          }]
        : []);
  }
}

function toFeedbackDelivery(delivery: SelectedDelivery): FeedbackDelivery {
  return {
    id: delivery.id,
    status: delivery.status,
    scenario: delivery.scenario,
    scheduledFor: delivery.scheduledFor,
    sentAt: delivery.sentAt,
    failedAt: delivery.failedAt,
    nextRetryAt: delivery.nextRetryAt,
    updatedAt: delivery.updatedAt,
    cancelReason: delivery.cancelReason,
    lastError: delivery.lastError,
    emailMode: delivery.emailMode,
    actualRecipientEmail: delivery.actualRecipientEmail,
    recipient: delivery.communicationEventRecipient,
  };
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

export async function runAirtableFeedbackOnce(input: {
  store: AirtableFeedbackStore;
  writer: AirtableRecordWriter;
  timeZone: string;
  now?: () => Date;
  limit?: number;
  log?: (message: string) => void;
}): Promise<{ marked: number; written: number; skipped: number; failed: number }> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const until = new Date(startedAt.getTime() - SETTLE_MS);
  const cursor = await input.store.getOrInitCursor(until);
  let marked = 0;
  if (until > cursor) {
    const targets = await input.store.findChangedTargets(
      new Date(cursor.getTime() - CURSOR_OVERLAP_MS),
      until,
    );
    await input.store.markDirty(targets, startedAt);
    await input.store.saveCursor(until);
    marked = targets.length;
  }

  const pending = await input.store.claimPending(startedAt, input.limit ?? DEFAULT_BATCH_LIMIT);
  const result = { marked, written: 0, skipped: 0, failed: 0 };
  const writes = new Map<FeedbackTableKey, Array<{ record: PendingFeedbackRecord;
    fields: FeedbackFields; fingerprint: string }>>();

  for (const record of pending) {
    let fields: FeedbackFields | null;
    try {
      fields = buildFeedbackFields(
        record.table,
        await input.store.loadEntries(record),
        input.timeZone,
      );
    } catch (error: unknown) {
      await input.store.markFailed(record, safeError(error), now());
      result.failed += 1;
      continue;
    }
    const fingerprint = fields ? feedbackFingerprint(fields) : null;
    if (!fields || fingerprint === record.fingerprint) {
      await input.store.markWritten(record.id, record.fingerprint, startedAt, now(), false);
      result.skipped += 1;
      continue;
    }
    const list = writes.get(record.table) ?? [];
    list.push({ record, fields, fingerprint: fingerprint! });
    writes.set(record.table, list);
  }

  for (const [table, items] of writes) {
    for (let index = 0; index < items.length; index += AIRTABLE_MAX_RECORDS_PER_WRITE) {
      const chunk = items.slice(index, index + AIRTABLE_MAX_RECORDS_PER_WRITE);
      const outcome = await writeChunk(input, table, chunk, startedAt, now);
      result.written += outcome.written;
      result.failed += outcome.failed;
    }
  }

  if (result.written > 0 || result.failed > 0) {
    input.log?.(
      `AIRTABLE_FEEDBACK_CYCLE marked=${result.marked} written=${result.written} ` +
      `skipped=${result.skipped} failed=${result.failed}`,
    );
  }
  return result;
}

async function writeChunk(
  input: Parameters<typeof runAirtableFeedbackOnce>[0],
  table: FeedbackTableKey,
  chunk: Array<{ record: PendingFeedbackRecord; fields: FeedbackFields; fingerprint: string }>,
  startedAt: Date,
  now: () => Date,
): Promise<{ written: number; failed: number }> {
  const tableId = FEEDBACK_TABLE_IDS[table];
  try {
    await input.writer.updateRecords(
      tableId,
      chunk.map((item) => ({ id: item.record.recordId, fields: item.fields })),
    );
    for (const item of chunk) {
      await input.store.markWritten(item.record.id, item.fingerprint, startedAt, now(), true);
    }
    return { written: chunk.length, failed: 0 };
  } catch (error: unknown) {
    if (chunk.length > 1) {
      // One deleted or locked record fails the whole batch: isolate it.
      let written = 0;
      let failed = 0;
      for (const item of chunk) {
        const outcome = await writeChunk(input, table, [item], startedAt, now);
        written += outcome.written;
        failed += outcome.failed;
      }
      return { written, failed };
    }
    const item = chunk[0]!;
    const message = safeError(error);
    await input.store.markFailed(item.record, message, now());
    input.log?.(
      `AIRTABLE_FEEDBACK_WRITE_FAILED table=${table} recordId=${item.record.recordId} ` +
      `attempt=${item.record.attemptCount + 1} error=${message}`,
    );
    return { written: 0, failed: 1 };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeError(error: unknown): string {
  if (error instanceof AirtableWriteError) {
    return [error.code, error.airtableErrorType].filter(Boolean).join(":");
  }
  if (error instanceof Error) return `${error.name}:${error.message}`.slice(0, 300);
  return "UNKNOWN_ERROR";
}

function truncate(value: string | null, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function tableKeyForId(tableId: string): FeedbackTableKey | null {
  for (const [key, id] of Object.entries(FEEDBACK_TABLE_IDS)) {
    if (id === tableId) return key as FeedbackTableKey;
  }
  return null;
}

function uniqueTargets(targets: readonly FeedbackTarget[]): FeedbackTarget[] {
  const seen = new Map<string, FeedbackTarget>();
  for (const target of targets) {
    if (!target.recordId) continue;
    seen.set(`${target.table}:${target.recordId}`, target);
  }
  return [...seen.values()];
}

function snapshotValue(snapshot: unknown, key: string): unknown {
  return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>)[key]
    : undefined;
}

function snapshotStringArray(snapshot: unknown, key: string): string[] {
  return jsonStringArray(snapshotValue(snapshot, key));
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
        typeof item === "string" && item.trim().length > 0))]
    : [];
}
