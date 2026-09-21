import { PORTAL_STYLES } from "./portal-styles.js";
import type {
  HospitalPortalViewModel,
  PortalCaseListItem,
  PortalDevice,
} from "./view-model.js";

export function featureActionBehavior(input: {
  url?: string | null;
  hasHandler?: boolean;
}): "NAVIGATE" | "EXECUTE" | "UPGRADE_MODAL" {
  if (input.url?.trim()) return "NAVIGATE";
  if (input.hasHandler) return "EXECUTE";
  return "UPGRADE_MODAL";
}

export function renderHospitalPortal(
  view: HospitalPortalViewModel,
  scriptNonce: string,
  now = new Date(),
  dataBasePath = "/p/token",
): string {
  const modelJson = safeJson(view);
  const todayWarsaw = dateKey(now);
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Emma — portal szpitala</title>
<style>${PORTAL_STYLES}</style>
</head>
<body>
<header class="mobile-header">
  <div><strong>Emma</strong><span>${escapeHtml(view.hospital.shortName || view.hospital.name)}</span></div>
  <small>Serwis: ${escapeHtml(view.serviceProviderName)}</small>
</header>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-title">Emma</div>
      <div class="brand-sub">${escapeHtml(view.hospital.shortName)}</div>
      <div class="service-source"><span>Serwis</span><strong>${escapeHtml(view.serviceProviderName)}</strong></div>
    </div>
    <nav class="nav" aria-label="Główna nawigacja">
      ${navButton("summary", "Podsumowanie", summaryIcon(), true)}
      ${navButton("devices", "Urządzenia", deviceIcon())}
      ${navButton("repairs", "Naprawy", repairIcon())}
      ${navButton("inspections", "Przeglądy", inspectionIcon())}
      ${navButton("documents", "Dokumenty", documentIcon())}
    </nav>
    <div class="sidebar-footer">Dostęp przez bezpieczny link.<br>Dane dotyczą wyłącznie spraw dostępnych w tym widoku.</div>
  </aside>
  <main class="content"><div class="workspace">
    <div class="portal-refresh-bar" aria-live="polite">
      <button class="portal-refresh-button" id="portalRefreshButton" type="button">Aktualizuj dane</button>
      <span class="portal-refresh-message" id="portalRefreshMessage"></span>
    </div>
    ${summaryScreen(view)}
    ${devicesScreen(view)}
    ${repairsScreen(view)}
    ${inspectionsScreen(view)}
    ${documentsScreen(view)}
    ${deviceCardScreen()}
    ${caseCardScreen()}
  </div></main>
</div>
<nav class="mobile-nav" aria-label="Główna nawigacja mobilna">
  ${navButton("summary", "Podsumowanie", summaryIcon(), true)}
  ${navButton("devices", "Urządzenia", deviceIcon())}
  ${navButton("repairs", "Naprawy", repairIcon())}
  ${navButton("inspections", "Przeglądy", inspectionIcon())}
  ${navButton("documents", "Dokumenty", documentIcon())}
</nav>
<div class="modal photo-lightbox" id="photoLightbox" role="dialog" aria-modal="true" aria-label="Podgląd zdjęcia" hidden>
  <div class="photo-lightbox-content">
    <button class="photo-lightbox-close" id="photoLightboxClose" type="button" aria-label="Zamknij podgląd">×</button>
    <img id="photoLightboxImage" alt="">
    <div class="photo-lightbox-caption" id="photoLightboxCaption"></div>
  </div>
</div>
<div class="modal feature-modal" id="featureModal" role="dialog" aria-modal="true" aria-labelledby="featureModalTitle" aria-describedby="featureModalDescription" hidden>
  <div class="feature-modal-content" role="document">
    <button class="feature-modal-x" id="featureModalX" type="button" aria-label="Zamknij">×</button>
    <h2 id="featureModalTitle">Ta funkcja nie jest dostępna w Twoim pakiecie</h2>
    <p id="featureModalDescription">W celu zwiększenia pakietu prosimy o kontakt: <a href="mailto:pawel@emmamed.com">pawel@emmamed.com</a></p>
    <button class="feature-modal-close" id="featureModalClose" type="button">Zamknij</button>
  </div>
</div>
<script nonce="${escapeHtml(scriptNonce)}">
const portalModel=${modelJson};
const todayWarsaw=${JSON.stringify(todayWarsaw)};
const dataBasePath=${safeJson(dataBasePath)};
${PORTAL_SCRIPT}
</script>
</body></html>`;
}

export function portalPageHeaders(scriptNonce: string) {
  return {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' https:; font-src 'none'`,
  } as const;
}

function summaryScreen(view: HospitalPortalViewModel): string {
  return `<section class="screen active" id="summary">
    <div class="page-head"><div class="kicker">Podsumowanie</div><h1>Naprawy i przeglądy</h1><p>Wszystkie sprawy dostępne dla szpitala — niezależnie od tego, czy są aktywne, wymagają reakcji czy zostały zakończone. Wybierz kafel, aby przefiltrować listę.</p></div>
    <div class="summary-grid">
      ${summaryCard("action", "Wymaga akcji", view.summary.requiresAction, "Naprawy i przeglądy, w których potrzebna jest reakcja po stronie szpitala.")}
      ${summaryCard("repair", "Naprawy", view.summary.repairs, "Wszystkie sprawy naprawcze, w tym wymagające akcji i zakończone.")}
      ${summaryCard("inspection", "Przeglądy", view.summary.inspections, "Wszystkie przeglądy: planowane, wykonane, aktualne i po terminie.")}
    </div>
    ${isEmptyCommunication(view) ? "" : upgradeTeaser(view, "summary")}
    <section class="panel"><div class="filter-state"><div><h2>Lista zadań</h2><p id="filterLabel">Wszystkie sprawy — najświeższa zmiana na górze.</p></div><button class="clear-filter" id="clearFilter">Pokaż wszystkie</button></div>
      ${searchBar("summarySearch", "Szukaj po urządzeniu, Numerze Sprawy, numerze klienta, numerze seryjnym, inwentarzowym lub statusie…")}
      <div class="task-list" id="taskList">${view.initialCases.items.map(summaryRow).join("")}</div>
      ${isEmptyCommunication(view)
        ? communicationEmptyState(view)
        : emptyState("summaryEmpty", "Brak spraw dostępnych w tym widoku.", view.initialCases.items.length === 0)}
      ${pagingControls("summary", view.initialCases.nextCursor !== null)}
    </section>
  </section>`;
}

function devicesScreen(view: HospitalPortalViewModel): string {
  return `<section class="screen" id="devices"><div class="page-head"><div class="kicker">Urządzenia</div><h1>Urządzenia</h1><p>Lista urządzeń powiązanych ze sprawami dostępnymi w tym widoku. Kliknięcie otwiera kartę urządzenia.</p></div>
    <div class="panel">${searchBar("deviceSearch", "Szukaj po nazwie urządzenia, producencie, modelu, numerze seryjnym lub inwentarzowym…")}
      <div class="task-list" id="deviceRows"></div>
      ${emptyState("deviceNoResults", "Brak urządzeń pasujących do wyszukiwania.", false)}${pagingControls("devices", false)}
    </div>${upgradeTeaser(view, "devices")}</section>`;
}

function repairsScreen(view: HospitalPortalViewModel): string {
  return `<section class="screen" id="repairs"><div class="page-head"><div class="kicker">Naprawy</div><h1>Naprawy</h1><p>Lista napraw urządzeń powiązanych ze sprawami dostępnymi w tym widoku. Kliknięcie otwiera kartę sprawy.</p></div>
    <div class="panel">${searchBar("repairSearch", "Szukaj po urządzeniu, Numerze Sprawy, numerze klienta, SN, numerze inwentarzowym lub statusie…")}
      <div class="task-list repair-list" id="repairRows"></div>
      ${emptyState("repairNoResults", "Brak napraw pasujących do wyszukiwania.", false)}${pagingControls("repairs", false)}
    </div>${upgradeTeaser(view, "repairs")}</section>`;
}

