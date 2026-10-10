import type { TemplateVariableValue } from "../email/resend-client.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type RecipientDebugField = {
  codeName: string;
  airtableFieldId: string;
  airtableDisplayName: string | null;
  value: unknown;
};

export type RecipientDebugContact = {
  recordId: string;
  source: "PRIMARY_CONTACT_LINK" | "HOSPITAL_FALLBACK_CONTACT_LINK";
  fields: RecipientDebugField[];
  rawEmail: string | null;
  normalizedEmail: string | null;
  decision: "ACCEPTED" | "REJECTED" | "SKIPPED";
  reason: string;
};

export type RecipientResolutionDebugTrace = {
  version: 1;
  sourceEntityType: string;
  sourceRecordId: string;
  hospitalRecordId: string | null;
  hospitalName: string | null;
  sourceFields: RecipientDebugField[];
  repairRecipientResolution?: {
    source: "EVENT_SNAPSHOT" | "AIRTABLE_REFETCH";
    airtableRefetched: boolean;
    refetchedAt: string | null;
  };
  contacts: RecipientDebugContact[];
  consideredAddresses: {
    address: string | null;
    normalizedAddress: string | null;
    source: string;
    decision: "ACCEPTED" | "REJECTED" | "SKIPPED";
    reason: string;
  }[];
  finalRecipients: {
    address: string;
    source: string;
    status: string;
    reason: string | null;
  }[];
};

export type EmailDebugCandidate = {
  event: {
    sourceRecordId: string;
    eventSnapshot: unknown;
    recipientResolutionDebug?: RecipientResolutionDebugTrace | null;
  };
  recipient: { email: string | null; normalizedEmail: string | null };
};

export function buildEmailDebugHtml(input: {
  candidates: readonly EmailDebugCandidate[];
  actualTo: string;
  testEmail: string;
  variables: Record<string, TemplateVariableValue>;
}): string {
  const perRecord = input.candidates.map((candidate, index) => {
    const trace = candidate.event.recipientResolutionDebug!;
    const hospitalName = trace.hospitalName ?? stringVariable(input.variables.HOSPITAL_NAME) ??
      snapshotString(candidate.event.eventSnapshot, "hospitalName") ?? "brak w danych przebiegu";
    const fields = trace.sourceFields.map(fieldRow).join("");
    const contacts = trace.contacts.length === 0
      ? "<li>Brak powiązanych kontaktów rozpatrywanych w tym przebiegu.</li>"
      : trace.contacts.map((contact) =>
        `<li><strong>${escapeHtml(contact.recordId)}</strong> (${escapeHtml(contact.source)}): ` +
        `${escapeHtml(contact.decision)} — ${escapeHtml(contact.reason)}<br>` +
        `${contact.fields.map((field) => `${fieldLabel(field)} = ${formatValue(field.value)}`).join("; ")}</li>`
      ).join("");
    const addresses = trace.consideredAddresses.length === 0
      ? "<li>Brak adresów.</li>"
      : trace.consideredAddresses.map((address) =>
        `<li>${escapeHtml(address.address ?? "brak")} — ${escapeHtml(address.source)} — ` +
        `<strong>${escapeHtml(address.decision)}</strong> (${escapeHtml(address.reason)})</li>`
      ).join("");
    const finalRecipients = trace.finalRecipients.length === 0
      ? "brak"
      : trace.finalRecipients.map((recipient) =>
        `${escapeHtml(recipient.address)} [${escapeHtml(recipient.source)}]`).join(", ");
    return `<div style="margin-top:14px;padding-top:14px;border-top:1px solid #D7A647;">` +
      `<strong>Pozycja ${index + 1}</strong><br>` +
      `Szpital / klient: ${escapeHtml(hospitalName)}<br>` +
      `Rekord źródłowy: <code>${escapeHtml(trace.sourceRecordId)}</code><br>` +
      `Rekord szpitala: <code>${escapeHtml(trace.hospitalRecordId ?? "brak")}</code>` +
      `<table role="presentation" width="100%" style="margin-top:8px;border-collapse:collapse;font-size:12px;">` +
      `<tr><th align="left">Pole wejściowe / kontekst resolution</th><th align="left">Wartość</th></tr>${fields}</table>` +
      `<div style="margin-top:8px;"><strong>Kontakty:</strong><ul style="margin:4px 0 0 18px;padding:0;">${contacts}</ul></div>` +
      `<div style="margin-top:8px;"><strong>Rozpatrzone adresy:</strong><ul style="margin:4px 0 0 18px;padding:0;">${addresses}</ul></div>` +
      `<div style="margin-top:8px;"><strong>Końcowi odbiorcy resolution:</strong> ${finalRecipients}</div>` +
      `</div>`;
  }).join("");

  const intended = unique(input.candidates.map((candidate) =>
    candidate.recipient.normalizedEmail ?? candidate.recipient.email).filter(isString));
  return `<div style="margin:0 0 22px;padding:16px;border:3px solid #D7A647;border-radius:10px;` +
    `background:#FFF8DF;color:#493714;font-family:Arial,sans-serif;font-size:13px;line-height:19px;">` +
    `<strong style="display:block;font-size:17px;">DIAGNOSTYKA ODBIORCÓW — TYLKO TEST</strong>` +
    `<div style="margin-top:8px;">Przekierowanie testowe: <strong>TAK</strong><br>` +
    `Odbiorcy zamierzeni dla tego maila: ${intended.length ? intended.map(escapeHtml).join(", ") : "brak"}<br>` +
    `Provider To: <strong>${escapeHtml(input.actualTo)}</strong><br>` +
    `Provider CC: nieużywane<br>Provider BCC: nieużywane<br>` +
    `Skonfigurowany TEST_EMAIL: ${escapeHtml(input.testEmail)}</div>${perRecord}</div>`;
}

