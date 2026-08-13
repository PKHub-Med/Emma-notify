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
    ${devicesScreen(view.devices)}
    ${repairsScreen(view.repairs)}
    ${inspectionsScreen(view.inspections)}
    ${documentsScreen(view)}
    ${deviceCardScreen()}
    ${caseCardScreen()}
  </div></main>
</div>
<div class="modal" id="historyModal" role="dialog" aria-modal="true" aria-labelledby="historyTitle">
  <div class="modal-card"><h2 id="historyTitle">Dane historyczne</h2><p>Pełne dane historyczne spoza bieżących spraw są dostępne w rozszerzonej wersji Emma. Aby uzyskać dostęp, skontaktuj się z Emma Med.</p><div class="modal-actions"><button class="btn-secondary" data-close-history>Zamknij</button><button class="btn-primary" data-close-history>Skontaktuj się z Emma</button></div></div>
</div>
<script nonce="${escapeHtml(scriptNonce)}">
const portalModel=${modelJson};
const todayWarsaw=${JSON.stringify(todayWarsaw)};
${PORTAL_SCRIPT}
</script>
</body></html>`;
}

export function portalPageHeaders(scriptNonce: string) {
  return {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'none'; font-src 'none'`,
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
    <section class="panel"><div class="filter-state"><div><h2>Lista zadań</h2><p id="filterLabel">Wszystkie sprawy — najświeższa zmiana na górze.</p></div><button class="clear-filter" id="clearFilter">Pokaż wszystkie</button></div>
      ${searchBar("summarySearch", "Szukaj po urządzeniu, Numerze Sprawy, numerze klienta, numerze seryjnym, inwentarzowym lub statusie…")}
      <div class="task-list" id="taskList">${view.cases.map(summaryRow).join("")}</div>
      ${emptyState("summaryEmpty", "Brak spraw dostępnych w tym widoku.", view.cases.length === 0)}
      ${historyButton()}
    </section>
  </section>`;
}

function devicesScreen(devices: readonly PortalDevice[]): string {
  return `<section class="screen" id="devices"><div class="page-head"><div class="kicker">Urządzenia</div><h1>Urządzenia</h1><p>Lista urządzeń powiązanych ze sprawami dostępnymi w tym widoku. Kliknięcie otwiera kartę urządzenia.</p></div>
    <div class="panel">${searchBar("deviceSearch", "Szukaj po nazwie urządzenia, producencie, modelu, numerze seryjnym lub inwentarzowym…")}
      <div class="task-list" id="deviceRows">${devices.map(deviceRow).join("")}</div>
      ${emptyState("deviceNoResults", "Brak urządzeń pasujących do wyszukiwania.", devices.length === 0)}${historyButton()}
    </div></section>`;
}

function repairsScreen(items: readonly PortalCaseListItem[]): string {
  return `<section class="screen" id="repairs"><div class="page-head"><div class="kicker">Naprawy</div><h1>Naprawy</h1><p>Lista napraw urządzeń powiązanych ze sprawami dostępnymi w tym widoku. Kliknięcie otwiera kartę sprawy.</p></div>
    <div class="panel">${searchBar("repairSearch", "Szukaj po urządzeniu, Numerze Sprawy, numerze klienta, SN, numerze inwentarzowym lub statusie…")}
      <div class="task-list repair-list" id="repairRows">${items.map(repairRow).join("")}</div>
      ${emptyState("repairNoResults", "Brak napraw pasujących do wyszukiwania.", items.length === 0)}${historyButton()}
    </div></section>`;
}

function inspectionsScreen(items: readonly PortalCaseListItem[]): string {
  return `<section class="screen" id="inspections"><div class="page-head"><div class="kicker">Przeglądy</div><h1>Przeglądy</h1><p>Przeglądy urządzeń powiązanych z dostępnymi sprawami. Kliknięcie otwiera kartę sprawy.</p></div>
    <div class="panel">${searchBar("inspectionSearch", "Szukaj po urządzeniu, Numerze Sprawy, numerze klienta, SN, dacie przeglądu lub statusie…")}
      <div class="task-list" id="inspectionRows">${items.map(inspectionRow).join("")}</div>
      ${emptyState("inspectionNoResults", "Brak przeglądów pasujących do wyszukiwania.", items.length === 0)}${historyButton()}
    </div></section>`;
}

function documentsScreen(view: HospitalPortalViewModel): string {
  return `<section class="screen" id="documents"><div class="page-head"><div class="kicker">Dokumenty</div><h1>Dokumenty</h1><p>Wyszukuj dokumenty po urządzeniu, producencie, modelu, numerze seryjnym albo nazwie pliku.</p></div>
    <div class="panel" style="padding:15px"><div class="document-tools"><input id="documentSearch" type="search" placeholder="Szukaj dokumentu, urządzenia, producenta, modelu lub numeru seryjnego…" aria-label="Szukaj dokumentów"><select id="documentField"><option value="all">Wszystkie pola</option><option value="device">Nazwa urządzenia</option><option value="maker">Producent</option><option value="model">Model</option><option value="serial">Numer seryjny</option><option value="document">Nazwa dokumentu</option></select></div>
      <table class="documents-table"><thead><tr><th>Dokument</th><th>Urządzenie</th><th>Producent</th><th>Model</th><th>Numer seryjny</th><th>Sprawa</th></tr></thead><tbody id="documentsBody"></tbody></table>
      ${emptyState("documentNoResults", "Brak dokumentów w tym widoku.", view.documents.length === 0)}${historyButton("bottom-history")}
    </div></section>`;
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

function historyButton(wrapper = "history-row"): string {
  return `<div class="${wrapper}"><button class="history-btn" data-open-history>Załaduj dane historyczne</button></div>`;
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
const navButtons=[...document.querySelectorAll('.nav button')];
let lastScreen='summary';
let currentCase=null;
let activeSummaryFilter=null;
const caseById=new Map(portalModel.cases.map(item=>[item.sourceRecordId,item]));
const deviceById=new Map(portalModel.devices.map(item=>[item.sourceRecordId,item]));
const text=(value,fallback='—')=>typeof value==='string'&&value.trim()?value:fallback;
const node=(tag,className,content)=>{const result=document.createElement(tag);if(className)result.className=className;if(content!==undefined)result.textContent=content;return result};
const append=(parent,...children)=>{for(const child of children){if(child)parent.append(child)}return parent};
const formatDate=value=>value?new Intl.DateTimeFormat('pl-PL',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'Europe/Warsaw'}).format(new Date(value)):'—';
const formatDateTime=value=>value?new Intl.DateTimeFormat('pl-PL',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Europe/Warsaw'}).format(new Date(value)):'—';
const statusClass=status=>{const value=(status||'').toLocaleLowerCase('pl-PL');if(value.includes('oczekujemy na decyzję')||value.includes('niesprawny')||value.includes('problem'))return'red';if(value.includes('naprawa')||value.includes('diagnostyka')||value.includes('części'))return'amber';if(value.includes('sprawny')||value.includes('zakończ'))return'green';if(value.includes('do realizacji')||value.includes('umów'))return'blue';return'neutral'};
function showScreen(id){screens.forEach(s=>s.classList.toggle('active',s.id===id));navButtons.forEach(b=>b.classList.toggle('active',b.dataset.screen===id));}
navButtons.forEach(button=>button.addEventListener('click',()=>{lastScreen=button.dataset.screen;showScreen(button.dataset.screen)}));
function activate(element,callback){element.addEventListener('click',callback);element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();callback()}})}
document.querySelectorAll('.case-open').forEach(element=>activate(element,()=>openCase(element.dataset.caseId)));
document.querySelectorAll('.device-open').forEach(element=>activate(element,()=>openDevice(element.dataset.deviceId)));
function meta(label,value){const wrap=node('div','meta');append(wrap,node('label','',label),node('strong','',text(value)));return wrap}
function status(value){return node('span','status-tag '+statusClass(value),text(value,'Brak informacji'))}
function caseLink(item){const button=node('button','case-link');button.type='button';const info=node('span');append(info,node('b','','Numer Sprawy: '+text(item.caseNumber)),node('span','',item.currentStatus));append(button,info,node('span','arrow','›'));button.addEventListener('click',()=>openCase(item.sourceRecordId));return button}
function openCase(id){const item=caseById.get(id);if(!item)return;const active=document.querySelector('.screen.active');if(active&&active.id!=='caseCard')lastScreen=active.id;currentCase=item;document.getElementById('casePageTitle').textContent='Numer Sprawy: '+text(item.caseNumber);const deviceButton=document.getElementById('caseScreenDeviceLink');deviceButton.hidden=!item.deviceId;deviceButton.textContent=item.deviceId?item.deviceName+' → karta urządzenia':'Przejdź do karty urządzenia';const detail=document.getElementById('caseDetail');detail.replaceChildren();const header=node('div','case-header-line');append(header,node('span','case-kind',item.type==='REPAIR'?'Naprawa':'Przegląd'),node('span','case-service-inline','Serwis: '+portalModel.serviceProviderName));const hero=node('div','case-hero');const titleLine=node('div','hero-title-line');const title=node('h2','',item.deviceName);const inline=node('div','inline-status case-main-status');append(inline,node('label','','AKTUALNY STATUS'),status(item.currentStatus));append(titleLine,title,inline);const grid=node('div','meta-grid case-meta-grid');append(grid,meta('Numer Sprawy',item.caseNumber),meta('Numer zlecenia klienta',text(item.clientOrderNumber,'brak numeru')),meta('Numer seryjny',item.serialNumber),meta('Nr inwentarzowy',item.inventoryNumber));if(item.type==='REPAIR')append(grid,meta('Data zgłoszenia',formatDateTime(item.reportedAt)));else append(grid,meta('Data wykonania przeglądu',formatDate(item.inspectionPerformedAt)),meta('Ważny do',formatDate(item.validUntil)));const description=meta(item.type==='REPAIR'?'Usterka / opis':'Uwagi / opis',item.description);description.style.marginTop='9px';append(hero,titleLine,grid,description);append(detail,header,hero);if(item.documents.length){const section=node('div','section');append(section,node('h3','','Dokumenty'),node('div','no-results','Dokumenty są dostępne wyłącznie przez bezpieczne łącza portalu.'));detail.append(section)}if(item.photos.length){const section=node('div','media-section');append(section,node('h3','','Zdjęcia'));detail.append(section)}if(item.history.length){const section=node('div','section');append(section,node('h3','','Historia zmian'),node('p','history-order-note','Najstarsza zmiana jest na górze, najnowsza na dole.'));const timeline=node('div','case-history');for(const event of item.history){const row=node('div','case-history-item');const date=node('div','case-history-date',formatDateTime(event.changedAt));const rail=node('div','case-history-rail');rail.append(node('div','case-history-dot'));const card=node('div','case-history-card');append(card,node('b','',event.title),node('p','',text(event.description,'')));append(row,date,rail,card);timeline.append(row)}section.append(timeline);detail.append(section)}showScreen('caseCard')}
function openDevice(id){const item=deviceById.get(id);if(!item)return;const active=document.querySelector('.screen.active');lastScreen=active&&active.id==='caseCard'?'caseCard':'devices';document.getElementById('devicePageTitle').textContent=item.deviceName;const detail=document.getElementById('deviceDetail');detail.replaceChildren();const hero=node('div','device-hero');const titleLine=node('div','hero-title-line');const inline=node('div','inline-status');append(inline,node('label','','AKTUALNY STATUS'),status(item.currentStatus));append(titleLine,node('h2','',item.deviceName),inline);const grid=node('div','meta-grid');append(grid,meta('Nr inwentarzowy',item.inventoryNumber),meta('Numer seryjny',item.serialNumber),meta('Producent / model',[item.manufacturer,item.model].filter(Boolean).join(' · ')||null));append(hero,titleLine,grid,inspectionPanel(item.validUntil));detail.append(hero);const repairSection=node('div','section');repairSection.append(node('h3','','Naprawy'));const repairList=node('div','case-list');const repairs=item.repairs.map(id=>caseById.get(id)).filter(Boolean);repairs.length?repairs.forEach(value=>repairList.append(caseLink(value))):repairList.append(emptyMini('Brak napraw','Brak napraw w tym widoku.'));repairSection.append(repairList);const inspectionSection=node('div','section');inspectionSection.append(node('h3','','Przeglądy'));const inspectionList=node('div','case-list');const inspections=item.inspections.map(id=>caseById.get(id)).filter(Boolean);inspections.length?inspections.forEach(value=>inspectionList.append(caseLink(value))):inspectionList.append(emptyMini('Brak przeglądów','Brak przeglądów w tym widoku.'));inspectionSection.append(inspectionList);append(detail,repairSection,inspectionSection);showScreen('deviceCard')}
function emptyMini(title,description){const item=node('div','mini');append(item,node('b','',title),node('span','',description));return item}
function inspectionPanel(validUntil){const panel=node('div','device-card-inspection');const left=node('div');append(left,node('div','label','Przegląd urządzenia'),node('strong','','Termin: '+formatDate(validUntil)));const right=node('div');const health=inspectionHealth(validUntil);append(right,node('span','inspection-state '+health.state,health.label),node('span','inspection-date',health.detail));append(panel,left,right);return panel}
function inspectionHealth(value){if(!value)return{state:'',label:'Brak terminu',detail:'brak danych'};const due=value.slice(0,10);const days=Math.round((Date.parse(due+'T00:00:00Z')-Date.parse(todayWarsaw+'T00:00:00Z'))/86400000);return days<0?{state:'overdue',label:'Przegląd nieaktualny',detail:'po terminie '+Math.abs(days)+' dni'}:{state:days<=30?'soon':'ok',label:'Przegląd aktualny',detail:'kończy się za '+days+' dni'}}
document.getElementById('caseBack').addEventListener('click',()=>showScreen(lastScreen||'summary'));
document.getElementById('caseScreenDeviceLink').addEventListener('click',()=>{if(currentCase?.deviceId)openDevice(currentCase.deviceId)});
const labels={action:'Naprawy i przeglądy, które wymagają reakcji po stronie szpitala.',repair:'Wszystkie naprawy — aktywne, wymagające akcji i zakończone.',inspection:'Wszystkie przeglądy — planowane, wykonane, aktualne i po terminie.'};
const summaryRows=[...document.querySelectorAll('#taskList .task')];
function refreshSummary(){const query=(document.getElementById('summarySearch').value||'').trim().toLocaleLowerCase('pl-PL');let visible=0;for(const row of summaryRows){const filterOk=!activeSummaryFilter||(activeSummaryFilter==='action'?row.dataset.requiresAction==='true':row.dataset.category===activeSummaryFilter);const searchOk=!query||row.textContent.toLocaleLowerCase('pl-PL').includes(query);row.style.display=filterOk&&searchOk?'grid':'none';if(filterOk&&searchOk)visible++}document.getElementById('summaryEmpty').style.display=visible?'none':'block'}
document.querySelectorAll('.summary-card').forEach(card=>card.addEventListener('click',()=>{activeSummaryFilter=activeSummaryFilter===card.dataset.filter?null:card.dataset.filter;document.querySelectorAll('.summary-card').forEach(value=>value.classList.toggle('active',value.dataset.filter===activeSummaryFilter));document.getElementById('filterLabel').textContent=activeSummaryFilter?labels[activeSummaryFilter]:'Wszystkie sprawy — najświeższa zmiana na górze.';refreshSummary()}));
document.getElementById('clearFilter').addEventListener('click',()=>{activeSummaryFilter=null;document.querySelectorAll('.summary-card').forEach(value=>value.classList.remove('active'));document.getElementById('filterLabel').textContent='Wszystkie sprawy — najświeższa zmiana na górze.';refreshSummary()});
document.getElementById('summarySearch').addEventListener('input',refreshSummary);
function bindSearch(inputId,selector,emptyId){const input=document.getElementById(inputId);const rows=[...document.querySelectorAll(selector)];input.addEventListener('input',()=>{const query=(input.value||'').trim().toLocaleLowerCase('pl-PL');let visible=0;for(const row of rows){const show=!query||row.textContent.toLocaleLowerCase('pl-PL').includes(query);row.style.display=show?'grid':'none';if(show)visible++}document.getElementById(emptyId).style.display=visible?'none':'block'})}
bindSearch('deviceSearch','.device-row-search','deviceNoResults');bindSearch('repairSearch','.repair-row-search','repairNoResults');bindSearch('inspectionSearch','.inspection-row-search','inspectionNoResults');
const historyModal=document.getElementById('historyModal');document.querySelectorAll('[data-open-history]').forEach(button=>button.addEventListener('click',()=>historyModal.classList.add('show')));document.querySelectorAll('[data-close-history]').forEach(button=>button.addEventListener('click',()=>historyModal.classList.remove('show')));historyModal.addEventListener('click',event=>{if(event.target===historyModal)historyModal.classList.remove('show')});document.addEventListener('keydown',event=>{if(event.key==='Escape')historyModal.classList.remove('show')});
document.querySelectorAll('[data-inspection-due]').forEach(element=>{const health=inspectionHealth(element.dataset.inspectionDue);element.className='inspection-state '+health.state;element.textContent=health.label;const detail=element.nextElementSibling;if(detail)detail.textContent=health.detail});
if(portalModel.focusedCaseId&&caseById.has(portalModel.focusedCaseId))openCase(portalModel.focusedCaseId);
`;
