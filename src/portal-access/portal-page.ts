import { PORTAL_STYLES } from "./portal-styles.js";
import type {
  HospitalPortalViewModel,
  PortalCaseListItem,
  PortalDevice,
} from "./view-model.js";

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
  return `<section class="screen device-card-screen" id="deviceCard"><div class="page-head"><div class="kicker">Karta urządzenia</div><h1 id="devicePageTitle">Urządzenie</h1><p>Naprawy i przeglądy powiązane z wybranym urządzeniem.</p></div><div class="panel"><div class="detail" id="deviceDetail"></div></div></section>`;
}

function caseCardScreen(): string {
  return `<section class="screen" id="caseCard"><div class="page-head"><div class="kicker">Karta sprawy</div><h1 id="casePageTitle">Numer Sprawy</h1><p>Pełny przebieg wybranej naprawy lub przeglądu dla konkretnego urządzenia.</p><div class="case-screen-link"><button id="caseScreenDeviceLink" type="button">Przejdź do karty urządzenia</button></div></div><div class="panel detail"><button class="back" id="caseBack">← Wróć do listy</button><div id="caseDetail"></div></div></section>`;
}

function summaryRow(item: PortalCaseListItem): string {
  return `<article class="task case-open" role="button" tabindex="0" data-category="${item.type === "REPAIR" ? "repair" : "inspection"}" data-requires-action="${item.requiresAction}" data-case-id="${escapeAttr(item.sourceRecordId)}"><div><div class="task-device">${escapeHtml(item.deviceName)}</div><div class="task-meta">${deviceMeta(item)}</div><div class="task-case-meta"><span>Numer Sprawy: ${display(item.caseNumber)}</span><span>Nr zlecenia klienta: ${display(item.clientOrderNumber, "brak numeru")}</span></div></div><div><div class="task-current-label">Aktualny status</div><div class="task-current status-tag ${statusClass(item.currentStatus)}">${escapeHtml(item.currentStatus)}</div></div><div class="task-side"><div class="task-date-label">Ostatnia zmiana</div><div class="task-date">${formatDateTime(item.lastChangedAt)}</div></div></article>`;
}

function deviceRow(item: PortalDevice): string {
  return `<article class="list-row device-row-search device-open" role="button" tabindex="0" data-device-id="${escapeAttr(item.sourceRecordId)}"><div class="list-row-main"><b>${escapeHtml(item.deviceName)}</b><span>${deviceMeta(item)}</span></div><div class="device-list-status">${inspectionBadge(item.validUntil)}</div><div class="list-row-side"><span class="status-tag ${statusClass(item.currentStatus)}">${escapeHtml(item.currentStatus)}</span></div></article>`;
}

function repairRow(item: PortalCaseListItem): string {
  return `<article class="repair-row repair-row-search case-open" role="button" tabindex="0" data-case-id="${escapeAttr(item.sourceRecordId)}"><div><b>${escapeHtml(item.deviceName)}</b><span class="sub">${deviceMeta(item)}</span><span class="sub">Numer Sprawy: ${display(item.caseNumber)} · Nr zlecenia klienta: ${display(item.clientOrderNumber, "brak numeru")}</span></div><div><span class="status-tag ${statusClass(item.currentStatus)}">${escapeHtml(item.currentStatus)}</span></div><div class="date-block"><span>Data zgłoszenia</span><strong>${formatDateTime(item.reportedAt)}</strong></div></article>`;
}

