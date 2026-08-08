import type { PrismaClient } from "../generated/prisma/client.js";
import {
  assertSigningSecret,
  parseAccessLinkToken,
  verifyAccessLinkToken,
} from "./token.js";

export type PublicCaseEvent = {
  eventType: string;
  oldValue: unknown;
  newValue: unknown;
  detectedAt: Date;
};

export type PublicTrackedCase = {
  caseType: string;
  businessNumber: string | null;
  deviceName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  currentStatus: string | null;
  faultDescription: string | null;
  inspectionDueDate: Date | null;
  inspectionScheduledDate: Date | null;
  inspectionBookingStatus: string | null;
  events: PublicCaseEvent[];
};

export type PublicAccessLinkRecord = {
  id: string;
  publicId: string;
  digestId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  digest: { items: { trackedCase: PublicTrackedCase }[] };
};

export interface PublicAccessLinkStore {
  findByPublicId(publicId: string): Promise<PublicAccessLinkRecord | null>;
  recordValidOpen(id: string, now: Date): Promise<boolean>;
}

export class PrismaPublicAccessLinkStore implements PublicAccessLinkStore {
  constructor(private readonly prisma: PrismaClient) {}

  findByPublicId(publicId: string): Promise<PublicAccessLinkRecord | null> {
    return this.prisma.accessLink.findUnique({
      where: { publicId },
      select: {
        id: true,
        publicId: true,
        digestId: true,
        expiresAt: true,
        revokedAt: true,
        digest: {
          select: {
            items: {
              orderBy: { createdAt: "asc" },
              select: {
                trackedCase: {
                  select: {
                    caseType: true,
                    businessNumber: true,
                    deviceName: true,
                    manufacturer: true,
                    model: true,
                    serialNumber: true,
                    inventoryNumber: true,
                    currentStatus: true,
                    faultDescription: true,
                    inspectionDueDate: true,
                    inspectionScheduledDate: true,
                    inspectionBookingStatus: true,
                    events: {
                      where: {
                        visibleToCustomer: true,
                        eventType: {
                          in: [
                            "SERVICE_STATUS_CHANGED",
                            "INSPECTION_STATUS_CHANGED",
                          ],
                        },
                      },
                      orderBy: { detectedAt: "desc" },
                      take: 10,
                      select: {
                        eventType: true,
                        oldValue: true,
                        newValue: true,
                        detectedAt: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }) as Promise<PublicAccessLinkRecord | null>;
  }

  async recordValidOpen(id: string, now: Date): Promise<boolean> {
    const updated = await this.prisma.accessLink.updateMany({
      where: { id, revokedAt: null, expiresAt: { gt: now } },
      data: { openCount: { increment: 1 }, lastOpenedAt: now },
    });
    return updated.count === 1;
  }
}

export type PublicPageResponse = {
  status: 200 | 404 | 410;
  html: string;
};

export class PublicAccessLinkService {
  constructor(
    private readonly store: PublicAccessLinkStore,
    private readonly signingSecret: string,
  ) {
    assertSigningSecret(signingSecret);
  }

  async open(token: string, now = new Date()): Promise<PublicPageResponse> {
    const parsed = parseAccessLinkToken(token);
    if (!parsed) return notFoundPage();
    const link = await this.store.findByPublicId(parsed.publicId);
    if (!link || !verifyAccessLinkToken(token, link, this.signingSecret)) {
      return notFoundPage();
    }
    if (link.revokedAt || link.expiresAt.getTime() <= now.getTime()) {
      return inactivePage();
    }
    if (!await this.store.recordValidOpen(link.id, now)) {
      return inactivePage();
    }
    return { status: 200, html: renderDigestPage(link.digest.items) };
  }
}

export const PUBLIC_PAGE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'none'; font-src 'none'",
} as const;

export function notFoundPage(): PublicPageResponse {
  return { status: 404, html: renderMessagePage("Nie znaleziono strony.", null) };
}

export function inactivePage(): PublicPageResponse {
  return {
    status: 410,
    html: renderMessagePage(
      "Ten link nie jest już aktywny.",
      "Ze względów bezpieczeństwa link do informacji o urządzeniach jest aktywny przez ograniczony czas.",
    ),
  };
}

function renderDigestPage(items: { trackedCase: PublicTrackedCase }[]): string {
  const cards = items.map(({ trackedCase }) => renderCaseCard(trackedCase)).join("");
  return pageShell(`
    <header class="brand"><span class="mark">E</span><span>Emma</span></header>
    <main>
      <h1>Aktualne informacje o urządzeniach</h1>
      <p class="lead">Poniżej znajdziesz aktualny stan urządzeń objętych ostatnią aktualizacją.</p>
      <div class="cards">${cards}</div>
    </main>`);
}

function renderCaseCard(trackedCase: PublicTrackedCase): string {
  const deviceDetails = [trackedCase.manufacturer, trackedCase.model]
    .filter(nonEmpty).map(escapeHtml).join(" · ");
  const caseLabel = trackedCase.caseType === "INSPECTION" ? "Przegląd" : "Zlecenie";
  const details = [
    detailRow("Nr inwentarzowy", trackedCase.inventoryNumber),
    detailRow("Numer seryjny", trackedCase.serialNumber),
    detailRow("Usterka", trackedCase.faultDescription),
    trackedCase.caseType === "INSPECTION"
      ? detailRow("Planowana data", formatDate(trackedCase.inspectionScheduledDate))
      : "",
    trackedCase.caseType === "INSPECTION"
      ? detailRow("Następny termin", formatDate(trackedCase.inspectionDueDate))
      : "",
    trackedCase.caseType === "INSPECTION"
      ? detailRow("Status umówienia", trackedCase.inspectionBookingStatus)
      : "",
  ].join("");
  const timeline = trackedCase.events.length > 0
    ? `<section class="timeline"><h3>Historia zmian</h3>${trackedCase.events.map(renderEvent).join("")}</section>`
    : "";
  return `<article class="card">
    <h2>${escapeHtml(trackedCase.deviceName || "Urządzenie medyczne")}</h2>
    ${deviceDetails ? `<p class="muted">${deviceDetails}</p>` : ""}
    ${trackedCase.businessNumber ? `<p class="case-number">${caseLabel} ${escapeHtml(trackedCase.businessNumber)}</p>` : ""}
    <div class="status"><span>AKTUALNY STATUS</span><strong>${escapeHtml(trackedCase.currentStatus || "Brak informacji")}</strong></div>
    ${details}${timeline}
  </article>`;
}

function renderEvent(event: PublicCaseEvent): string {
  const label = event.eventType === "INSPECTION_STATUS_CHANGED"
    ? "Zmiana statusu przeglądu"
    : "Zmiana statusu";
  const oldValue = customerValue(event.oldValue);
  const newValue = customerValue(event.newValue);
  const change = oldValue && newValue
    ? `<div>${escapeHtml(oldValue)} → ${escapeHtml(newValue)}</div>`
    : "";
  return `<div class="event"><div><strong>${label}</strong>${change}</div><time>${escapeHtml(formatDateTime(event.detectedAt))}</time></div>`;
}

function detailRow(label: string, value: string | null): string {
  return nonEmpty(value)
    ? `<div class="detail"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`
    : "";
}

function renderMessagePage(title: string, message: string | null): string {
  return pageShell(`<header class="brand"><span class="mark">E</span><span>Emma</span></header><main class="message"><h1>${escapeHtml(title)}</h1>${message ? `<p class="lead">${escapeHtml(message)}</p>` : ""}</main>`);
}

function pageShell(content: string): string {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Emma</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f6f7f8;color:#17212b;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}.brand,main{max-width:760px;margin:auto}.brand{display:flex;align-items:center;gap:10px;padding:28px 18px 14px;font-size:21px;font-weight:750}.mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#1f7a68;color:#fff}main{padding:10px 18px 48px}h1{font-size:clamp(26px,6vw,38px);line-height:1.15;margin:18px 0 12px}h2{font-size:21px;margin:0}.lead,.muted{color:#667085}.lead{font-size:17px;margin:0 0 28px}.cards{display:grid;gap:18px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:22px;box-shadow:0 3px 14px rgba(23,33,43,.05)}.muted{margin:4px 0}.case-number{margin:18px 0 12px;font-weight:650}.status{background:#e6f2ef;border-radius:12px;padding:14px 16px;margin:12px 0 18px}.status span{display:block;color:#667085;font-size:11px;font-weight:750;letter-spacing:.08em}.status strong{display:block;color:#1f7a68;font-size:20px;margin-top:4px}.detail{display:grid;gap:2px;padding:9px 0;border-bottom:1px solid #eef0f2}.detail span{color:#667085;font-size:13px}.timeline{margin-top:22px}.timeline h3{font-size:16px;margin:0 0 8px}.event{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-top:1px solid #eef0f2;font-size:14px}.event time{color:#667085;white-space:nowrap}.message{padding-top:42px}@media(max-width:520px){.event{display:block}.event time{display:block;margin-top:4px}.card{padding:18px}}
  </style></head><body>${content}</body></html>`;
}

function formatDate(value: Date | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit", month: "2-digit", year: "numeric",
    timeZone: "Europe/Warsaw",
  }).format(value);
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: "Europe/Warsaw",
  }).format(value);
}

function customerValue(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : null;
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