function inspectionsScreen(view: HospitalPortalViewModel): string {
  return `<section class="screen" id="inspections"><div class="page-head"><div class="kicker">Przeglądy</div><h1>Przeglądy</h1><p>Przeglądy urządzeń powiązanych z dostępnymi sprawami. Kliknięcie otwiera kartę sprawy.</p></div>
    <div class="panel">${searchBar("inspectionSearch", "Szukaj po urządzeniu, Numerze Sprawy, numerze klienta, SN, dacie przeglądu lub statusie…")}
      <div class="task-list" id="inspectionRows"></div>
      ${emptyState("inspectionNoResults", "Brak przeglądów pasujących do wyszukiwania.", false)}${pagingControls("inspections", false)}
    </div>${upgradeTeaser(view, "inspections")}</section>`;
}

function documentsScreen(view: HospitalPortalViewModel): string {
  return `<section class="screen" id="documents"><div class="page-head"><div class="kicker">Dokumenty</div><h1>Dokumenty</h1><p>Dokumenty faktycznie udostępnione w tym widoku portalu.</p></div>
    <div class="panel" style="padding:15px"><div class="document-tools"><input id="documentSearch" type="search" placeholder="Szukaj po nazwie dokumentu, sprawie, urządzeniu lub numerze seryjnym…" aria-label="Szukaj dokumentów"></div>
      <div class="documents-groups" id="documentsBody"></div>
      <div class="portal-loading" id="documentsLoading" hidden>Ładowanie…</div>
      <div class="portal-error" id="documentsError" hidden>Nie udało się pobrać danych. Spróbuj ponownie.</div>
      ${emptyState("documentNoResults", "Nie masz obecnie udostępnionych dokumentów.", false)}
    </div>${upgradeTeaser(view, "documents")}</section>`;
}

function deviceCardScreen(): string {
  return `<section class="screen device-card-screen" id="deviceCard"><div class="page-head"><h1>Karta urządzenia</h1><p>Informacje oraz historia spraw wybranego urządzenia.</p></div><div class="panel detail"><button class="back" id="deviceBack">← Wróć</button><div id="deviceDetail"></div></div></section>`;
}

function caseCardScreen(): string {
  return `<section class="screen" id="caseCard"><div class="page-head"><div class="kicker">Karta sprawy</div><h1 id="casePageTitle">Numer Sprawy</h1><p>Pełny przebieg wybranej naprawy lub przeglądu dla konkretnego urządzenia.</p><div class="case-screen-link"><button id="caseScreenDeviceLink" type="button">Przejdź do karty urządzenia</button></div></div><div class="panel detail"><button class="back" id="caseBack">← Wróć do listy</button><div id="caseDetail"></div></div></section>`;
}

function summaryRow(item: PortalCaseListItem): string {
  return `<article class="task case-open" role="button" tabindex="0" data-category="${item.type === "REPAIR" ? "repair" : "inspection"}" data-requires-action="${item.requiresAction}" data-case-id="${escapeAttr(item.sourceRecordId)}"><div><span class="case-type-badge">${item.type === "REPAIR" ? "Naprawa" : "Przegląd"}</span><div class="task-device">${escapeHtml(item.deviceName)}</div><div class="task-meta">${deviceMeta(item)}</div><div class="task-case-meta"><span>Numer Sprawy: ${display(item.caseNumber)}</span><span>Nr zlecenia klienta: ${display(item.clientOrderNumber, "brak numeru")}</span></div></div><div><div class="task-current-label">Aktualny status</div><div class="task-current status-tag ${statusClass(item.currentStatus)}">${escapeHtml(item.currentStatus)}</div></div><div class="task-side"><div class="task-date-label">Ostatnia zmiana</div><div class="task-date">${formatDateTime(item.lastChangedAt)}</div>${item.type === "INSPECTION" ? `<div class="task-valid-until"><span>Przegląd ważny do</span><strong>${formatDate(item.validUntil)}</strong></div>` : ""}</div></article>`;
}

function deviceRow(item: PortalDevice): string {
  return `<article class="list-row device-row-search device-open" role="button" tabindex="0" data-device-id="${escapeAttr(item.sourceRecordId)}"><div class="list-row-main"><b>${escapeHtml(item.deviceName)}</b><span>${deviceMeta(item)}</span><span>Oddział: ${display(item.department)}</span></div><div class="device-list-status">${inspectionBadge(item.validUntil)}</div></article>`;
}

function repairRow(item: PortalCaseListItem): string {
  return `<article class="repair-row repair-row-search case-open" role="button" tabindex="0" data-case-id="${escapeAttr(item.sourceRecordId)}"><div><b>${escapeHtml(item.deviceName)}</b><span class="sub">${deviceMeta(item)}</span><span class="sub">Oddział: ${display(item.department ?? null)}</span><span class="sub">Numer Sprawy: ${display(item.caseNumber)} · Nr zlecenia klienta: ${display(item.clientOrderNumber, "brak numeru")}</span></div><div><span class="status-tag ${statusClass(item.currentStatus)}">${escapeHtml(item.currentStatus)}</span></div><div class="date-block"><span>Data zgłoszenia</span><strong>${item.reportedAtDateOnly ? formatDate(item.reportedAt) : formatDateTime(item.reportedAt)}</strong></div></article>`;
}

function inspectionRow(item: PortalCaseListItem): string {
  return `<article class="list-row inspection-row-search case-open" role="button" tabindex="0" data-case-id="${escapeAttr(item.sourceRecordId)}"><div class="list-row-main"><b>${escapeHtml(item.deviceName)}</b><span>${deviceMeta(item)}</span><span>Oddział: ${display(item.department ?? null)}</span><span>Numer Sprawy: ${display(item.caseNumber)} · Nr zlecenia klienta: ${display(item.clientOrderNumber, "brak numeru")}</span></div><div class="list-row-mid"><b>Aktualny status</b><span class="status-tag ${statusClass(item.currentStatus)}">${escapeHtml(item.currentStatus)}</span></div><div class="inspection-dates"><span><b>Data wykonania</b>${formatDate(item.inspectionPerformedAt)}</span><span><b>Ważny do</b>${formatDate(item.validUntil)}</span></div></article>`;
}

function inspectionBadge(validUntil: Date | null): string {
  if (!validUntil) return `<span class="inspection-state">Brak terminu</span><span class="inspection-date">brak danych</span>`;
  const due = dateKey(validUntil);
  return `<span class="inspection-state" data-inspection-due="${escapeAttr(due)}">Przegląd</span><span class="inspection-date">Termin: ${formatDate(validUntil)}</span>`;
}

function summaryCard(filter: string, label: string, number: number, note: string): string {
  return `<button class="summary-card" data-filter="${filter}"><div class="summary-label">${label}</div><div class="summary-number">${number}</div><div class="summary-note">${note}</div></button>`;
}

function navButton(id: string, label: string, icon: string, active = false): string {
  return `<button${active ? " class=\"active\"" : ""} data-screen="${id}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`;
}

function searchBar(id: string, placeholder: string): string {
  return `<div class="search-bar"><input id="${id}" type="search" placeholder="${placeholder}" aria-label="${placeholder}"></div>`;
}