function inspectionRow(item: PortalCaseListItem): string {
  return `<article class="list-row inspection-row-search case-open" role="button" tabindex="0" data-case-id="${escapeAttr(item.sourceRecordId)}"><div class="list-row-main"><b>${escapeHtml(item.deviceName)}</b><span>${deviceMeta(item)}</span><span>Numer Sprawy: ${display(item.caseNumber)} · Nr zlecenia klienta: ${display(item.clientOrderNumber, "brak numeru")}</span></div><div class="list-row-mid"><b>Aktualny status</b><span class="status-tag ${statusClass(item.currentStatus)}">${escapeHtml(item.currentStatus)}</span></div><div class="inspection-dates"><span><b>Data wykonania</b>${formatDate(item.inspectionPerformedAt)}</span><span><b>Ważny do</b>${formatDate(item.validUntil)}</span></div></article>`;
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
const caseCache=new Map();
if(portalModel.focusedCase)caseCache.set(portalModel.focusedCase.sourceRecordId,portalModel.focusedCase);
for(const item of portalModel.initialCases.items)caseCache.set(item.sourceRecordId,item);
let lastScreen='summary';let currentCase=null;let activeSummaryFilter='ALL';
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
function showScreen(id){screens.forEach(screen=>screen.classList.toggle('active',screen.id===id));navButtons.forEach(button=>button.classList.toggle('active',button.dataset.screen===id));}
async function api(path,params={}){const url=new URL(dataBasePath+'/data/'+path,location.origin);for(const [key,value]of Object.entries(params))if(value)url.searchParams.set(key,String(value));const response=await fetch(url,{headers:{Accept:'application/json'},cache:'no-store'});if(!response.ok)throw new Error('PORTAL_DATA_UNAVAILABLE');return response.json()}
function meta(label,value){const wrap=node('div','meta');append(wrap,node('label','',label),node('strong','',text(value)));return wrap}
function makeSummaryRow(item){const row=node('article','task case-open');row.dataset.category=item.type==='REPAIR'?'repair':'inspection';row.dataset.requiresAction=String(item.requiresAction);const main=node('div');append(main,node('div','task-device',item.deviceName),node('div','task-meta',deviceMeta(item)));const caseMeta=node('div','task-case-meta');append(caseMeta,node('span','','Numer Sprawy: '+text(item.caseNumber)),node('span','','Nr zlecenia klienta: '+text(item.clientOrderNumber,'brak numeru')));main.append(caseMeta);const current=node('div');append(current,node('div','task-current-label','Aktualny status'),status(item.currentStatus));const side=node('div','task-side');append(side,node('div','task-date-label','Ostatnia zmiana'),node('div','task-date',formatDateTime(item.lastChangedAt)));append(row,main,current,side);activate(row,()=>openCase(item.sourceRecordId));return row}
function makeRepairRow(item){const row=node('article','repair-row repair-row-search');const main=node('div');append(main,node('b','',item.deviceName),node('span','sub',deviceMeta(item)),node('span','sub','Numer Sprawy: '+text(item.caseNumber)+' · Nr zlecenia klienta: '+text(item.clientOrderNumber,'brak numeru')));const state=node('div');state.append(status(item.currentStatus));const date=node('div','date-block');append(date,node('span','','Data zgłoszenia'),node('strong','',formatDateTime(item.reportedAt)));append(row,main,state,date);activate(row,()=>openCase(item.sourceRecordId));return row}
function makeInspectionRow(item){const row=node('article','list-row inspection-row-search');const main=node('div','list-row-main');append(main,node('b','',item.deviceName),node('span','',deviceMeta(item)),node('span','','Numer Sprawy: '+text(item.caseNumber)+' · Nr zlecenia klienta: '+text(item.clientOrderNumber,'brak numeru')));const middle=node('div','list-row-mid');append(middle,node('b','','Aktualny status'),status(item.currentStatus));const dates=node('div','inspection-dates');const performed=node('span');append(performed,node('b','','Data wykonania'),document.createTextNode(formatDate(item.inspectionPerformedAt)));const due=node('span');append(due,node('b','','Ważny do'),document.createTextNode(formatDate(item.validUntil)));append(dates,performed,due);append(row,main,middle,dates);activate(row,()=>openCase(item.sourceRecordId));return row}
function inspectionHealth(value){if(!value)return{state:'',label:'Brak terminu',detail:'brak danych'};const due=value.slice(0,10);const days=Math.round((Date.parse(due+'T00:00:00Z')-Date.parse(todayWarsaw+'T00:00:00Z'))/86400000);return days<0?{state:'overdue',label:'Przegląd nieaktualny',detail:'po terminie '+Math.abs(days)+' dni'}:{state:days<=30?'soon':'ok',label:'Przegląd aktualny',detail:'kończy się za '+days+' dni'}}
function makeDeviceRow(item){const row=node('article','list-row device-row-search');const main=node('div','list-row-main');append(main,node('b','',item.deviceName),node('span','',deviceMeta(item)));const health=inspectionHealth(item.validUntil);const inspection=node('div','device-list-status');append(inspection,node('span','inspection-state '+health.state,health.label),node('span','inspection-date',health.detail));const side=node('div','list-row-side');side.append(status(item.currentStatus));append(row,main,inspection,side);activate(row,()=>openDevice(item.sourceRecordId));return row}
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
navButtons.forEach(button=>button.addEventListener('click',()=>{const id=button.dataset.screen;lastScreen=id;showScreen(id);if(id==='repairs'&&!lists.repairs.initialized)loadCases('repairs',true);if(id==='inspections'&&!lists.inspections.initialized)loadCases('inspections',true);if(id==='devices'&&!devicesState.initialized)loadDevices(true);if(id==='documents'&&!documentsState.initialized)loadDocuments()}));
const labels={ACTION:'Naprawy i przeglądy, które wymagają reakcji po stronie szpitala.',REPAIR:'Wszystkie naprawy — aktywne, wymagające akcji i zakończone.',INSPECTION:'Wszystkie przeglądy — planowane, wykonane, aktualne i po terminie.'};
document.querySelectorAll('.summary-card').forEach(card=>card.addEventListener('click',()=>{const value=card.dataset.filter.toUpperCase();activeSummaryFilter=activeSummaryFilter===value?'ALL':value;lists.summary.filter=activeSummaryFilter;document.querySelectorAll('.summary-card').forEach(item=>item.classList.toggle('active',item.dataset.filter.toUpperCase()===activeSummaryFilter));document.getElementById('filterLabel').textContent=activeSummaryFilter==='ALL'?'Wszystkie sprawy — najświeższa zmiana na górze.':labels[activeSummaryFilter];loadCases('summary',true)}));
document.getElementById('clearFilter').addEventListener('click',()=>{activeSummaryFilter='ALL';lists.summary.filter='ALL';document.querySelectorAll('.summary-card').forEach(item=>item.classList.remove('active'));document.getElementById('filterLabel').textContent='Wszystkie sprawy — najświeższa zmiana na górze.';loadCases('summary',true)});
function debounceSearch(inputId,callback){let timer;document.getElementById(inputId).addEventListener('input',event=>{clearTimeout(timer);timer=setTimeout(()=>{const query=event.target.value.trim();if(query.length===1)return;callback(query.length>=2?query:null)},300)})}
debounceSearch('summarySearch',query=>{lists.summary.query=query;loadCases('summary',true)});debounceSearch('repairSearch',query=>{lists.repairs.query=query;loadCases('repairs',true)});debounceSearch('inspectionSearch',query=>{lists.inspections.query=query;loadCases('inspections',true)});debounceSearch('deviceSearch',query=>{devicesState.query=query;loadDevices(true)});
debounceSearch('documentSearch',query=>{documentsState.query=query;loadDocuments()});
async function openCase(id){const active=document.querySelector('.screen.active');if(active&&active.id!=='caseCard')lastScreen=active.id;const detail=document.getElementById('caseDetail');detail.replaceChildren(node('div','portal-loading','Ładowanie…'));showScreen('caseCard');try{const item=portalModel.focusedCase?.sourceRecordId===id?portalModel.focusedCase:await api('cases/'+encodeURIComponent(id));caseCache.set(id,item);currentCase=item;renderCase(item)}catch{detail.replaceChildren(node('div','portal-error','Nie udało się pobrać danych. Spróbuj ponownie.'))}}
function renderCase(item){document.getElementById('casePageTitle').textContent='Numer Sprawy: '+text(item.caseNumber);const deviceButton=document.getElementById('caseScreenDeviceLink');deviceButton.hidden=!item.deviceId;deviceButton.textContent=item.deviceId?item.deviceName+' → karta urządzenia':'Przejdź do karty urządzenia';const detail=document.getElementById('caseDetail');detail.replaceChildren();const header=node('div','case-header-line');append(header,node('span','case-kind',item.type==='REPAIR'?'Naprawa':'Przegląd'),node('span','case-service-inline','Serwis: '+portalModel.serviceProviderName));const hero=node('div','case-hero');const titleLine=node('div','hero-title-line');const inline=node('div','inline-status case-main-status');append(inline,node('label','','AKTUALNY STATUS'),status(item.currentStatus));append(titleLine,node('h2','',item.deviceName),inline);const grid=node('div','meta-grid case-meta-grid');append(grid,meta('Numer Sprawy',item.caseNumber),meta('Numer zlecenia klienta',text(item.clientOrderNumber,'brak numeru')),meta('Numer seryjny',item.serialNumber),meta('Nr inwentarzowy',item.inventoryNumber));if(item.type==='REPAIR')append(grid,meta('Data zgłoszenia',formatDateTime(item.reportedAt)));else append(grid,meta('Data wykonania przeglądu',formatDate(item.inspectionPerformedAt)),meta('Ważny do',formatDate(item.validUntil)));const description=meta(item.type==='REPAIR'?'Usterka / opis':'Uwagi / opis',item.description);description.style.marginTop='9px';append(hero,titleLine,grid,description);if(item.devices?.length>1){const deviceSection=node('div','section');deviceSection.append(node('h3','','Urządzenia w sprawie'));for(const device of item.devices){const row=node('div','list-row');append(row,node('b','',device.deviceName),node('span','',deviceMeta(device)));deviceSection.append(row)}hero.append(deviceSection)}append(detail,header,hero);if(item.documents?.length){const section=node('div','section media-section');section.append(node('h3','','Dokumenty'));const list=node('div','document-list');for(const asset of item.documents)list.append(documentLink(asset));section.append(list);detail.append(section)}if(item.photos?.length){const section=node('div','section media-section');section.append(node('h3','','Zdjęcia'));const gallery=node('div','photo-gallery');for(const asset of item.photos){const button=node('button','photo-thumb');button.type='button';button.setAttribute('aria-label','Otwórz '+asset.title);const image=node('img','photo-thumb-image');image.src=fileUrl(asset.id,'thumb');image.alt=asset.title;image.loading='lazy';append(button,image,node('span','photo-caption',asset.title));button.addEventListener('click',()=>openPhoto(asset));gallery.append(button)}section.append(gallery);detail.append(section)}if(item.history?.length){const section=node('div','section');append(section,node('h3','','Historia zmian'),node('p','history-order-note','Najstarsza zmiana jest na górze, najnowsza na dole.'));const timeline=node('div','case-history');for(const event of item.history){const row=node('div','case-history-item');const rail=node('div','case-history-rail');rail.append(node('div','case-history-dot'));const card=node('div','case-history-card');append(card,node('b','',event.title),node('p','',text(event.description,'')));append(row,node('div','case-history-date',formatDateTime(event.changedAt)),rail,card);timeline.append(row)}section.append(timeline);detail.append(section)}}
async function openDevice(id){const active=document.querySelector('.screen.active');lastScreen=active&&active.id==='caseCard'?'caseCard':'devices';const detail=document.getElementById('deviceDetail');detail.replaceChildren(node('div','portal-loading','Ładowanie…'));showScreen('deviceCard');try{const item=await api('devices/'+encodeURIComponent(id));renderDevice(item)}catch{detail.replaceChildren(node('div','portal-error','Nie udało się pobrać danych. Spróbuj ponownie.'))}}
function renderDevice(item){document.getElementById('devicePageTitle').textContent=item.deviceName;const detail=document.getElementById('deviceDetail');detail.replaceChildren();const hero=node('div','device-hero');const titleLine=node('div','hero-title-line');const inline=node('div','inline-status');append(inline,node('label','','STATUS URZĄDZENIA'),status(item.currentStatus));append(titleLine,node('h2','',item.deviceName),inline);const grid=node('div','meta-grid');append(grid,meta('Nr inwentarzowy',item.inventoryNumber),meta('Numer seryjny',item.serialNumber),meta('Producent / model',[item.manufacturer,item.model].filter(Boolean).join(' · ')||null),meta('Ostatni przegląd',formatDate(item.inspectionPerformedAt)),meta('Wynik przeglądu',item.inspectionResult));const health=inspectionHealth(item.validUntil);const inspection=node('div','device-card-inspection');const left=node('div');append(left,node('div','label','Ważność przeglądu'),node('strong','','Ważny do: '+formatDate(item.validUntil)));const right=node('div');append(right,node('span','inspection-state '+health.state,health.label),node('span','inspection-date',health.detail));append(inspection,left,right);append(hero,titleLine,grid,inspection);detail.append(hero);for(const type of ['REPAIR','INSPECTION']){const section=node('div','section');append(section,node('h3','',type==='REPAIR'?'Naprawy':'Przeglądy'));const list=node('div','case-list');const cases=item.cases.items.filter(value=>value.type===type);if(cases.length)for(const value of cases)list.append(caseLink(value));else list.append(emptyMini(type==='REPAIR'?'Brak napraw':'Brak przeglądów','Brak danych w tym widoku.'));section.append(list);detail.append(section)}if(item.lockedCaseCount>0){const teaser=node('aside','upgrade-teaser');const copy=node('div');append(copy,node('strong','','Pełna historia urządzenia'),node('p','','Emma posiada jeszcze '+item.lockedCaseCount+' wpisów historii tego urządzenia.'));const link=node('a','','Odblokuj pełną Emmę');link.href=portalModel.upgradeUrl;link.rel='nofollow';append(teaser,copy,link);detail.append(teaser)}}
function caseLink(item){caseCache.set(item.sourceRecordId,item);const button=node('button','case-link');button.type='button';const info=node('span');append(info,node('b','','Numer Sprawy: '+text(item.caseNumber)),node('span','',item.currentStatus));append(button,info,node('span','arrow','›'));button.addEventListener('click',()=>openCase(item.sourceRecordId));return button}
function emptyMini(title,description){const item=node('div','mini');append(item,node('b','',title),node('span','',description));return item}
const photoLightbox=document.getElementById('photoLightbox');const photoLightboxImage=document.getElementById('photoLightboxImage');const photoLightboxCaption=document.getElementById('photoLightboxCaption');const photoLightboxClose=document.getElementById('photoLightboxClose');
function openPhoto(asset){photoLightbox.hidden=false;photoLightbox.classList.add('show');photoLightboxImage.alt=asset.title;photoLightboxCaption.textContent=asset.title;photoLightboxImage.src=fileUrl(asset.id,'portal');document.body.classList.add('lightbox-open');photoLightboxClose.focus()}
function closePhoto(){photoLightbox.classList.remove('show');photoLightbox.hidden=true;photoLightboxImage.removeAttribute('src');document.body.classList.remove('lightbox-open')}
photoLightboxClose.addEventListener('click',closePhoto);photoLightbox.addEventListener('click',event=>{if(event.target===photoLightbox)closePhoto()});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!photoLightbox.hidden)closePhoto()});
document.getElementById('caseBack').addEventListener('click',()=>showScreen(lastScreen||'summary'));document.getElementById('caseScreenDeviceLink').addEventListener('click',()=>{if(currentCase?.deviceId)openDevice(currentCase.deviceId)});
document.querySelectorAll('#taskList .case-open').forEach((row,index)=>activate(row,()=>openCase(portalModel.initialCases.items[index].sourceRecordId)));
if(portalModel.focusedCase)openCase(portalModel.focusedCase.sourceRecordId);
`;