export function assertEmailDebugTraceAvailable(candidates: readonly EmailDebugCandidate[]): void {
  if (candidates.some((candidate) => !candidate.event.recipientResolutionDebug)) {
    throw new Error("EMAIL_DEBUG_TRACE_MISSING");
  }
}

export function parseRecipientResolutionDebugTrace(
  value: unknown,
): RecipientResolutionDebugTrace | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const trace = value as Partial<RecipientResolutionDebugTrace>;
  return trace.version === 1 && typeof trace.sourceRecordId === "string" &&
    Array.isArray(trace.sourceFields) && Array.isArray(trace.contacts) &&
    Array.isArray(trace.consideredAddresses) && Array.isArray(trace.finalRecipients)
    ? trace as RecipientResolutionDebugTrace
    : null;
}

export function renderDebugEmailHtml(
  templateId: string,
  variables: Record<string, TemplateVariableValue>,
  debugBlock: string,
): string {
  if (!/^[a-z0-9-]+$/.test(templateId)) throw new Error("INVALID_TEMPLATE_ID");
  const source = readFileSync(
    join(process.cwd(), "resend-templates", `${templateId}.html`),
    "utf8",
  );
  const rendered = source.replace(/\{\{\{([A-Z0-9_]+)\}\}\}/g, (_match, key: string) =>
    String(variables[key] ?? ""));
  const withDebug = rendered.replace(/(<body\b[^>]*>)/i, `$1${debugBlock}`);
  if (withDebug === rendered) throw new Error("EMAIL_TEMPLATE_BODY_MISSING");
  return withDebug;
}

export function debugEmailSubject(
  templateId: string,
  variables: Record<string, TemplateVariableValue>,
): string {
  const title = typeof variables.EMAIL_TITLE === "string" ? variables.EMAIL_TITLE : null;
  if (title) return title;
  const visitDate = String(variables.VISIT_DATE ?? "");
  const subjects: Record<string, string> = {
    "emma-inspection-confirmed": `Przeglądy techniczne zaplanowane na ${visitDate}`,
    "emma-inspection-proposed": `Proponowany termin wizyty · ${visitDate}`,
    "emma-inspection-reminder": `Przypomnienie o zaplanowanym przeglądzie · ${visitDate}`,
    "emma-inspection-summary": `Podsumowanie przeglądów · ${visitDate}`,
  };
  return subjects[templateId] ?? "EMMA — diagnostyka odbiorców";
}

function fieldRow(field: RecipientDebugField): string {
  return `<tr><td style="padding:3px;border-top:1px solid #E8D8A7;">${fieldLabel(field)}</td>` +
    `<td style="padding:3px;border-top:1px solid #E8D8A7;">${formatValue(field.value)}</td></tr>`;
}

function fieldLabel(field: RecipientDebugField): string {
  const visible = field.airtableDisplayName ? `“${escapeHtml(field.airtableDisplayName)}” / ` : "";
  return `${visible}${escapeHtml(field.codeName)} (<code>${escapeHtml(field.airtableFieldId)}</code>)`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "<em>brak</em>";
  if (Array.isArray(value)) return escapeHtml(value.map(String).join(", ") || "brak");
  return escapeHtml(typeof value === "string" ? value : JSON.stringify(value));
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function snapshotString(snapshot: unknown, key: string): string | null {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringVariable(value: TemplateVariableValue | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function isString(value: string | null): value is string { return Boolean(value); }