function upgradeTeaser(view: HospitalPortalViewModel, context: "summary" | "devices" | "repairs" | "inspections" | "documents"): string {
  if (view.accessLevel !== "COMMUNICATION") return "";
  const locked = context === "devices" ? view.teaser.lockedDevices
    : context === "repairs" ? view.teaser.lockedRepairs
    : context === "inspections" ? view.teaser.lockedInspections : null;
  const message = locked === null
    ? `Pełna Emma obejmuje kartotekę ${view.teaser.totalDevices} urządzeń, ${view.teaser.totalRepairs} napraw i ${view.teaser.totalInspections} przeglądów w Twoim szpitalu.`
    : locked > 0
      ? `Emma ma informacje o jeszcze ${locked} ${context === "devices" ? "urządzeniach" : context === "repairs" ? "naprawach" : "przeglądach"}.`
      : "W tym widoku widzisz wszystkie dostępne obecnie dane.";
  const title = context === "documents" ? "Pełna dokumentacja" : "Pełna Emma";
  return `<aside class="upgrade-teaser"><div><strong>${title}</strong><p>${escapeHtml(message)}</p></div><a href="${escapeAttr(view.upgradeUrl)}" rel="nofollow">Odblokuj pełną Emmę</a></aside>`;
}

function isEmptyCommunication(view: HospitalPortalViewModel): boolean {
  return view.accessLevel === "COMMUNICATION"
    && view.summary.repairs === 0
    && view.summary.inspections === 0
    && view.summary.devices === 0
    && view.teaser.lockedRepairs + view.teaser.lockedInspections + view.teaser.lockedDevices > 0;
}

function communicationEmptyState(view: HospitalPortalViewModel): string {
  return `<aside class="communication-empty" id="summaryEmpty">
    <div class="communication-empty-icon" aria-hidden="true">${summaryIcon()}</div>
    <div><h2>Nie masz obecnie udostępnionych spraw.</h2>
      <p>Emma posiada pełną historię aparatury i serwisu Twojego szpitala.</p>
      <ul aria-label="Dane dostępne w pełnej Emma">
        <li><strong>${view.teaser.lockedDevices}</strong><span>urządzeń</span></li>
        <li><strong>${view.teaser.lockedRepairs}</strong><span>napraw</span></li>
        <li><strong>${view.teaser.lockedInspections}</strong><span>przeglądów</span></li>
      </ul>
      <a class="upgrade-cta" href="${escapeAttr(view.upgradeUrl)}" rel="nofollow">Odblokuj pełną Emmę</a>
    </div>
  </aside>`;
}

function pagingControls(name: string, visible: boolean): string {
  return `<div class="portal-pagination" id="${name}Pagination"><button class="history-btn" id="${name}More"${visible ? "" : " hidden"}>Pokaż więcej</button><span class="portal-loading" id="${name}Loading" hidden>Ładowanie…</span><span class="portal-error" id="${name}Error" hidden>Nie udało się pobrać danych. Spróbuj ponownie.</span></div>`;
}

function emptyState(id: string, message: string, visible: boolean): string {
  return `<div class="no-results" id="${id}"${visible ? " style=\"display:block\"" : ""}>${message}</div>`;
}

function deviceMeta(item: Pick<PortalCaseListItem, "manufacturer" | "model" | "serialNumber" | "inventoryNumber"> | PortalDevice): string {
  return `${display(item.manufacturer)} · ${display(item.model)} · SN: ${display(item.serialNumber)} · Nr inw.: ${display(item.inventoryNumber)}`;
}

function display(value: string | null, fallback = "—"): string {
  return escapeHtml(value?.trim() || fallback);
}

function formatDate(value: Date | null): string {
  return value ? new Intl.DateTimeFormat("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Warsaw" }).format(value) : "—";
}

function formatDateTime(value: Date | null): string {
  return value ? new Intl.DateTimeFormat("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Warsaw" }).format(value) : "—";
}

