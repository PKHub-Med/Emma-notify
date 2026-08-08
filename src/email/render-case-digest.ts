import type { EmailMode } from "./recipient.js";

export type CaseDigestRenderInput = {
  mode: EmailMode;
  intendedRecipientEmail: string;
  items: readonly { snapshot: unknown; changes: unknown }[];
};

export type RenderedEmail = { html: string; text: string };

type Card = {
  caseType: string | null;
  deviceName: string | null;
  deviceDetails: string | null;
  businessNumber: string | null;
  currentStatus: string | null;
  changeFrom: string | null;
  changeTo: string | null;
  faultDescription: string | null;
  dueDate: string | null;
  scheduledDate: string | null;
  bookingStatus: string | null;
};

export function renderCaseDigest(input: CaseDigestRenderInput): RenderedEmail {
  const cards = input.items.map(toCard);
  const count = cards.length;
  const heading = count === 1
    ? "Aktualizacja dotycząca urządzenia"
    : `${count} aktualizacje dotyczące Twoich urządzeń`;
  const bannerHtml = input.mode === "TEST"
    ? `<div style="background:#fff4cc;color:#5f4500;padding:10px 18px;font-size:13px;line-height:1.45;border-bottom:1px solid #ead58a"><strong>TRYB TESTOWY — wiadomość nie została wysłana do klienta.</strong><br>Docelowy odbiorca: ${escapeHtml(input.intendedRecipientEmail)}</div>`
    : "";
  const bannerText = input.mode === "TEST"
    ? `TRYB TESTOWY — wiadomość nie została wysłana do klienta.\nDocelowy odbiorca: ${input.intendedRecipientEmail}\n\n`
    : "";

  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f6f8;color:#1f2933;font-family:Arial,sans-serif"><div style="max-width:600px;margin:0 auto;background:#ffffff">${bannerHtml}<div style="padding:28px 20px 12px"><div style="font-size:22px;font-weight:700;color:#14324a">Emma</div><h1 style="margin:18px 0 8px;font-size:24px;line-height:1.25">${escapeHtml(heading)}</h1><p style="margin:0;color:#52606d;font-size:15px;line-height:1.6">Poniżej znajdziesz najnowsze zmiany dotyczące Twoich urządzeń.</p></div><div style="padding:8px 20px 28px">${cards.map(renderCardHtml).join("")}</div></div></body></html>`;
  const text = `${bannerText}Emma\n\n${heading}\n\nPoniżej znajdziesz najnowsze zmiany dotyczące Twoich urządzeń.\n\n${cards.map(renderCardText).join("\n\n---\n\n")}`;
  return { html, text };
}

function toCard(item: { snapshot: unknown; changes: unknown }): Card {
  const snapshot = asRecord(item.snapshot);
  const device = asRecord(snapshot.device);
  const inspection = asRecord(snapshot.inspection);
  const changes = Array.isArray(item.changes)
    ? item.changes.map(asRecord).filter((change) => change.fieldName === "STATUS")
    : [];
  const firstChange = changes[0];
  const lastChange = changes.at(-1);
  const manufacturer = readString(device, "manufacturer");
  const model = readString(device, "model");
  return {
    caseType: readString(snapshot, "caseType"),
    deviceName: readString(device, "name"),
    deviceDetails: [manufacturer, model].filter(Boolean).join(" ") || null,
    businessNumber: readString(snapshot, "businessNumber"),
    currentStatus: readString(snapshot, "currentStatus"),
    changeFrom: firstChange ? readString(firstChange, "oldValue") : null,
    changeTo: lastChange ? readString(lastChange, "newValue") : null,
    faultDescription: readString(snapshot, "faultDescription"),
    dueDate: readString(inspection, "dueDate"),
    scheduledDate: readString(inspection, "scheduledDate"),
    bookingStatus: readString(inspection, "bookingStatus"),
  };
}

function renderCardHtml(card: Card): string {
  const caseLabel = card.caseType === "INSPECTION" ? "Przegląd" : "Zlecenie";
  const optionalRows = [
    htmlRow("Zmiana", changeText(card)),
    htmlRow("Usterka", card.faultDescription),
    htmlRow("Następny termin", formatDate(card.dueDate)),
    htmlRow("Zaplanowano", formatDate(card.scheduledDate)),
    htmlRow("Status rezerwacji", card.bookingStatus),
  ].filter(Boolean).join("");
  return `<section style="margin-top:16px;border:1px solid #d9e2ec;border-radius:10px;padding:18px"><div style="font-size:18px;font-weight:700;line-height:1.35">${escapeHtml(card.deviceName ?? "Urządzenie")}</div>${card.deviceDetails ? `<div style="margin-top:3px;color:#52606d;font-size:14px">${escapeHtml(card.deviceDetails)}</div>` : ""}${card.businessNumber ? `<div style="margin-top:15px;font-size:14px"><strong>${caseLabel}:</strong> ${escapeHtml(card.businessNumber)}</div>` : ""}${card.currentStatus ? `<div style="margin-top:18px"><div style="font-size:11px;letter-spacing:.08em;color:#627d98;font-weight:700">AKTUALNY STATUS</div><div style="margin-top:4px;font-size:18px;font-weight:700;color:#0b6b4f">${escapeHtml(card.currentStatus)}</div></div>` : ""}${optionalRows}</section>`;
}

function renderCardText(card: Card): string {
  const caseLabel = card.caseType === "INSPECTION" ? "Przegląd" : "Zlecenie";
  const changed = changeText(card);
  const dueDate = formatDate(card.dueDate);
  const scheduledDate = formatDate(card.scheduledDate);
  return [
    card.deviceName ?? "Urządzenie",
    card.deviceDetails,
    card.businessNumber ? `${caseLabel}: ${card.businessNumber}` : null,
    card.currentStatus ? `AKTUALNY STATUS\n${card.currentStatus}` : null,
    changed ? `Zmiana: ${changed}` : null,
    card.faultDescription ? `Usterka: ${card.faultDescription}` : null,
    dueDate ? `Następny termin: ${dueDate}` : null,
    scheduledDate ? `Zaplanowano: ${scheduledDate}` : null,
    card.bookingStatus ? `Status rezerwacji: ${card.bookingStatus}` : null,
  ].filter((value): value is string => Boolean(value)).join("\n");
}

function htmlRow(label: string, value: string | null): string {
  return value
    ? `<div style="margin-top:14px;font-size:14px;line-height:1.5"><strong>${escapeHtml(label)}:</strong><br>${escapeHtml(value)}</div>`
    : "";
}

function changeText(card: Card): string | null {
  return card.changeFrom && card.changeTo
    ? `${card.changeFrom} → ${card.changeTo}`
    : null;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Warsaw",
  }).format(date);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