function dateKey(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Warsaw" }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function statusClass(status: string): string {
  const value = status.toLocaleLowerCase("pl-PL");
  if (value.includes("oczekujemy na decyzję") || value.includes("niesprawny") || value.includes("problem")) return "red";
  if (value.includes("naprawa") || value.includes("diagnostyka") || value.includes("części")) return "amber";
  if (value.includes("sprawny") || value.includes("zakończ")) return "green";
  if (value.includes("do realizacji") || value.includes("umów")) return "blue";
  return "neutral";
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function escapeAttr(value: string): string { return escapeHtml(value); }
function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function summaryIcon() { return `<svg viewBox="0 0 24 24"><path d="M4 13h6V5H4z"/><path d="M14 19h6v-8h-6z"/><path d="M14 5h6v4h-6z"/><path d="M4 19h6v-2H4z"/></svg>`; }
function deviceIcon() { return `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="11" rx="2"/><path d="M8 19h8"/><path d="M12 16v3"/></svg>`; }
function repairIcon() { return `<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5-5l2.1 2.1-2.8 2.8L6.9 4.1a4 4 0 0 0 5 5l6.7 6.7a2 2 0 1 1-2.8 2.8L9.1 11.9"/><path d="m5 19 4-4"/></svg>`; }
function inspectionIcon() { return `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v3l2 2"/></svg>`; }
function documentIcon() { return `<svg viewBox="0 0 24 24"><path d="M8 3h7l5 5v13H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M15 3v6h6"/><path d="M10 14h7"/><path d="M10 18h5"/></svg>`; }

const PORTAL_SCRIPT = String.raw`
const screens=[...document.querySelectorAll('.screen')];
const navButtons=[...document.querySelectorAll('.nav button,.mobile-nav button')];
const analyticsPath=dataBasePath.replace(/^\/p\//,'/api/portal/')+'/analytics';
let analyticsSessionId='';try{analyticsSessionId=sessionStorage.getItem('emmaAnalyticsSessionId')||'';if(!/^[0-9a-f-]{36}$/i.test(analyticsSessionId)){analyticsSessionId=crypto.randomUUID();sessionStorage.setItem('emmaAnalyticsSessionId',analyticsSessionId)}}catch{analyticsSessionId=crypto.randomUUID()}
function sendAnalytics(eventType,details={}){const payload=JSON.stringify({eventType,sessionId:analyticsSessionId,...details});try{if(navigator.sendBeacon&&navigator.sendBeacon(analyticsPath,new Blob([payload],{type:'application/json'})))return Promise.resolve();return fetch(analyticsPath,{method:'POST',headers:{'Content-Type':'application/json'},body:payload,keepalive:true}).then(()=>undefined).catch(()=>undefined)}catch{return Promise.resolve()}}
sendAnalytics('PORTAL_VIEW_CONFIRMED');
const caseCache=new Map();
if(portalModel.focusedCase)caseCache.set(portalModel.focusedCase.sourceRecordId,portalModel.focusedCase);
for(const item of portalModel.initialCases.items)caseCache.set(item.sourceRecordId,item);
let currentCase=null;let activeSummaryFilter='ALL';
const text=(value,fallback='—')=>typeof value==='string'&&value.trim()?value:fallback;
const node=(tag,className,content)=>{const result=document.createElement(tag);if(className)result.className=className;if(content!==undefined)result.textContent=content;return result};
const append=(parent,...children)=>{for(const child of children)if(child)parent.append(child);return parent};
const fileUrl=(assetId,variant)=>dataBasePath+'/files/'+encodeURIComponent(assetId)+'?variant='+variant;
const formatDate=value=>value?new Intl.DateTimeFormat('pl-PL',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'Europe/Warsaw'}).format(new Date(value)):'—';
const formatDateTime=value=>value?new Intl.DateTimeFormat('pl-PL',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Europe/Warsaw'}).format(new Date(value)):'—';
const statusClass=status=>{const value=(status||'').toLocaleLowerCase('pl-PL');if(value.includes('oczekujemy na decyzję')||value.includes('niesprawny')||value.includes('problem'))return'red';if(value.includes('naprawa')||value.includes('diagnostyka')||value.includes('części'))return'amber';if(value.includes('sprawny')||value.includes('zakończ'))return'green';if(value.includes('do realizacji')||value.includes('umów'))return'blue';return'neutral'};
const status=value=>node('span','status-tag '+statusClass(value),text(value,'Brak informacji'));
const deviceMeta=item=>[text(item.manufacturer),text(item.model),'SN: '+text(item.serialNumber),'Nr inw.: '+text(item.inventoryNumber)].join(' · ');
function activate(element,callback){element.tabIndex=0;element.setAttribute('role','button');element.addEventListener('click',callback);element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();callback()}})}
function showScreen(id,entityType,entityRecordId){screens.forEach(screen=>screen.classList.toggle('active',screen.id===id));navButtons.forEach(button=>button.classList.toggle('active',button.dataset.screen===id));if(id!=='caseCard')setInspectionShell(false);const screen={caseCard:'case_detail',deviceCard:'device_detail'}[id]||id;sendAnalytics('SCREEN_VIEW',{screen,...(entityType?{entityType,entityRecordId}:{})});}
async function api(path,params={}){const url=new URL(dataBasePath+'/data/'+path,location.origin);for(const [key,value]of Object.entries(params))if(value)url.searchParams.set(key,String(value));const response=await fetch(url,{headers:{Accept:'application/json'},cache:'no-store'});if(!response.ok)throw new Error('PORTAL_DATA_UNAVAILABLE');return response.json()}
async function refreshApi(path,method='GET'){const response=await fetch(dataBasePath+'/data/refresh'+path,{method,headers:{Accept:'application/json'},cache:'no-store'});if(!response.ok)throw new Error('PORTAL_REFRESH_UNAVAILABLE');return response.json()}
const refreshButton=document.getElementById('portalRefreshButton');
const refreshMessage=document.getElementById('portalRefreshMessage');
let refreshInProgress=false;
function showRefreshSuccess(){let updatedAt='';try{updatedAt=sessionStorage.getItem('emmaPortalRefreshCompletedAt')||'';sessionStorage.removeItem('emmaPortalRefreshCompletedAt')}catch{}if(updatedAt){refreshMessage.classList.remove('error');refreshMessage.textContent='Dane zaktualizowane · Ostatnia aktualizacja: '+new Intl.DateTimeFormat('pl-PL',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Europe/Warsaw'}).format(new Date(updatedAt))}}
showRefreshSuccess();
async function requestPortalRefresh(){if(refreshInProgress)return;refreshInProgress=true;refreshButton.disabled=true;refreshButton.textContent='Aktualizuję dane…';refreshMessage.classList.remove('error');refreshMessage.textContent='';try{const request=await refreshApi('','POST');const deadline=Date.now()+120000;while(Date.now()<deadline){const state=await refreshApi('/'+encodeURIComponent(request.requestId));if(state.status==='SUCCEEDED'){const completedAt=state.completedAt||new Date().toISOString();try{sessionStorage.setItem('emmaPortalRefreshCompletedAt',completedAt)}catch{}location.reload();return}if(state.status==='FAILED')throw new Error('PORTAL_REFRESH_FAILED');await new Promise(resolve=>setTimeout(resolve,1000))}throw new Error('PORTAL_REFRESH_TIMEOUT')}catch{refreshMessage.classList.add('error');refreshMessage.textContent='Nie udało się zaktualizować danych. Spróbuj ponownie.'}finally{refreshInProgress=false;refreshButton.disabled=false;refreshButton.textContent='Aktualizuj dane'}}
refreshButton.addEventListener('click',requestPortalRefresh);
function meta(label,value){const wrap=node('div','meta');append(wrap,node('label','',label),node('strong','',text(value)));return wrap}
function makeSummaryRow(item){const row=node('article','task case-open');row.dataset.category=item.type==='REPAIR'?'repair':'inspection';row.dataset.requiresAction=String(item.requiresAction);const main=node('div');append(main,node('span','case-type-badge',item.type==='REPAIR'?'Naprawa':'Przegląd'),node('div','task-device',item.deviceName),node('div','task-meta',deviceMeta(item)));const caseMeta=node('div','task-case-meta');append(caseMeta,node('span','','Numer Sprawy: '+text(item.caseNumber)),node('span','','Nr zlecenia klienta: '+text(item.clientOrderNumber,'brak numeru')));main.append(caseMeta);const current=node('div');append(current,node('div','task-current-label','Aktualny status'),status(item.currentStatus));const side=node('div','task-side');append(side,node('div','task-date-label','Ostatnia zmiana'),node('div','task-date',formatDateTime(item.lastChangedAt)));if(item.type==='INSPECTION'){const valid=node('div','task-valid-until');append(valid,node('span','','Przegląd ważny do'),node('strong','',formatDate(item.validUntil)));side.append(valid)}append(row,main,current,side);activate(row,()=>openCase(item.sourceRecordId));return row}
function makeRepairRow(item){const row=node('article','repair-row repair-row-search');const main=node('div');append(main,node('b','',item.deviceName),node('span','sub',deviceMeta(item)),node('span','sub','Oddział: '+text(item.department)),node('span','sub','Numer Sprawy: '+text(item.caseNumber)+' · Nr zlecenia klienta: '+text(item.clientOrderNumber,'brak numeru')));const state=node('div');state.append(status(item.currentStatus));const date=node('div','date-block');append(date,node('span','','Data zgłoszenia'),node('strong','',item.reportedAtDateOnly?formatDate(item.reportedAt):formatDateTime(item.reportedAt)));append(row,main,state,date);activate(row,()=>openCase(item.sourceRecordId));return row}
function makeInspectionRow(item){const row=node('article','list-row inspection-row-search');const main=node('div','list-row-main');append(main,node('b','',item.deviceName),node('span','',deviceMeta(item)),node('span','','Oddział: '+text(item.department)),node('span','','Numer Sprawy: '+text(item.caseNumber)+' · Nr zlecenia klienta: '+text(item.clientOrderNumber,'brak numeru')));const middle=node('div','list-row-mid');append(middle,node('b','','Aktualny status'),status(item.currentStatus));const dates=node('div','inspection-dates');const performed=node('span');append(performed,node('b','','Data wykonania'),document.createTextNode(formatDate(item.inspectionPerformedAt)));const due=node('span');append(due,node('b','','Ważny do'),document.createTextNode(formatDate(item.validUntil)));append(dates,performed,due);append(row,main,middle,dates);activate(row,()=>openCase(item.sourceRecordId));return row}
function inspectionHealth(value){if(!value)return{state:'',label:'Brak terminu',detail:'brak danych'};const due=value.slice(0,10);const days=Math.round((Date.parse(due+'T00:00:00Z')-Date.parse(todayWarsaw+'T00:00:00Z'))/86400000);return days<0?{state:'overdue',label:'Przegląd nieaktualny',detail:'po terminie '+Math.abs(days)+' dni'}:{state:days<=30?'soon':'ok',label:'Przegląd aktualny',detail:'kończy się za '+days+' dni'}}
function makeDeviceRow(item){const row=node('article','list-row device-row-search');const main=node('div','list-row-main');append(main,node('b','',item.deviceName),node('span','',deviceMeta(item)),node('span','','Oddział: '+text(item.department)));const health=inspectionHealth(item.validUntil);const inspection=node('div','device-list-status');append(inspection,node('span','inspection-state '+health.state,health.label),node('span','inspection-date',health.detail));append(row,main,inspection);activate(row,()=>openDevice(item.sourceRecordId));return row}
const lists={
 summary:{container:document.getElementById('taskList'),empty:document.getElementById('summaryEmpty'),more:document.getElementById('summaryMore'),loading:document.getElementById('summaryLoading'),error:document.getElementById('summaryError'),filter:'ALL',query:null,cursor:portalModel.initialCases.nextCursor,initialized:true,render:makeSummaryRow},
 repairs:{container:document.getElementById('repairRows'),empty:document.getElementById('repairNoResults'),more:document.getElementById('repairsMore'),loading:document.getElementById('repairsLoading'),error:document.getElementById('repairsError'),filter:'REPAIR',query:null,cursor:null,initialized:false,render:makeRepairRow},
 inspections:{container:document.getElementById('inspectionRows'),empty:document.getElementById('inspectionNoResults'),more:document.getElementById('inspectionsMore'),loading:document.getElementById('inspectionsLoading'),error:document.getElementById('inspectionsError'),filter:'INSPECTION',query:null,cursor:null,initialized:false,render:makeInspectionRow}
};
async function loadCases(name,reset=false){const state=lists[name];if(state.loading.dataset.busy==='true')return;const cursor=reset?null:state.cursor;if(!reset&&!cursor)return;if(reset){state.cursor=null;state.container.replaceChildren()}state.loading.dataset.busy='true';state.loading.hidden=false;state.error.hidden=true;state.more.disabled=true;try{const page=await api('cases',{filter:state.filter,q:state.query,cursor});for(const item of page.items){caseCache.set(item.sourceRecordId,item);state.container.append(state.render(item))}state.cursor=page.nextCursor;state.more.hidden=page.nextCursor===null;state.empty.style.display=state.container.children.length?'none':'block';state.initialized=true}catch{state.error.hidden=false}finally{state.loading.dataset.busy='false';state.loading.hidden=true;state.more.disabled=false}}
for(const [name,state]of Object.entries(lists))state.more.addEventListener('click',()=>loadCases(name,false));
let devicesState={container:document.getElementById('deviceRows'),empty:document.getElementById('deviceNoResults'),more:document.getElementById('devicesMore'),loading:document.getElementById('devicesLoading'),error:document.getElementById('devicesError'),query:null,cursor:null,initialized:false,busy:false};
async function loadDevices(reset=false){if(devicesState.busy)return;const cursor=reset?null:devicesState.cursor;if(!reset&&!cursor)return;if(reset){devicesState.cursor=null;devicesState.container.replaceChildren()}devicesState.busy=true;devicesState.loading.hidden=false;devicesState.error.hidden=true;devicesState.more.disabled=true;try{const page=await api('devices',{q:devicesState.query,cursor});for(const item of page.items)devicesState.container.append(makeDeviceRow(item));devicesState.cursor=page.nextCursor;devicesState.more.hidden=page.nextCursor===null;devicesState.empty.style.display=devicesState.container.children.length?'none':'block';devicesState.initialized=true}catch{devicesState.error.hidden=false}finally{devicesState.busy=false;devicesState.loading.hidden=true;devicesState.more.disabled=false}}
devicesState.more.addEventListener('click',()=>loadDevices(false));
const documentsState={container:document.getElementById('documentsBody'),empty:document.getElementById('documentNoResults'),loading:document.getElementById('documentsLoading'),error:document.getElementById('documentsError'),query:null,initialized:false,busy:false};
function documentLink(asset){const link=node('a','document-link');link.href=fileUrl(asset.id,'document');link.target='_blank';link.rel='noopener';const info=node('span','document-name');const copy=node('span');append(copy,node('b','',asset.title),node('span','',asset.fileName));append(info,node('span','doc-icon','PDF'),copy);append(link,info,node('span','document-open','Otwórz'));return link}
function documentCard(asset){const card=node('article','document-card');const context=node('div','document-context');append(context,node('b','',asset.deviceName||'Urządzenie medyczne'),node('span','','Numer Sprawy: '+text(asset.caseNumber)),node('span','','SN: '+text(asset.serialNumber)),node('span','',asset.caseDate?'Data: '+formatDate(asset.caseDate):''));append(card,documentLink(asset),context);return card}
function renderDocuments(items){documentsState.container.replaceChildren();const groups=[['REPAIR','Naprawy'],['INSPECTION','Przeglądy']];for(const [type,label]of groups){const matching=items.filter(item=>item.caseType===type);if(!matching.length)continue;const section=node('section','documents-group');append(section,node('h2','',label));const grid=node('div','documents-cards');for(const item of matching)grid.append(documentCard(item));section.append(grid);documentsState.container.append(section)}documentsState.empty.style.display=items.length?'none':'block'}
async function loadDocuments(){if(documentsState.busy)return;documentsState.busy=true;documentsState.loading.hidden=false;documentsState.error.hidden=true;try{const page=await api('documents',{q:documentsState.query});renderDocuments(page.items);documentsState.initialized=true}catch{documentsState.error.hidden=false}finally{documentsState.busy=false;documentsState.loading.hidden=true}}
function showListScreen(id,push=true){if(push)history.pushState({portalScreen:id},'');showScreen(id);if(id==='repairs'&&!lists.repairs.initialized)loadCases('repairs',true);if(id==='inspections'&&!lists.inspections.initialized)loadCases('inspections',true);if(id==='devices'&&!devicesState.initialized)loadDevices(true);if(id==='documents'&&!documentsState.initialized)loadDocuments()}
navButtons.forEach(button=>button.addEventListener('click',()=>showListScreen(button.dataset.screen)));
const labels={ACTION:'Naprawy i przeglądy, które wymagają reakcji po stronie szpitala.',REPAIR:'Wszystkie naprawy — aktywne, wymagające akcji i zakończone.',INSPECTION:'Wszystkie przeglądy — planowane, wykonane, aktualne i po terminie.'};
document.querySelectorAll('.summary-card').forEach(card=>card.addEventListener('click',()=>{const value=card.dataset.filter.toUpperCase();activeSummaryFilter=activeSummaryFilter===value?'ALL':value;lists.summary.filter=activeSummaryFilter;document.querySelectorAll('.summary-card').forEach(item=>item.classList.toggle('active',item.dataset.filter.toUpperCase()===activeSummaryFilter));document.getElementById('filterLabel').textContent=activeSummaryFilter==='ALL'?'Wszystkie sprawy — najświeższa zmiana na górze.':labels[activeSummaryFilter];loadCases('summary',true)}));
document.getElementById('clearFilter').addEventListener('click',()=>{activeSummaryFilter='ALL';lists.summary.filter='ALL';document.querySelectorAll('.summary-card').forEach(item=>item.classList.remove('active'));document.getElementById('filterLabel').textContent='Wszystkie sprawy — najświeższa zmiana na górze.';loadCases('summary',true)});
function debounceSearch(inputId,callback){let timer;document.getElementById(inputId).addEventListener('input',event=>{clearTimeout(timer);timer=setTimeout(()=>{const query=event.target.value.trim();if(query.length===1)return;callback(query.length>=2?query:null)},300)})}
debounceSearch('summarySearch',query=>{lists.summary.query=query;loadCases('summary',true)});debounceSearch('repairSearch',query=>{lists.repairs.query=query;loadCases('repairs',true)});debounceSearch('inspectionSearch',query=>{lists.inspections.query=query;loadCases('inspections',true)});debounceSearch('deviceSearch',query=>{devicesState.query=query;loadDevices(true)});
debounceSearch('documentSearch',query=>{documentsState.query=query;loadDocuments()});
async function openCase(id,push=true){if(push)history.pushState({portalScreen:'caseCard',caseId:id},'');const detail=document.getElementById('caseDetail');detail.replaceChildren(node('div','portal-loading','Ładowanie…'));showScreen('caseCard','CASE',id);try{const item=portalModel.focusedCase?.sourceRecordId===id?portalModel.focusedCase:await api('cases/'+encodeURIComponent(id));caseCache.set(id,item);currentCase=item;renderCase(item)}catch{detail.replaceChildren(node('div','portal-error','Nie udało się pobrać danych. Spróbuj ponownie.'))}}
function featureButton(label,action,className){const button=node('button',className,label);button.type='button';button.dataset.hasRealAction=String(Boolean(action));button.addEventListener('click',action||openFeatureModal);return button}
function renderCaseMedia(item,detail){const media=node('div','inspection-v5-media-grid');const documents=node('section','inspection-v5-section media-section');documents.append(node('h3','','Dokument przeglądu'));if(item.documents?.length){const list=node('div','document-list');for(const asset of item.documents)list.append(documentLink(asset));documents.append(list,node('p','inspection-v5-hint','Kliknij dokument, aby otworzyć'))}else append(documents,node('strong','empty-media-title','Brak dokumentu'),node('p','empty-media-note','Dokument będzie dostępny po wykonaniu przeglądu.'));const photos=node('section','inspection-v5-section media-section');photos.append(node('h3','',item.photoLabel||'Zdjęcia z przeglądu'));if(item.photos?.length){const gallery=node('div','photo-gallery');for(const asset of item.photos){const button=node('button','photo-thumb');button.type='button';button.setAttribute('aria-label','Otwórz '+asset.title);const image=node('img','photo-thumb-image');image.src=fileUrl(asset.id,'thumb');image.alt=asset.title;image.loading='lazy';append(button,image,node('span','photo-caption',asset.title));button.addEventListener('click',()=>openPhoto(asset));gallery.append(button)}photos.append(gallery,node('p','inspection-v5-hint','Zobacz wszystkie zdjęcia →'))}else append(photos,node('strong','empty-media-title','Brak zdjęć'),node('p','empty-media-note','Zdjęcia nie zostały dodane do tego przeglądu.'));append(media,documents,photos);detail.append(media)}
function renderHistory(item,detail){if(!item.history?.length)return;const section=node('div','section');append(section,node('h3','','Historia zmian'),node('p','history-order-note','Najstarsza zmiana jest na górze, najnowsza na dole.'));const timeline=node('div','case-history');for(const event of item.history){const row=node('div','case-history-item');const rail=node('div','case-history-rail');rail.append(node('div','case-history-dot'));const card=node('div','case-history-card');append(card,node('b','',event.title),node('p','',text(event.description,'')));append(row,node('div','case-history-date',formatDateTime(event.changedAt)),rail,card);timeline.append(row)}section.append(timeline);detail.append(section)}
async function openDevice(id,push=true){if(push)history.pushState({portalScreen:'deviceCard',deviceId:id},'');const detail=document.getElementById('deviceDetail');detail.replaceChildren(node('div','portal-loading','Ładowanie…'));showScreen('deviceCard','DEVICE',id);try{const item=await api('devices/'+encodeURIComponent(id));renderDevice(item)}catch{detail.replaceChildren(node('div','portal-error','Nie udało się pobrać danych. Spróbuj ponownie.'))}}
function renderDevice(item){const detail=document.getElementById('deviceDetail');detail.replaceChildren();const hero=node('div','device-hero');const titleLine=node('div','hero-title-line');append(titleLine,node('h2','',item.deviceName));const grid=node('div','meta-grid');append(grid,meta('Producent',item.manufacturer),meta('Model',item.model),meta('Oddział',item.department),meta('Ostatni przegląd',formatDate(item.inspectionPerformedAt)),meta('Nr seryjny',item.serialNumber),meta('Nr inwentarzowy',item.inventoryNumber),meta('Wynik przeglądu',item.inspectionResult));const health=inspectionHealth(item.validUntil);const inspection=node('div','device-card-inspection');const left=node('div');append(left,node('div','label','Ważność przeglądu'),node('strong','','Ważny do: '+formatDate(item.validUntil)));const right=node('div');append(right,node('span','inspection-state '+health.state,health.label),node('span','inspection-date',health.detail));append(inspection,left,right);append(hero,titleLine,grid,inspection);detail.append(hero);for(const type of ['REPAIR','INSPECTION']){const section=node('div','section');append(section,node('h3','',type==='REPAIR'?'Naprawy':'Przeglądy'));const list=node('div','case-list');const cases=item.cases.items.filter(value=>value.type===type);if(cases.length)for(const value of cases)list.append(caseLink(value));else list.append(emptyMini(type==='REPAIR'?'Brak napraw':'Brak przeglądów','Brak danych w tym widoku.'));section.append(list);detail.append(section)}if(item.lockedCaseCount>0){const teaser=node('aside','upgrade-teaser');const copy=node('div');append(copy,node('strong','','Pełna historia urządzenia'),node('p','','Emma posiada jeszcze '+item.lockedCaseCount+' wpisów historii tego urządzenia.'));const link=node('a','','Odblokuj pełną Emmę');link.href=portalModel.upgradeUrl;link.rel='nofollow';append(teaser,copy,link);detail.append(teaser)}}
function caseLink(item){caseCache.set(item.sourceRecordId,item);const button=node('button','case-link');button.type='button';const info=node('span');append(info,node('b','','Numer Sprawy: '+text(item.caseNumber)),node('span','',item.currentStatus));append(button,info,node('span','arrow','›'));button.addEventListener('click',()=>openCase(item.sourceRecordId));return button}
const V5_VARIANTS={
PASSED:{tone:'success',icon:'check'},CONDITIONAL:{tone:'warning',icon:'alert'},FAILED:{tone:'danger',icon:'alert'},
SCHEDULED:{tone:'info',icon:'calendar'},DUE:{tone:'neutral',icon:'clock'},PROBLEM:{tone:'danger',icon:'alert'},
VERIFY:{tone:'neutral',icon:'info'}
};
const V5_ICON_PATHS={
check:['M20 6 9 17l-5-5'],alert:['M12 8v5','M12 17h.01','M10.3 2.9 1.8 17.1A2 2 0 0 0 3.5 20h17a2 2 0 0 0 1.7-2.9L13.7 2.9a2 2 0 0 0-3.4 0Z'],
info:['M12 16v-4','M12 8h.01','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'],calendar:['M6 2v4','M18 2v4','M3 9h18','M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z'],
clock:['M12 6v6l4 2','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'],shield:['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z','m9 12 2 2 4-4'],
device:['M4 5h16v11H4z','M8 20h8','M12 16v4'],location:['M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z','M12 10h.01'],
document:['M6 2h9l3 3v17H6z','M14 2v5h5','M9 13h6','M9 17h6'],camera:['M4 7h3l2-3h6l2 3h3v13H4z','M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'],
link:['M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1','M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1'],
wrench:['M14.7 6.3a4 4 0 0 0-5-5L12 3.6 8.6 7 6.3 4.7a4 4 0 0 0 5 5L4 17l3 3 7.3-7.3a4 4 0 0 0 .4-6.4Z']
};
function v5Icon(name,className=''){const wrap=node('span','inspection-v5-icon '+className);const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');for(const d of V5_ICON_PATHS[name]||V5_ICON_PATHS.info){const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);svg.append(path)}wrap.append(svg);return wrap}
function v5Variant(d){return V5_VARIANTS[d.variant]||V5_VARIANTS.VERIFY}
function setInspectionShell(active){document.querySelector('.workspace')?.classList.toggle('inspection-detail-active',active);document.getElementById('caseCard')?.classList.toggle('inspection-detail-screen',active);document.getElementById('caseBack').hidden=active;document.getElementById('caseScreenDeviceLink').hidden=active}
function v5StatusPill(label,d,className=''){const config=v5Variant(d);const pill=node('span','inspection-v5-status-pill is-'+config.tone+' '+className);append(pill,v5Icon(config.icon),node('span','',text(label)));return pill}
function v5SectionHeader(title,iconName,action=null){const header=node('div','inspection-v5-section-head');const titleWrap=node('div','inspection-v5-section-title');append(titleWrap,v5Icon(iconName),node('h3','',title));header.append(titleWrap);if(action)header.append(action);return header}
function v5SummaryTile(label,value,iconName,help=''){const tile=node('div','inspection-v5-summary');append(tile,v5Icon(iconName));const copy=node('div','inspection-v5-summary-copy');append(copy,node('span','',label),node('strong','',text(value)));if(help)copy.append(node('small','',help));tile.append(copy);return tile}
function v5DeviceTile(label,value,content=null){const tile=node('div','inspection-v5-pair');tile.append(node('span','',label));if(content)tile.append(content);else tile.append(node('strong','',text(value)));return tile}
function v5RelatedCard(label,iconName,action){const button=featureButton('',action,'inspection-v5-link');append(button,v5Icon(iconName),node('span','',label),node('span','inspection-v5-link-arrow','→'));return button}
function v5PanelCopy(value){const copy=node('p','inspection-v5-panel-description',text(value,''));return copy}
function v5PanelSide(d){if(d.relatedRepairNumber){const card=node('div','inspection-v5-panel-side inspection-v5-repair-card');append(card,v5Icon('wrench'),node('strong','','Powiązana naprawa'),featureButton('Naprawa #'+d.relatedRepairNumber+' →',null,'inspection-v5-related-action'));return card}if(d.variant==='SCHEDULED'){const card=node('div','inspection-v5-panel-side');append(card,v5Icon('calendar'),node('span','','Planowany termin przeglądu'),node('strong','',formatDate(d.scheduledAt)));return card}if(d.variant==='DUE'){const card=node('div','inspection-v5-panel-side');append(card,v5Icon('calendar'),node('span','','Zaplanowanie przeglądu'),featureButton('Umów termin',null,'inspection-v5-panel-action'));return card}if(d.variant==='PROBLEM'&&d.requiredAction){const card=node('div','inspection-v5-panel-side');append(card,v5Icon('info'),node('strong','','Wymagane działanie'),v5PanelCopy(d.requiredAction));return card}return null}
function v5StatusPanel(d){const config=v5Variant(d);const titles={PASSED:'Przegląd aktualny',CONDITIONAL:'Uwagi z przeglądu',FAILED:'Urządzenie niesprawne',SCHEDULED:'Przegląd umówiony',DUE:'Przegląd do realizacji',PROBLEM:'Przegląd nie został wykonany',VERIFY:'Dane wymagają weryfikacji'};const descriptions={PASSED:d.heroDescription,CONDITIONAL:d.notes||d.faults||d.heroDescription,FAILED:d.faults||d.heroDescription,SCHEDULED:d.heroDescription,DUE:d.heroDescription,PROBLEM:d.failureReason||d.heroDescription,VERIFY:'Szczegóły przeglądu są chwilowo niedostępne.'};const panel=node('div','inspection-v5-status-panel is-'+config.tone);const main=node('div','inspection-v5-panel-main');main.append(v5Icon(config.icon,'inspection-v5-panel-icon'));const copy=node('div');append(copy,node('strong','inspection-v5-panel-title',titles[d.variant]||titles.VERIFY),v5PanelCopy(descriptions[d.variant]||''));if(d.variant==='CONDITIONAL'&&d.faults&&d.faults!==descriptions.CONDITIONAL)copy.append(v5PanelCopy(d.faults));append(main,copy);panel.append(main);const side=v5PanelSide(d);if(side)panel.append(side);return panel}
function v5ResultTarget(d){const section=node('section','inspection-v5-section inspection-v5-result-section');section.append(v5SectionHeader('Wynik przeglądu','check'));const performed=d.performedAt?formatDate(d.performedAt):d.scheduledAt?formatDate(d.scheduledAt):null;const dateHelp=!performed&&d.variant==='DUE'?'Nie wyznaczono terminu.':'';const resultHelp=!d.result&&(d.variant==='DUE'||d.variant==='SCHEDULED')?'Wynik będzie dostępny po wykonaniu przeglądu.':'';const validHelp=!d.validUntil&&!d.validUntilLabel&&(d.variant==='DUE'||d.variant==='SCHEDULED')?'Data zostanie ustalona po wykonaniu przeglądu.':'';const grid=node('div','inspection-v5-result-grid');append(grid,v5SummaryTile('Data '+(d.performedAt?'wykonania':'planowana'),performed,'calendar',dateHelp),v5SummaryTile('Wynik',d.result,'shield',resultHelp),v5SummaryTile('Ważny do',d.validUntilLabel||(d.validUntil?formatDate(d.validUntil):null),'calendar',validHelp));append(section,grid,v5StatusPanel(d));return section}
function v5DeviceSection(d){const section=node('section','inspection-v5-section inspection-v5-device-data');const deviceAction=d.device.id?()=>{setInspectionShell(false);openDevice(d.device.id)}:null;const fullCard=featureButton('Zobacz pełną kartę urządzenia →',deviceAction,'inspection-v5-section-action');section.append(v5SectionHeader('Dane urządzenia','device',fullCard));const grid=node('div','inspection-v5-grid');append(grid,v5DeviceTile('Typ sprzętu',d.device.name),v5DeviceTile('Producent',d.device.manufacturer),v5DeviceTile('Model',d.device.model),v5DeviceTile('Numer seryjny',d.device.serialNumber),v5DeviceTile('Numer inwentarzowy',d.device.inventoryNumber));const rfid=node('div','inspection-v5-rfid-value');if(d.device.epc){append(rfid,node('span','inspection-v5-rfid-dot'),node('strong','','Urządzenie oznakowane'));const epc=node('button','inspection-v5-epc','Pokaż kod EPC →');epc.type='button';epc.addEventListener('click',()=>{epc.textContent=epc.textContent.startsWith('Pokaż')?d.device.epc:'Pokaż kod EPC →'});rfid.append(epc)}else rfid.append(node('strong','',text(d.device.tagged)));grid.append(v5DeviceTile('RFID / EPC',null,rfid),v5DeviceTile('Rok produkcji',d.device.productionYear),v5DeviceTile('Data uruchomienia',d.device.commissionedAt),v5DeviceTile('Gwarancja',d.device.warrantyUntil));section.append(grid);return section}
function v5LocationSection(d){const section=node('section','inspection-v5-section inspection-v5-location');section.append(v5SectionHeader('Lokalizacja','location'));const grid=node('div','inspection-v5-grid');append(grid,v5DeviceTile('Szpital',d.location.hospital),v5DeviceTile('Oddział',d.location.department));section.append(grid);return section}
function v5MediaEmpty(iconName,title,description){const empty=node('div','inspection-v5-media-empty');append(empty,v5Icon(iconName),node('div',''),node('strong','',title),node('p','',description));return empty}
function renderInspectionMediaTarget(item,detail){const media=node('div','inspection-v5-media-grid');const documents=node('section','inspection-v5-section media-section');documents.append(v5SectionHeader('Dokument przeglądu','document'));if(item.documents?.length){const list=node('div','document-list');for(const asset of item.documents)list.append(documentLink(asset));documents.append(list)}else documents.append(v5MediaEmpty('document','Brak dokumentu','Dokument będzie dostępny po wykonaniu przeglądu.'));const photos=node('section','inspection-v5-section media-section');const count=item.photos?.length||0;photos.append(v5SectionHeader(item.photoLabel||'Zdjęcia z przeglądu','camera',count?node('span','inspection-v5-photo-count',count+' '+(count===1?'zdjęcie':count<5?'zdjęcia':'zdjęć')):null));if(count){const gallery=node('div','photo-gallery');if(count>4)gallery.classList.add('is-collapsed');for(const asset of item.photos){const button=node('button','photo-thumb');button.type='button';button.setAttribute('aria-label','Otwórz '+asset.title);const image=node('img','photo-thumb-image');image.src=fileUrl(asset.id,'thumb');image.alt=asset.title;image.loading='lazy';append(button,image);button.addEventListener('click',()=>openPhoto(asset));gallery.append(button)}photos.append(gallery);if(count>4){const more=node('button','inspection-v5-gallery-more','Zobacz wszystkie zdjęcia →');more.type='button';more.addEventListener('click',()=>{const expanded=gallery.classList.toggle('is-expanded');more.textContent=expanded?'Pokaż mniej':'Zobacz wszystkie zdjęcia →'});photos.append(more)}}else photos.append(v5MediaEmpty('camera','Brak zdjęć','Zdjęcia nie zostały dodane do tego przeglądu.'));append(media,documents,photos);detail.append(media)}
function v5RelatedSection(d){const section=node('section','inspection-v5-section inspection-v5-links');section.append(v5SectionHeader('Powiązane informacje','link'));const grid=node('div','inspection-v5-links-grid');const action=d.device.id?()=>{setInspectionShell(false);openDevice(d.device.id)}:null;append(grid,v5RelatedCard('Zobacz kartę urządzenia','device',action),v5RelatedCard('Zobacz historię przeglądów','clock',action),v5RelatedCard('Zobacz historię napraw','wrench',action));section.append(grid);return section}
function renderInspectionV5(item,detail){const d=item.inspectionDetails;setInspectionShell(true);document.getElementById('casePageTitle').textContent='Przegląd #'+text(d.number);const head=node('header','inspection-v5-head');const breadcrumb=node('div','inspection-v5-breadcrumb');const back=node('button','','Przeglądy');back.type='button';back.addEventListener('click',()=>history.back());append(breadcrumb,back,node('span','','›'),node('span','','Karta przeglądu'));const titleRow=node('div','inspection-v5-title-row');append(titleRow,node('h1','','Przegląd #'+text(d.number)),v5StatusPill(d.status,d));const subtitle=d.variant==='PROBLEM'?'Przegląd nie został wykonany.':'Wynik przeglądu oraz szczegóły dla wybranego urządzenia.';const copy=node('div','inspection-v5-head-copy');append(copy,breadcrumb,titleRow,node('p','inspection-v5-subtitle',subtitle));const meta=node('div','inspection-v5-head-meta');if(d.headerDateType&&d.headerDate)meta.append(node('p','',d.headerDateType+': '+formatDateTime(d.headerDate)));append(head,copy,meta);detail.append(head);if(!d.verified){detail.append(v5StatusPanel(d));renderInspectionMediaTarget(item,detail);return}const hero=node('section','inspection-v5-hero is-'+v5Variant(d).tone);const deviceIcon=node('div','inspection-v5-device-icon');deviceIcon.append(v5Icon('device'));const device=node('div','inspection-v5-device');append(device,node('h2','',d.device.name),node('p','inspection-v5-device-sub',text(d.device.manufacturer)+' • '+text(d.device.model)),node('p','inspection-v5-device-id','SN: '+text(d.device.serialNumber)+'  |  Nr inw.: '+text(d.device.inventoryNumber)));const result=node('div','inspection-v5-result');append(result,v5StatusPill(d.heroLabel,d,'is-large'),node('p','',text(d.heroDescription,'')));append(hero,deviceIcon,device,result);detail.append(hero,v5ResultTarget(d),v5DeviceSection(d),v5LocationSection(d));renderInspectionMediaTarget(item,detail);detail.append(v5RelatedSection(d))}
function renderCase(item){const inspection=item.type==='INSPECTION'&&item.inspectionDetails;setInspectionShell(Boolean(inspection));document.getElementById('casePageTitle').textContent=inspection?'Przegląd #'+text(item.inspectionDetails.number):'Numer Sprawy: '+text(item.caseNumber);const deviceButton=document.getElementById('caseScreenDeviceLink');deviceButton.hidden=Boolean(inspection)||!item.deviceId;deviceButton.textContent=item.deviceId?item.deviceName+' → karta urządzenia':'Przejdź do karty urządzenia';const detail=document.getElementById('caseDetail');detail.replaceChildren();if(inspection){renderInspectionV5(item,detail);return}const header=node('div','case-header-line');append(header,node('span','case-kind','Naprawa'),node('span','case-service-inline','Serwis: '+portalModel.serviceProviderName));const hero=node('div','case-hero');const titleLine=node('div','hero-title-line');const inline=node('div','inline-status case-main-status');append(inline,node('label','','AKTUALNY STATUS'),status(item.currentStatus));append(titleLine,node('h2','',item.deviceName),inline);const grid=node('div','meta-grid case-meta-grid');append(grid,meta('Numer Sprawy',item.caseNumber),meta('Numer zlecenia klienta',text(item.clientOrderNumber,'brak numeru')),meta('Numer seryjny',item.serialNumber),meta('Nr inwentarzowy',item.inventoryNumber),meta('Oddział',item.department),meta('Data zgłoszenia',item.reportedAtDateOnly?formatDate(item.reportedAt):formatDateTime(item.reportedAt)));const description=meta('Usterka / opis',item.description);description.style.marginTop='9px';append(hero,titleLine,grid,description);append(detail,header,hero);renderCaseMedia(item,detail);renderHistory(item,detail)}
function emptyMini(title,description){const item=node('div','mini');append(item,node('b','',title),node('span','',description));return item}
const photoLightbox=document.getElementById('photoLightbox');const photoLightboxImage=document.getElementById('photoLightboxImage');const photoLightboxCaption=document.getElementById('photoLightboxCaption');const photoLightboxClose=document.getElementById('photoLightboxClose');
const featureModal=document.getElementById('featureModal');const featureModalX=document.getElementById('featureModalX');const featureModalClose=document.getElementById('featureModalClose');let featureModalReturnFocus=null;
function openFeatureModal(){featureModalReturnFocus=document.activeElement;featureModal.hidden=false;featureModal.classList.add('show');document.body.classList.add('feature-modal-open');featureModalX.focus()}
function closeFeatureModal(){featureModal.classList.remove('show');featureModal.hidden=true;document.body.classList.remove('feature-modal-open');const target=featureModalReturnFocus;featureModalReturnFocus=null;if(target&&document.contains(target))target.focus()}
function openPhoto(asset){photoLightbox.hidden=false;photoLightbox.classList.add('show');photoLightboxImage.alt=asset.title;photoLightboxCaption.textContent=asset.title;photoLightboxImage.src=fileUrl(asset.id,'portal');document.body.classList.add('lightbox-open');photoLightboxClose.focus()}
function closePhoto(){photoLightbox.classList.remove('show');photoLightbox.hidden=true;photoLightboxImage.removeAttribute('src');document.body.classList.remove('lightbox-open')}
document.addEventListener('click',event=>{const link=event.target.closest?.('a');if(link&&link.href===new URL(portalModel.upgradeUrl,location.href).href)sendAnalytics('UPGRADE_CLICK')});
photoLightboxClose.addEventListener('click',closePhoto);photoLightbox.addEventListener('click',event=>{if(event.target===photoLightbox)closePhoto()});featureModalX.addEventListener('click',closeFeatureModal);featureModalClose.addEventListener('click',closeFeatureModal);featureModal.addEventListener('click',event=>{if(event.target===featureModal)closeFeatureModal()});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!featureModal.hidden){closeFeatureModal();return}if(event.key==='Escape'&&!photoLightbox.hidden){closePhoto();return}if(event.key==='Tab'&&!featureModal.hidden){const focusable=[...featureModal.querySelectorAll('a[href],button:not([disabled])')];if(!focusable.length)return;const first=focusable[0],last=focusable[focusable.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}}});
document.getElementById('caseBack').addEventListener('click',()=>history.back());document.getElementById('deviceBack').addEventListener('click',()=>history.back());document.getElementById('caseScreenDeviceLink').addEventListener('click',()=>{if(currentCase?.deviceId)openDevice(currentCase.deviceId)});
document.querySelectorAll('#taskList .case-open').forEach((row,index)=>activate(row,()=>openCase(portalModel.initialCases.items[index].sourceRecordId)));
function applyPortalState(state){if(state?.portalScreen==='caseCard'&&state.caseId){openCase(state.caseId,false);return}if(state?.portalScreen==='deviceCard'&&state.deviceId){openDevice(state.deviceId,false);return}showListScreen(state?.portalScreen||'summary',false)}window.addEventListener('popstate',event=>applyPortalState(event.state));const initialScreen=location.hash==='#repairs'?'repairs':location.hash==='#inspections'?'inspections':'summary';history.replaceState({portalScreen:initialScreen},'');showListScreen(initialScreen,false);if(portalModel.focusedCase)openCase(portalModel.focusedCase.sourceRecordId)
`;
