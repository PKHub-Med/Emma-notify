// Reused from the accepted Emma portal UX source of truth.
export const PORTAL_STYLES = String.raw`
:root{
  --navy:#223f6d;
  --navy-2:#2c4b7a;
  --navy-3:#33598f;
  --bg:#f1f4f8;
  --panel:#fff;
  --line:#d9e1eb;
  --text:#1f2f49;
  --muted:#66758a;
  --soft:#f7f9fc;
  --green:#2b7a64;
  --green-soft:#e7f3ef;
  --amber:#9b6a12;
  --amber-soft:#fbf1db;
  --red:#9a4949;
  --red-soft:#f8e9e9;
  --blue-soft:#eaf0f9;
  --shadow:0 8px 20px rgba(18,38,63,.05);
  --radius:15px;
  --mobile-nav-height:60px;
}
*{box-sizing:border-box}
body{
  margin:0;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  background:var(--bg);
  color:var(--text);
}
button{font:inherit}
.portal-refresh-bar{display:flex;align-items:center;justify-content:flex-end;gap:12px;min-height:44px;margin-bottom:14px}
.portal-refresh-button{min-height:42px;padding:0 17px;border:1px solid var(--navy);border-radius:10px;background:var(--navy);color:#fff;font-weight:800;cursor:pointer}
.portal-refresh-button:hover{background:var(--navy-2)}.portal-refresh-button:disabled{cursor:wait;opacity:.65}
.portal-refresh-message{color:var(--green);font-size:13px;font-weight:750}.portal-refresh-message:not(:empty){padding:8px 10px;border-radius:8px;background:var(--green-soft)}
.portal-refresh-message.error{color:var(--red);background:var(--red-soft)}
.app{
  min-height:100vh;
  display:grid;
  grid-template-columns:250px minmax(0,1fr);
}

/* SIDEBAR */
.sidebar{
  min-height:100vh;
  background:var(--navy);
  color:#fff;
  padding:24px 16px;
  display:flex;
  flex-direction:column;
}
.brand{
  padding:4px 12px 22px;
  border-bottom:1px solid rgba(255,255,255,.16);
}
.brand-title{
  margin:0;
  font-size:27px;
  font-weight:850;
  letter-spacing:-.04em;
}
.brand-sub{
  margin-top:10px;
  color:rgba(255,255,255,.78);
  font-size:14px;
}
.nav{
  display:grid;
  gap:5px;
  margin-top:22px;
}
.nav button{
  position:relative;
  display:flex;
  align-items:center;
  gap:12px;
  width:100%;
  border:0;
  border-radius:12px;
  background:transparent;
  color:#fff;
  padding:12px 13px;
  text-align:left;
  cursor:pointer;
  font-size:15px;
}
.nav button:hover{background:rgba(255,255,255,.08)}
.nav button.active{
  background:#fff;
  color:var(--navy);
  font-weight:800;
}
.nav button.active:before{
  content:"";
  position:absolute;
  left:0;
  top:11px;
  bottom:11px;
  width:4px;
  border-radius:0 4px 4px 0;
  background:var(--navy-3);
}
.nav-icon{
  width:24px;
  height:24px;
  display:grid;
  place-items:center;
}
.nav-icon svg{
  width:20px;
  height:20px;
  fill:none;
  stroke:currentColor;
  stroke-width:2;
  stroke-linecap:round;
  stroke-linejoin:round;
}
.sidebar-footer{
  margin-top:auto;
  padding:18px 12px 4px;
  border-top:1px solid rgba(255,255,255,.16);
  color:rgba(255,255,255,.72);
  font-size:12px;
  line-height:1.5;
}

/* LAYOUT */
.content{min-width:0}
.workspace{padding:26px 30px 38px}
.screen{display:none}
.screen.active{display:block}
.page-head{margin-bottom:18px;padding-top:4px;overflow:visible}
.kicker{
  color:var(--navy-3);
  font-weight:850;
  font-size:11px;
  letter-spacing:.08em;
  text-transform:uppercase;
  margin-bottom:7px;
}
.page-head h1{
  margin:0 0 6px;
  font-size:32px;
  line-height:1.08;
  letter-spacing:-.035em;
}
.page-head p{
  margin:0;
  max-width:880px;
  color:var(--muted);
  font-size:14px;
  line-height:1.5;
}
.panel{
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:var(--radius);
  box-shadow:var(--shadow);
}

/* SUMMARY */
.summary-grid{
  display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  gap:14px;
  margin-bottom:16px;
}
.summary-card{
  appearance:none;
  width:100%;
  border:1px solid var(--line);
  background:#fff;
  border-radius:var(--radius);
  padding:17px 18px;
  text-align:left;
  box-shadow:var(--shadow);
  cursor:pointer;
  transition:.12s ease;
}
.summary-card:hover{border-color:#b9c7da;transform:translateY(-1px)}
.summary-card.active{
  border-color:var(--navy-3);
  box-shadow:0 0 0 2px rgba(51,89,143,.10);
}
.summary-label{
  font-size:13px;
  font-weight:800;
  color:#4c5d73;
}
.summary-number{
  margin:10px 0 5px;
  font-size:36px;
  line-height:1;
  font-weight:900;
  color:var(--navy);
}
.summary-note{
  color:var(--muted);
  font-size:12px;
  line-height:1.4;
}
.filter-state{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  padding:16px 18px 12px;
  border-bottom:1px solid var(--line);
}
.filter-state h2{
  margin:0;
  font-size:18px;
}
.filter-state p{
  margin:4px 0 0;
  color:var(--muted);
  font-size:12px;
}
.clear-filter{
  border:1px solid var(--line);
  background:#fff;
  color:var(--navy);
  border-radius:10px;
  padding:8px 10px;
  font-size:12px;
  font-weight:750;
  cursor:pointer;
}
.task-list{padding:8px 10px}
.task{
  display:grid;
  grid-template-columns:minmax(0,1.4fr) minmax(220px,.9fr) 120px;
  gap:14px;
  align-items:center;
  padding:13px 12px;
  border:1px solid transparent;
  border-radius:12px;
  cursor:pointer;
}
.task:hover{
  background:#fafbfd;
  border-color:#dbe3ed;
}
.task + .task{margin-top:3px}
.task-device{
  font-size:15px;
  font-weight:850;
  margin-bottom:4px;
}
.task-meta,
.task-current-label,
.task-date{
  color:var(--muted);
  font-size:12px;
  line-height:1.4;
}
.task-current{
  font-size:14px;
  font-weight:800;
  margin-top:2px;
}
.task-side{
  text-align:right;
}
.task-type{
  display:inline-block;
  padding:6px 8px;
  border-radius:999px;
  background:var(--blue-soft);
  color:var(--navy-3);
  font-size:11px;
  font-weight:800;
  margin-bottom:6px;
}
.task-type.action{background:var(--red-soft);color:var(--red)}
.task-type.repair{background:var(--amber-soft);color:var(--amber)}
.task-type.inspection{background:var(--green-soft);color:var(--green)}
.history-row{
  border-top:1px solid var(--line);
  padding:14px 18px 18px;
}
.history-btn{
  border:0;
  background:var(--navy);
  color:#fff;
  border-radius:10px;
  padding:10px 13px;
  font-size:12px;
  font-weight:800;
  cursor:pointer;
}

/* DEVICES */
.two-col{
  display:grid;
  grid-template-columns:300px minmax(0,1fr);
  gap:16px;
  align-items:start;
}
.list-head{
  padding:15px 16px 12px;
  border-bottom:1px solid var(--line);
}
.list-head h2{margin:0;font-size:16px}
.list-head p{margin:5px 0 0;color:var(--muted);font-size:12px;line-height:1.4}
.list{padding:7px}
.list-item{
  width:100%;
  border:1px solid transparent;
  background:#fff;
  border-radius:11px;
  padding:11px;
  text-align:left;
  cursor:pointer;
}
.list-item + .list-item{margin-top:4px}
.list-item:hover{background:#fafbfd}
.list-item.active{background:#f7f9fd;border-color:#cbd7e7}
.list-item b{display:block;font-size:14px}
.list-item span{display:block;margin-top:3px;color:var(--muted);font-size:12px}
.detail{padding:17px}
.empty{
  border:1px dashed #c9d5e4;
  background:var(--soft);
  color:var(--muted);
  border-radius:12px;
  padding:14px;
  font-size:13px;
}
.device-hero,
.case-hero{
  border:1px solid var(--line);
  border-radius:13px;
  background:#fff;
  padding:16px;
}
.device-hero-top,
.case-hero-top{
  display:flex;
  justify-content:space-between;
  gap:16px;
  align-items:flex-start;
}
.device-hero h2,
.case-hero h2{
  margin:0;
  font-size:23px;
  letter-spacing:-.025em;
}
.device-sub,
.case-sub{margin-top:4px;color:var(--muted);font-size:13px}
.status-box{
  min-width:190px;
  background:var(--green-soft);
  border-radius:11px;
  padding:12px;
}
.status-box label{
  display:block;
  color:#64746f;
  font-size:10px;
  font-weight:850;
  letter-spacing:.05em;
  margin-bottom:5px;
}
.status-box strong{
  display:block;
  color:var(--green);
  font-size:16px;
}
.meta-grid{
  display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  gap:9px;
  margin-top:14px;
}
.meta{
  background:var(--soft);
  border-radius:10px;
  padding:10px;
}
.meta label{
  display:block;
  color:var(--muted);
  font-size:10px;
  text-transform:uppercase;
  letter-spacing:.04em;
  margin-bottom:4px;
}
.meta strong{font-size:12px}
.tabs{
  display:flex;
  gap:18px;
  border-bottom:1px solid var(--line);
  margin-top:14px;
  overflow:auto;
}
.tabs button{
  border:0;
  background:transparent;
  padding:11px 0;
  color:var(--muted);
  font-size:12px;
  font-weight:750;
  cursor:pointer;
  border-bottom:2px solid transparent;
  white-space:nowrap;
}
.tabs button.active{color:var(--navy);border-bottom-color:var(--navy-3)}
.section{
  padding:14px 0;
  border-bottom:1px solid var(--line);
}
.section:last-child{border-bottom:0}
.section h3{margin:0 0 10px;font-size:14px}
.mini-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:9px;
}
.mini{
  border:1px solid var(--line);
  border-radius:10px;
  padding:10px;
  background:#fff;
}
.mini b{display:block;font-size:12px;margin-bottom:3px}
.mini span{color:var(--muted);font-size:11px;line-height:1.4}
.back{
  border:0;
  background:transparent;
  color:var(--navy-3);
  padding:0;
  margin-bottom:11px;
  font-size:12px;
  font-weight:800;
  cursor:pointer;
}

/* CASE CARD */
.case-header-line{
  display:flex;
  align-items:center;
  gap:8px;
  margin-bottom:10px;
}
.case-kind{
  display:inline-flex;
  padding:5px 8px;
  border-radius:999px;
  background:var(--blue-soft);
  color:var(--navy-3);
  font-size:10px;
  font-weight:850;
}
.case-device-link{
  border:0;
  background:transparent;
  color:var(--navy-3);
  padding:0;
  font-size:12px;
  font-weight:800;
  cursor:pointer;
}
.timeline{
  display:grid;
  gap:10px;
}
.timeline-row{
  display:grid;
  grid-template-columns:9px minmax(0,1fr) 130px;
  gap:10px;
  align-items:start;
}
.dot{
  width:8px;
  height:8px;
  border-radius:50%;
  background:var(--navy-3);
  margin-top:5px;
}
.timeline-row b{
  display:block;
  font-size:12px;
  margin-bottom:2px;
}
.timeline-row p{
  margin:0;
  font-size:12px;
  line-height:1.45;
}
.timeline-row time{
  color:var(--muted);
  font-size:11px;
  text-align:right;
}

/* SIMPLE SECTIONS */
.simple-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:10px;
}
.simple-card{
  border:1px solid var(--line);
  background:#fff;
  border-radius:12px;
  padding:12px;
}
.simple-card b{display:block;font-size:13px;margin-bottom:4px}
.simple-card span{color:var(--muted);font-size:12px}
.bottom-history{
  margin-top:12px;
}

/* MODAL */
.modal{
  position:fixed;
  inset:0;
  display:none;
  align-items:center;
  justify-content:center;
  padding:18px;
  background:rgba(20,33,55,.5);
  z-index:50;
}
.modal.show{display:flex}
.modal-card{
  width:min(460px,100%);
  background:#fff;
  border-radius:18px;
  border:1px solid var(--line);
  box-shadow:0 24px 50px rgba(18,38,63,.2);
  padding:20px;
}
.modal-card h2{margin:0 0 8px;font-size:22px}
.modal-card p{margin:0;color:var(--muted);font-size:13px;line-height:1.55}
.modal-actions{
  display:flex;
  justify-content:flex-end;
  gap:8px;
  margin-top:18px;
}
.modal-actions button{
  border-radius:10px;
  padding:9px 12px;
  font-size:12px;
  font-weight:800;
  cursor:pointer;
}
.btn-secondary{background:#fff;border:1px solid var(--line);color:var(--text)}
.btn-primary{background:var(--navy);border:1px solid var(--navy);color:#fff}

@media(max-width:1100px){
  .app{grid-template-columns:220px minmax(0,1fr)}
  .summary-grid{grid-template-columns:1fr 1fr}
  .task{grid-template-columns:1fr}
  .task-side{text-align:left}
}
@media(max-width:768px){
  .app{display:block}
  .sidebar{min-height:auto}
  .workspace{padding:20px 14px 30px}
  .summary-grid{grid-template-columns:1fr}
  .two-col{grid-template-columns:1fr}
  .device-hero-top,.case-hero-top{display:block}
  .status-box{margin-top:12px}
  .meta-grid{grid-template-columns:1fr 1fr}
  .simple-grid,.mini-grid{grid-template-columns:1fr}
}

/* === v6 UX refinements === */
.task-current-label{margin-bottom:5px}
.status-tag{
  display:inline-flex;
  align-items:center;
  width:max-content;
  max-width:100%;
  padding:6px 9px;
  border-radius:999px;
  font-size:12px;
  line-height:1.2;
  font-weight:850;
}
.status-tag.red{background:var(--red-soft);color:var(--red)}
.status-tag.amber{background:var(--amber-soft);color:var(--amber)}
.status-tag.green{background:var(--green-soft);color:var(--green)}
.status-tag.blue{background:var(--blue-soft);color:var(--navy-3)}
.status-tag.neutral{background:#eef2f6;color:#526173}

/* Typ rekordu ma być tylko delikatnym oznaczeniem. */
.task-type,
.task-type.action,
.task-type.repair,
.task-type.inspection{
  background:#f4f6f9;
  color:#69788d;
  border:1px solid #e0e6ed;
  font-weight:750;
}

.case-status-line{
  display:flex;
  align-items:center;
  flex-wrap:wrap;
  gap:8px;
  margin-top:10px;
  font-size:13px;
  color:var(--muted);
}
.case-status-line strong{color:var(--text)}
.case-hero-top{display:block}
.case-hero .status-box{display:none}

.media-section{
  margin-top:12px;
  padding-top:12px;
  border-top:1px solid var(--line);
}
.media-section h3{
  margin:0 0 10px;
  font-size:13px;
}
.photo-gallery{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,150px));
  gap:10px;
}
.photo-thumb{
  border:1px solid var(--line);
  background:#fff;
  border-radius:11px;
  padding:7px;
  cursor:pointer;
  text-align:left;
}
.photo-thumb:hover{border-color:#b8c7da}
.photo-art{
  height:82px;
  border-radius:8px;
  position:relative;
  overflow:hidden;
  background:linear-gradient(145deg,#e8edf3,#cfd8e4);
}
.photo-art:before,
.photo-art:after{
  content:"";
  position:absolute;
}
.photo-art.cable:before{
  left:-12px;top:36px;width:100px;height:8px;
  background:#6d7682;border-radius:999px;transform:rotate(-6deg);
}
.photo-art.cable:after{
  right:12px;top:24px;width:54px;height:33px;
  border:7px solid #8a5d3b;border-left:0;border-radius:0 18px 18px 0;
  transform:rotate(8deg);
}
.photo-art.device:before{
  width:86px;height:48px;left:28px;top:16px;
  background:#f9fafb;border:1px solid #9aa8b7;border-radius:7px;
  box-shadow:0 5px 10px rgba(20,35,55,.12);
}
.photo-art.device:after{
  width:54px;height:7px;left:44px;top:32px;
  background:#8e9ba9;border-radius:2px;
  box-shadow:0 13px 0 #c2cad3;
}
.photo-caption{
  display:block;
  margin-top:6px;
  color:var(--text);
  font-size:11px;
  font-weight:750;
}
.document-list{display:grid;gap:7px}
.document-link{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  width:100%;
  border:1px solid var(--line);
  background:#fff;
  color:var(--text);
  border-radius:10px;
  padding:10px 11px;
  text-decoration:none;
  cursor:pointer;
}
.document-link:hover{border-color:#b8c7da;background:#fbfcfe}
.document-name{
  display:flex;
  align-items:center;
  gap:9px;
  min-width:0;
}
.doc-icon{
  width:28px;height:28px;
  border-radius:8px;
  display:grid;place-items:center;
  background:#eef2f7;
  color:var(--navy);
  font-size:13px;
  font-weight:900;
  flex:0 0 28px;
}
.document-name b{font-size:12px}
.document-name span{display:block;color:var(--muted);font-size:10px;margin-top:2px}
.document-open{color:var(--navy-3);font-size:11px;font-weight:800;white-space:nowrap}

.case-history{
  position:relative;
  display:grid;
  gap:0;
}
.case-history-item{
  display:grid;
  grid-template-columns:120px 22px minmax(0,1fr);
  gap:10px;
  align-items:stretch;
}
.case-history-date{
  color:var(--muted);
  font-size:11px;
  text-align:right;
  padding:10px 0 16px;
  line-height:1.35;
}
.case-history-rail{
  position:relative;
  display:flex;
  justify-content:center;
}
.case-history-rail:before{
  content:"";
  position:absolute;
  top:0;bottom:0;
  width:2px;
  background:#dbe3ec;
}
.case-history-item:first-child .case-history-rail:before{top:14px}
.case-history-item:last-child .case-history-rail:before{bottom:calc(100% - 15px)}
.case-history-dot{
  position:relative;
  z-index:1;
  width:10px;height:10px;
  margin-top:13px;
  border-radius:50%;
  background:var(--navy-3);
  box-shadow:0 0 0 4px #edf2f8;
}
.case-history-card{
  margin:4px 0 10px;
  padding:10px 12px;
  border:1px solid var(--line);
  background:#fff;
  border-radius:10px;
}
.case-history-card b{
  display:block;
  font-size:12px;
  margin-bottom:3px;
}
.case-history-card p{
  margin:0;
  font-size:12px;
  line-height:1.45;
  color:#3f4e63;
}
.photo-lightbox-content{
  width:min(720px,100%);
}
.photo-lightbox-art{
  height:min(60vh,480px);
  border-radius:14px;
  background:linear-gradient(145deg,#e8edf3,#cfd8e4);
  position:relative;
  overflow:hidden;
  margin-top:14px;
}
.photo-lightbox-art.cable:before{
  content:"";position:absolute;left:6%;top:48%;width:56%;height:18px;
  background:#6d7682;border-radius:999px;transform:rotate(-7deg);
}
.photo-lightbox-art.cable:after{
  content:"";position:absolute;right:12%;top:34%;width:25%;height:25%;
  border:16px solid #8a5d3b;border-left:0;border-radius:0 50px 50px 0;transform:rotate(8deg);
}
.photo-lightbox-art.device:before{
  content:"";position:absolute;width:56%;height:42%;left:22%;top:25%;
  background:#f9fafb;border:2px solid #9aa8b7;border-radius:16px;
  box-shadow:0 15px 30px rgba(20,35,55,.16);
}
.photo-lightbox-art.device:after{
  content:"";position:absolute;width:35%;height:16px;left:32%;top:40%;
  background:#8e9ba9;border-radius:4px;box-shadow:0 38px 0 #c2cad3;
}
@media(max-width:650px){
  .photo-gallery{grid-template-columns:1fr 1fr}
  .case-history-item{grid-template-columns:78px 18px minmax(0,1fr)}
}

/* Real private assets (10C). */
.photo-thumb-image{
  display:block;
  width:100%;
  aspect-ratio:4/3;
  object-fit:cover;
  border-radius:8px;
  background:#eef2f7;
}
.photo-lightbox{padding:12px;background:rgba(8,18,32,.88)}
.photo-lightbox-content{
  position:relative;
  display:flex;
  flex-direction:column;
  align-items:center;
  max-height:calc(100vh - 24px);
}
.photo-lightbox-content img{
  display:block;
  max-width:100%;
  max-height:calc(100vh - 90px);
  width:auto;
  height:auto;
  object-fit:contain;
  border-radius:10px;
}
.photo-lightbox-close{
  position:absolute;
  z-index:2;
  top:6px;
  right:6px;
  width:44px;
  height:44px;
  border:0;
  border-radius:50%;
  background:rgba(8,18,32,.78);
  color:#fff;
  font-size:30px;
  line-height:1;
  cursor:pointer;
}
.photo-lightbox-caption{color:#fff;font-size:12px;margin-top:8px}
body.lightbox-open{overflow:hidden}
.documents-groups{display:grid;gap:18px}
.documents-group h2{font-size:15px;margin:0 0 9px}
.documents-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.document-card{min-width:0;border:1px solid var(--line);border-radius:12px;padding:10px;background:#fff}
.document-card .document-link{border:0;padding:0}
.document-context{display:grid;gap:2px;margin-top:9px;padding-top:8px;border-top:1px solid var(--line)}
.document-context b{font-size:12px}
.document-context span{font-size:10px;color:var(--muted)}
.document-tools{grid-template-columns:minmax(0,1fr)}
@media(max-width:650px){
  .documents-cards{grid-template-columns:1fr}
  .photo-gallery{grid-template-columns:repeat(2,minmax(0,1fr))}
  .photo-thumb{min-width:0}
}


/* === v7 additions === */
.device-inspection{
  margin-top:7px;
  display:flex;
  align-items:center;
  flex-wrap:wrap;
  gap:6px;
}
.inspection-state{
  display:inline-flex;
  align-items:center;
  gap:5px;
  padding:5px 8px;
  border-radius:999px;
  font-size:10px;
  font-weight:800;
  border:1px solid transparent;
}
.inspection-state.ok{background:var(--green-soft);color:var(--green);border-color:#d2e7df}
.inspection-state.soon{background:var(--amber-soft);color:var(--amber);border-color:#eadcaf}
.inspection-state.overdue{background:var(--red-soft);color:var(--red);border-color:#edd0d0}
.inspection-date{font-size:10px;color:var(--muted)}
.case-list{display:grid;gap:8px}
.case-link{
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  gap:12px;
  align-items:center;
  width:100%;
  border:1px solid var(--line);
  border-radius:10px;
  background:#fff;
  padding:10px 11px;
  text-align:left;
  cursor:pointer;
}
.case-link:hover{background:#fbfcfe;border-color:#b9c7da}
.case-link b{display:block;font-size:12px;margin-bottom:3px}
.case-link span{display:block;color:var(--muted);font-size:11px}
.case-link .arrow{color:var(--navy-3);font-size:16px;font-weight:900}
.device-card-inspection{
  margin-top:12px;
  border-top:1px solid var(--line);
  padding-top:10px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:8px;
}
.device-card-inspection .label{font-size:11px;color:var(--muted)}
.device-card-inspection strong{font-size:11px}

.repair-list{display:grid;gap:8px}
.repair-row{
  display:grid;
  grid-template-columns:minmax(0,1.2fr) minmax(160px,.7fr) 120px;
  gap:12px;
  align-items:center;
  padding:12px;
  border:1px solid transparent;
  border-radius:12px;
  cursor:pointer;
}
.repair-row:hover{background:#fafbfd;border-color:#dbe3ed}
.repair-row + .repair-row{margin-top:3px}
.repair-row b{font-size:14px}
.repair-row .sub{display:block;color:var(--muted);font-size:11px;margin-top:3px}
.repair-row .status{font-size:12px;font-weight:800}
.repair-row .date{text-align:right;color:var(--muted);font-size:11px}

.document-tools{
  display:grid;
  grid-template-columns:minmax(0,1fr) 210px;
  gap:10px;
  margin-bottom:12px;
}
.document-tools input,
.document-tools select{
  width:100%;
  border:1px solid var(--line);
  border-radius:10px;
  background:#fff;
  color:var(--text);
  padding:10px 11px;
  font:inherit;
  font-size:12px;
  outline:none;
}
.document-tools input:focus,
.document-tools select:focus{
  border-color:#aebfd5;
  box-shadow:0 0 0 3px rgba(51,89,143,.08);
}
.documents-table{
  width:100%;
  border-collapse:collapse;
}
.documents-table th,
.documents-table td{
  padding:10px 9px;
  border-bottom:1px solid var(--line);
  text-align:left;
  vertical-align:middle;
  font-size:11px;
}
.documents-table th{
  color:var(--muted);
  text-transform:uppercase;
  letter-spacing:.04em;
  font-size:9px;
}
.documents-table tr:last-child td{border-bottom:0}
.documents-table tbody tr:hover{background:#fafbfd}
.document-file{
  display:inline-flex;
  align-items:center;
  gap:7px;
  color:var(--navy-3);
  font-weight:800;
  text-decoration:none;
}
.document-file:hover{text-decoration:underline}
.pdf-badge{
  width:24px;height:24px;
  border-radius:7px;
  background:#eef2f7;
  color:var(--navy);
  display:grid;
  place-items:center;
  font-size:9px;
  font-weight:900;
}
.no-results{
  display:none;
  padding:16px;
  text-align:center;
  color:var(--muted);
  font-size:12px;
}
@media(max-width:800px){
  .repair-row{grid-template-columns:1fr}
  .repair-row .date{text-align:left}
  .document-tools{grid-template-columns:1fr}
  .documents-table{display:block;overflow-x:auto}
}


/* === v8 search + list unification === */
.search-bar{
  padding:12px 14px;
  border-bottom:1px solid var(--line);
}
.search-bar input{
  width:100%;
  border:1px solid var(--line);
  border-radius:10px;
  background:#fff;
  color:var(--text);
  padding:10px 11px;
  font:inherit;
  font-size:12px;
  outline:none;
}
.search-bar input:focus{
  border-color:#aebfd5;
  box-shadow:0 0 0 3px rgba(51,89,143,.08);
}
.list-row{
  display:grid;
  grid-template-columns:minmax(0,1.35fr) minmax(160px,.75fr) 130px;
  gap:12px;
  align-items:center;
  padding:12px;
  border:1px solid transparent;
  border-radius:12px;
  cursor:pointer;
}
.list-row:hover{background:#fafbfd;border-color:#dbe3ed}
.list-row + .list-row{margin-top:3px}
.list-row-main b{display:block;font-size:14px}
.list-row-main span{display:block;color:var(--muted);font-size:11px;margin-top:3px;line-height:1.4}
.list-row-mid{font-size:12px}
.list-row-mid b{display:block;margin-bottom:4px}
.list-row-mid span{color:var(--muted);font-size:11px}
.list-row-side{text-align:right}
.list-row-side .date{color:var(--muted);font-size:11px;margin-top:5px}
.device-list-status{
  display:flex;
  flex-direction:column;
  gap:5px;
  align-items:flex-start;
}
.device-row-search{grid-template-columns:minmax(0,1.35fr) minmax(190px,.65fr)}
.device-card-screen .page-head{margin-bottom:14px}
@media(max-width:800px){
  .list-row{grid-template-columns:1fr}
  .list-row-side{text-align:left}
}


/* === v9 service identity + case information consistency === */
.summary-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
.service-source{
  margin-top:13px;
  padding-top:12px;
  border-top:1px solid rgba(255,255,255,.12);
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  font-size:12px;
}
.service-source span{color:rgba(255,255,255,.64)}
.service-source strong{color:#fff;font-size:13px}
.task-case-meta{
  display:flex;
  align-items:center;
  flex-wrap:wrap;
  gap:6px 12px;
  margin-top:7px;
  color:var(--muted);
  font-size:11px;
  line-height:1.4;
}
.task-case-meta strong{color:var(--navy);font-size:11px}
.case-type-badge{
  display:inline-flex;
  margin-bottom:7px;
  padding:4px 7px;
  border:1px solid #d8e1ec;
  border-radius:999px;
  background:#f4f7fb;
  color:var(--navy-3);
  font-size:9px;
  font-weight:850;
  letter-spacing:.05em;
  text-transform:uppercase;
}
.task-valid-until{
  display:grid;
  gap:3px;
  margin-top:10px;
  padding-top:8px;
  border-top:1px solid var(--line);
}
.task-valid-until span{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.04em}
.task-valid-until strong{font-size:11px;color:#4a596d}
.task-date-label{
  color:#526173;
  font-size:10px;
  font-weight:850;
  text-transform:uppercase;
  letter-spacing:.04em;
  margin-bottom:4px;
}
.date-block{text-align:right}
.date-block span{
  display:block;
  color:var(--muted);
  font-size:10px;
  text-transform:uppercase;
  letter-spacing:.04em;
  margin-bottom:4px;
}
.date-block strong{font-size:11px;color:#4a596d}
.inspection-dates{
  display:grid;
  gap:7px;
  text-align:right;
  font-size:11px;
  color:#4a596d;
}
.inspection-dates span{display:block}
.inspection-dates b{
  display:block;
  margin-bottom:2px;
  color:var(--muted);
  font-size:9px;
  text-transform:uppercase;
  letter-spacing:.04em;
}
.case-header-line{flex-wrap:wrap}
.case-service-inline{
  padding:5px 8px;
  border-radius:999px;
  background:#f4f6f9;
  border:1px solid #e0e6ed;
  color:var(--muted);
  font-size:10px;
}
.case-service-inline strong{color:var(--navy)}
.case-main-status .status-tag{font-size:13px}
.case-status-line{display:none}
.case-meta-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
.history-order-note{margin:-4px 0 12px;color:var(--muted);font-size:11px}
.case-screen-link{
  margin-top:10px;
}
.case-screen-link button{
  border:0;
  background:transparent;
  color:var(--navy-3);
  padding:0;
  font-size:13px;
  font-weight:800;
  cursor:pointer;
}
.case-screen-link button:hover{text-decoration:underline}
.task,
.repair-row,
.list-row{align-items:center}
.task{grid-template-columns:minmax(0,1.3fr) minmax(230px,.95fr) 150px}
.repair-row{grid-template-columns:minmax(0,1.15fr) minmax(220px,.8fr) 145px}
.list-row{grid-template-columns:minmax(0,1.2fr) minmax(220px,.8fr) 180px}
.task-current,
.inline-status .status-tag,
.task-side .status-tag,
.list-row-mid .status-tag,
.repair-row .status-tag,
.list-row-side .status-tag{
  white-space:nowrap;
}
.status-tag{
  max-width:none;
  white-space:nowrap;
}
.device-hero-top,
.case-hero-top{
  display:block;
}
.hero-title-line{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:18px;
  flex-wrap:wrap;
}
.hero-title-line h2{margin:0}
.inline-status{
  display:flex;
  flex-direction:column;
  align-items:flex-start;
  gap:6px;
  min-width:max-content;
}
.inline-status label{
  color:var(--muted);
  font-size:11px;
  font-weight:850;
  letter-spacing:.05em;
}
.inline-status .status-tag{
  display:inline-flex;
  width:max-content;
}
.case-device-link{margin-left:0}
@media(max-width:800px){
  .summary-grid{grid-template-columns:1fr}
  .task,.repair-row,.list-row{grid-template-columns:1fr}
  .case-meta-grid{grid-template-columns:1fr 1fr}
  .date-block,.inspection-dates{text-align:left}
}
@media(max-width:520px){
  .case-meta-grid{grid-template-columns:1fr}
  .task-case-meta{display:grid}
}

.portal-pagination{display:flex;align-items:center;justify-content:center;gap:12px;padding:15px 18px;border-top:1px solid var(--line)}
.portal-loading{color:var(--muted);font-size:13px}
.portal-error{color:var(--red);font-size:13px}
.mobile-header,.mobile-nav{display:none}
.upgrade-teaser{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:18px 0;padding:20px 22px;border:1px solid #cdd9ee;border-radius:14px;background:#f5f8ff;color:var(--text)}
.upgrade-teaser strong{font-size:17px}.upgrade-teaser p{margin:5px 0 0;color:var(--muted);line-height:1.5}
.upgrade-teaser a,.upgrade-cta{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border:2px solid var(--navy);border-radius:10px;background:var(--navy);color:#fff;text-decoration:none;font-weight:800;white-space:nowrap;opacity:1;transition:background-color .15s ease,border-color .15s ease,box-shadow .15s ease}
.upgrade-teaser a:visited,.upgrade-cta:visited{color:#fff}
.upgrade-teaser a:hover,.upgrade-cta:hover{border-color:var(--navy-2);background:var(--navy-2);color:#fff}
.upgrade-teaser a:focus-visible,.upgrade-cta:focus-visible{outline:3px solid #f0b429;outline-offset:3px;box-shadow:0 0 0 2px #fff}
.upgrade-teaser a:active,.upgrade-cta:active{border-color:#172f55;background:#172f55;color:#fff}
.communication-empty{display:grid;grid-template-columns:auto minmax(0,1fr);gap:18px;margin:18px;padding:24px;border:1px solid #cdd9ee;border-radius:14px;background:#f5f8ff}
.communication-empty-icon{display:grid;place-items:center;width:48px;height:48px;border-radius:12px;background:var(--navy);color:#fff}.communication-empty-icon svg{width:25px;height:25px;fill:none;stroke:currentColor;stroke-width:1.8}
.communication-empty h2{margin:0 0 7px;font-size:21px}.communication-empty p{margin:0;color:var(--muted);line-height:1.5}.communication-empty ul{display:flex;flex-wrap:wrap;gap:10px;margin:17px 0;padding:0;list-style:none}.communication-empty li{display:flex;align-items:baseline;gap:5px;padding:8px 11px;border:1px solid var(--line);border-radius:9px;background:#fff}.communication-empty li strong{font-size:18px;color:var(--navy)}.communication-empty li span{color:var(--muted);font-size:13px}
.case-detail-head{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:4px 2px 18px;border-bottom:1px solid var(--line)}
.case-detail-head h2{margin:3px 0 0;font-size:30px;color:var(--navy)}.case-detail-head p{margin:7px 0 0;color:var(--muted);font-size:13px}.case-detail-kicker,.case-detail-eyebrow{color:var(--muted);font-size:11px;font-weight:850;letter-spacing:.1em;text-transform:uppercase}
.case-detail-head-meta{display:flex;align-items:center;gap:18px;text-align:right}.case-detail-head-meta .status-tag{padding:8px 13px;border-radius:999px;font-size:13px}.case-detail-subtitle{font-size:14px!important}
.case-detail-hero{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(260px,.8fr);margin-top:20px;overflow:hidden;border:1px solid var(--line);border-radius:18px;background:#fff}.case-detail-device,.case-detail-result{padding:28px}.case-detail-device h3{margin:7px 0 19px;font-size:26px;color:var(--navy)}.case-detail-result{display:flex;flex-direction:column;justify-content:center;background:#eef2f6}.case-detail-result-label{font-size:23px;font-weight:900}.case-detail-result p{margin:10px 0 0;line-height:1.55}.tone-green .case-detail-result{background:#e9f7ef;color:#176a44}.tone-amber .case-detail-result{background:#fff4dd;color:#925d00}.tone-red .case-detail-result{background:#fdecec;color:#a22d32}.tone-blue .case-detail-result{background:#eaf2ff;color:#214f91}.tone-slate .case-detail-result{background:#edf1f5;color:#3f4c5f}
.case-detail-hero{grid-template-columns:118px minmax(0,1fr) 300px;border-radius:7px}.case-detail-device-icon{display:grid;place-items:center;width:100px;height:100px;margin:13px 0 13px 16px;border-radius:8px;background:#f1f6fc;color:#173f78;font-size:44px}.case-detail-device{align-self:center;padding:13px 16px}.case-detail-device h3{margin:0 0 5px;font-size:25px}.case-detail-device-sub{margin:0 0 5px;color:#516d99;font-size:16px}.case-detail-device-id{margin:0;color:#58709a;font-size:14px}.case-detail-result{align-items:flex-end;padding:13px 16px;text-align:right;background:#fff!important}.case-detail-result-label{padding:10px 16px;border-radius:999px;background:#e9eef6;font-size:16px}.tone-green .case-detail-result-label{background:#e8f6e8;color:#177033}.tone-amber .case-detail-result-label{background:#fff0db;color:#b85500}.tone-red .case-detail-result-label{background:#ffe1e3;color:#b91520}.tone-blue .case-detail-result-label{background:#dfeeff;color:#0962cc}.case-detail-result p{max-width:290px;color:#64799d;font-size:13px}
.case-detail-pair{display:grid;grid-template-columns:minmax(125px,.45fr) minmax(0,1fr);gap:16px;padding:9px 0;border-bottom:1px solid rgba(95,111,133,.14)}.case-detail-pair:last-child{border-bottom:0}.case-detail-pair span{color:var(--muted);font-size:13px}.case-detail-pair strong{min-width:0;overflow-wrap:anywhere;color:var(--text)}
.case-detail-result-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.case-detail-summary{min-height:66px;padding:11px 13px;border-radius:6px;background:#f1f6fb}.case-detail-summary span{display:block;margin-bottom:5px;color:#6f83a5;font-size:11px;text-transform:uppercase}.case-detail-summary strong{color:#0b1d5a;font-size:16px}.case-detail-admission{display:grid;grid-template-columns:190px 1fr;gap:16px;margin-top:10px;padding:12px 14px;border-radius:7px;background:#f4f7fb}.case-detail-admission p{margin:0;color:#355171;line-height:1.5}.case-detail-device-data .case-detail-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.case-detail-device-data .case-detail-pair,.case-detail-location .case-detail-pair{display:block;min-height:61px;padding:10px 12px;border:0;border-radius:5px;background:#f1f6fb}.case-detail-device-data .case-detail-pair span,.case-detail-location .case-detail-pair span{display:block;margin-bottom:5px;font-size:11px;text-transform:uppercase}.case-detail-location .case-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.case-detail-media-grid{display:grid;grid-template-columns:1fr 1.03fr;gap:13px}.case-detail-media-grid .case-detail-section{height:calc(100% - 18px)}.case-detail-links-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.case-detail-link{justify-content:center!important;text-align:left}
.case-detail-section,.case-detail-related,.case-detail-rfid,.case-detail-callout,.case-detail-safe{margin-top:18px;padding:23px;border:1px solid var(--line);border-radius:16px;background:#fff}.case-detail-section h3,.case-detail-rfid h3,.case-detail-callout h3,.case-detail-safe h3{margin:0 0 15px;color:var(--navy);font-size:18px}.case-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:28px}.case-detail-related{display:flex;align-items:center;justify-content:space-between;gap:16px;background:#f7f9fc}.case-detail-related span{color:var(--muted);font-size:13px}.case-detail-related-action{border:0;background:transparent;color:var(--navy);font:inherit;font-weight:850;cursor:pointer}.case-detail-rfid{background:#f7f9fc}.case-detail-epc,.case-detail-link,.case-detail-action{min-height:44px;padding:0 15px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--navy);font:inherit;font-weight:800;cursor:pointer}.case-detail-action{margin-top:16px;border-color:var(--navy);background:var(--navy);color:#fff}.case-detail-epc{margin-top:8px}.case-detail-safe{border-color:#d7dde6;background:#f4f6f8}.case-detail-safe p,.case-detail-callout p{margin:0;color:var(--muted);line-height:1.55}.case-detail-callout{border-color:#cfdced;background:#f3f7fd}.case-detail-links{display:grid;gap:10px;margin-top:18px}.case-detail-links h3{margin:0 0 4px}.case-detail-link{display:flex;align-items:center;justify-content:flex-start;width:100%}.case-detail-hint{margin:13px 0 0;color:var(--muted);font-size:12px}.empty-media-title{display:block;margin-bottom:3px;color:var(--text)}
.feature-modal{position:fixed;z-index:100;inset:0;display:grid;place-items:center;padding:20px;background:rgba(14,26,45,.62)}.feature-modal-content{position:relative;width:min(520px,100%);padding:30px;border-radius:18px;background:#fff;box-shadow:0 24px 70px rgba(14,26,45,.3)}.feature-modal-content h2{margin:0 42px 12px 0;color:var(--navy);font-size:24px;line-height:1.25}.feature-modal-content p{margin:0;color:var(--muted);line-height:1.65}.feature-modal-content a{color:var(--navy);font-weight:850}.feature-modal-x{position:absolute;top:14px;right:14px;width:38px;height:38px;border:0;border-radius:50%;background:#eef2f7;color:var(--navy);font-size:25px;cursor:pointer}.feature-modal-close{min-width:110px;min-height:44px;margin-top:22px;border:0;border-radius:10px;background:var(--navy);color:#fff;font:inherit;font-weight:850;cursor:pointer}.feature-modal-open{overflow:hidden}
@media(max-width:768px){
  html,body{max-width:100%;overflow-x:hidden}
  .app{display:block;min-height:0}.sidebar{display:none!important}
  .mobile-header{position:sticky;z-index:20;top:0;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:58px;padding:8px 16px;background:#fff;border-bottom:1px solid var(--line)}
  .mobile-header div{display:grid;gap:1px}.mobile-header strong{font-size:21px;color:var(--navy)}.mobile-header span{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:750}.mobile-header small{color:var(--muted);font-size:11px}
  .mobile-nav{position:fixed;z-index:40;right:0;bottom:0;left:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));padding:4px 4px calc(4px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:#fff;box-shadow:0 -5px 18px rgba(20,35,60,.1)}
  .mobile-nav button{display:grid;place-items:center;gap:2px;min-width:0;min-height:52px;padding:4px 1px;border:0;border-radius:8px;background:transparent;color:#526075;font:inherit;font-size:10px;font-weight:750}
  .mobile-nav button.active{background:#eaf1ff;color:var(--navy)}.mobile-nav .nav-icon{display:grid;width:22px;height:22px}.mobile-nav svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8}
  .content{padding-bottom:calc(68px + env(safe-area-inset-bottom))}.workspace{width:100%;padding:18px 14px 24px}.page-head h1{font-size:clamp(26px,9vw,34px);line-height:1.08}.page-head p{max-width:100%;font-size:15px}.panel{max-width:100%}.summary-grid{grid-template-columns:1fr}.task,.repair-row,.list-row{grid-template-columns:1fr}.search-bar input,.document-tools input,.document-tools select{min-height:44px}.summary-card,.history-btn,.clear-filter,.back{min-height:44px}
  .portal-refresh-bar{align-items:stretch;flex-direction:column;margin-bottom:16px}.portal-refresh-button{width:100%}.portal-refresh-message{text-align:center}
  .upgrade-teaser{align-items:flex-start;flex-direction:column;padding:17px}.upgrade-teaser a{width:100%;white-space:normal;text-align:center}
  .communication-empty{grid-template-columns:1fr;margin:14px;padding:18px}.communication-empty .upgrade-cta{width:100%;white-space:normal;text-align:center}
  .case-detail-head{align-items:flex-start;flex-direction:column}.case-detail-head-meta{align-items:flex-start;flex-direction:column-reverse;text-align:left}.case-detail-head h2{font-size:26px}.case-detail-hero{grid-template-columns:72px minmax(0,1fr)}.case-detail-device-icon{width:58px;height:72px;margin:14px 0 14px 12px;font-size:28px}.case-detail-device{padding:18px 12px}.case-detail-device h3{font-size:21px}.case-detail-result{grid-column:1/-1;align-items:flex-start;padding:16px 18px;text-align:left;border-top:1px solid var(--line)}.case-detail-result-grid,.case-detail-device-data .case-detail-grid,.case-detail-location .case-detail-grid,.case-detail-media-grid,.case-detail-links-grid{grid-template-columns:1fr}.case-detail-admission{grid-template-columns:1fr}.case-detail-grid{grid-template-columns:1fr}.case-detail-related{align-items:flex-start;flex-direction:column}.case-detail-section,.case-detail-related,.case-detail-rfid,.case-detail-callout,.case-detail-safe{padding:18px}.case-detail-pair{grid-template-columns:1fr;gap:4px}.feature-modal{padding:14px}.feature-modal-content{padding:24px 20px}.feature-modal-content h2{font-size:21px}
}
/* Inspection detail — screenshot-aligned shared layout */
.nav button.active{background:linear-gradient(90deg,rgba(111,157,221,.42),rgba(111,157,221,.2));color:#fff;font-weight:750;box-shadow:inset 3px 0 #8fc0ff}
.nav button.active:before{display:none}
.workspace.case-detail-active{position:relative;width:100%;max-width:1210px;margin:0 auto;padding-top:22px}
.case-detail-screen>.page-head{display:none}
.case-detail-screen>.panel.detail{padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}
.case-detail-screen>.panel.detail>.back{display:none}
.case-detail-active .portal-refresh-button{display:inline-flex;align-items:center;justify-content:center;gap:9px;min-height:44px;padding:0 18px;border-color:#cbd7e7;background:#fff;color:#07145d;box-shadow:0 3px 10px rgba(31,47,73,.04)}
.portal-refresh-icon{display:inline-grid;place-items:center;flex:0 0 auto;width:20px;height:20px}.portal-refresh-icon svg{width:20px;height:20px;fill:none;stroke:#0d1895;stroke-width:2.3;stroke-linecap:round;stroke-linejoin:round}
.case-detail-active .portal-refresh-button:hover{border-color:#8ca5c7;background:#f8faff}
.case-detail-active .portal-refresh-message{position:absolute;top:50px;right:0;width:max-content;max-width:330px;padding:0!important;background:transparent!important;font-size:11px;font-weight:650;text-align:right}
.case-detail-head{min-height:94px;padding:0 2px 17px;border:0;align-items:flex-start}
.case-detail-head-copy{min-width:0}.case-detail-breadcrumb{display:flex;align-items:center;gap:12px;margin-bottom:11px;color:#001a72;font-size:13px}.case-detail-breadcrumb button{padding:0;border:0;background:transparent;color:#0d54bc;font:inherit;cursor:pointer}.case-detail-breadcrumb button:hover{text-decoration:underline}.case-detail-title-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.case-detail-title-row h1{margin:0;color:#06145d;font-size:30px;line-height:1.05;letter-spacing:-.035em}.case-detail-subtitle{margin:7px 0 0!important;color:#63779a!important;font-size:14px!important}.case-detail-head-meta{display:block;color:#63779a;text-align:right}.case-detail-head-meta p{margin:0;white-space:nowrap;font-size:12px}
.case-detail-status-pill{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:31px;padding:6px 13px;border-radius:999px;font-size:12px;font-weight:850;line-height:1;text-transform:uppercase;white-space:nowrap}.case-detail-status-pill .case-detail-icon{width:18px;height:18px}.case-detail-status-pill.is-large{min-width:190px;min-height:44px;padding:9px 18px;font-size:17px;text-transform:none}.case-detail-status-pill.is-success{background:#dff3e3;color:#09682b}.case-detail-status-pill.is-warning{background:#fff0d6;color:#b75200}.case-detail-status-pill.is-danger{background:#ffe0e3;color:#bf0718}.case-detail-status-pill.is-info{background:#dcecff;color:#0761cf}.case-detail-status-pill.is-neutral{background:#e7edf5;color:#425776}
.case-detail-icon{display:inline-grid;place-items:center;flex:0 0 auto;width:24px;height:24px;color:currentColor}.case-detail-icon svg{width:100%;height:100%;stroke-linecap:round;stroke-linejoin:round}.case-detail-icon.is-stroke svg{fill:none;stroke:currentColor;stroke-width:2}.case-detail-icon.is-fill svg{fill:currentColor;stroke:currentColor;stroke-width:1.5}
.case-detail-hero{display:grid;grid-template-columns:116px minmax(0,1fr) minmax(280px,34%);min-height:136px;margin:0;border:1px solid #d6e0ec;border-radius:7px;background:#fff;overflow:hidden;box-shadow:0 4px 14px rgba(21,45,82,.035)}
.case-detail-device-icon{display:grid;place-items:center;width:96px;height:96px;margin:19px 0 19px 18px;border-radius:7px;background:#f0f5fb;color:#0a397f}.case-detail-device-icon .case-detail-icon{width:55px;height:55px}.case-detail-device{align-self:center;padding:17px 20px}.case-detail-device h2{margin:0 0 7px;color:#06145d;font-size:25px;line-height:1.12;letter-spacing:-.025em}.case-detail-device-sub,.case-detail-device-id{margin:0;color:#536f9d;font-size:14px;line-height:1.5}.case-detail-device-id{margin-top:4px}.case-detail-result{display:flex;align-items:flex-end;justify-content:center;flex-direction:column;padding:18px 20px;text-align:right;background:#fff!important}.case-detail-result p{max-width:280px;margin:10px 0 0;color:#667ca1;font-size:12px;line-height:1.45}
.case-detail-section{margin-top:14px;padding:17px 18px;border:1px solid #d6e0ec;border-radius:7px;background:#fff;box-shadow:0 4px 14px rgba(21,45,82,.03)}.case-detail-section-head{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:13px}.case-detail-section-title{display:flex;align-items:center;gap:10px;min-width:0;color:#06145d}.case-detail-section-title h3{margin:0!important;color:inherit!important;font-size:18px!important;line-height:1.2}.case-detail-section-title>.case-detail-icon{width:25px;height:25px}.case-detail-section-action{padding:3px 0;border:0;background:transparent;color:#064fc2;font:inherit;font-size:12px;font-weight:700;cursor:pointer}.case-detail-section-action:hover{text-decoration:underline}
.case-detail-result-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.case-detail-summary{display:grid;grid-template-columns:38px minmax(0,1fr);align-items:center;gap:10px;min-height:68px;padding:11px 14px;border-radius:5px;background:#f1f6fb}.case-detail-summary>.case-detail-icon{width:29px;height:29px;color:#071c7b}.case-detail-summary-copy{min-width:0}.case-detail-summary span{display:block;margin:0 0 3px;color:#647ba2;font-size:10px;letter-spacing:.02em;text-transform:uppercase}.case-detail-summary strong{display:block;overflow-wrap:anywhere;color:#07145c;font-size:16px;line-height:1.25}.case-detail-summary small{display:block;margin-top:4px;color:#64779b;font-size:10px;line-height:1.35}
.case-detail-status-panel{display:grid;grid-template-columns:minmax(0,1fr) minmax(250px,34%);gap:16px;align-items:stretch;margin-top:10px;padding:11px;border-radius:5px}.case-detail-panel-main{display:grid;grid-template-columns:45px minmax(0,1fr);gap:12px;align-items:start;padding:7px}.case-detail-panel-icon{width:42px;height:42px!important;padding:9px;border-radius:50%;color:#fff}.case-detail-panel-title{display:block;margin:2px 0 5px;font-size:15px}.case-detail-panel-description,.case-detail-panel-admission{margin:0;color:inherit;font-size:12px;line-height:1.5;white-space:pre-line}.case-detail-panel-description+.case-detail-panel-description{margin-top:5px}.case-detail-panel-admission{margin-top:6px}.case-detail-status-panel.is-success{background:#e8f6ed;color:#176938}.case-detail-status-panel.is-success .case-detail-panel-icon{background:#188344}.case-detail-status-panel.is-warning{background:#fff3df;color:#a95500}.case-detail-status-panel.is-warning .case-detail-panel-icon{background:#ff9000}.case-detail-status-panel.is-danger{background:#ffe9eb;color:#b80c1b}.case-detail-status-panel.is-danger .case-detail-panel-icon{background:#dc091b}.case-detail-status-panel.is-info{background:#e5f1ff;color:#075cc1}.case-detail-status-panel.is-info .case-detail-panel-icon{background:#0b72e7}.case-detail-status-panel.is-neutral{background:#e9f1fb;color:#435d80}.case-detail-status-panel.is-neutral .case-detail-panel-icon{background:#536c91}.case-detail-panel-side{display:grid;grid-template-columns:34px minmax(0,1fr);align-content:center;column-gap:9px;padding:10px 14px;border:1px solid rgba(74,107,151,.18);border-radius:5px;background:rgba(255,255,255,.58)}.case-detail-panel-side>.case-detail-icon{grid-row:1/4;width:27px;height:27px}.case-detail-panel-side>span{font-size:11px}.case-detail-panel-side>strong{font-size:15px}.case-detail-panel-side .case-detail-panel-description{grid-column:2}.case-detail-related-action,.case-detail-panel-action{grid-column:2;justify-self:start;margin-top:3px;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:800;text-decoration:underline;cursor:pointer}.case-detail-panel-action{min-height:34px;padding:0 18px;border:1px solid #c5d3e4;border-radius:5px;background:#fff;color:#07145d;text-decoration:none}
.case-detail-device-data .case-detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.case-detail-pair{display:block;min-height:62px;padding:10px 12px;border:0;border-radius:4px;background:#f1f6fb}.case-detail-pair>span{display:block;margin-bottom:5px;color:#647ba2;font-size:10px;text-transform:uppercase}.case-detail-pair>strong{display:block;overflow-wrap:anywhere;color:#07145c;font-size:13px;line-height:1.3}.case-detail-rfid-value{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:1px 8px;color:#07145c}.case-detail-rfid-dot{width:10px;height:10px;border-radius:50%;background:#78ed16;box-shadow:0 0 0 3px rgba(120,237,22,.12)}.case-detail-rfid-value strong{font-size:12px}.case-detail-epc{grid-column:2;min-height:auto;margin:0;padding:0;border:0;background:transparent;color:#064fc2;font:inherit;font-size:11px;font-weight:700;text-align:left;cursor:pointer;text-decoration:underline}.case-detail-location .case-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.case-detail-location .case-detail-pair{min-height:58px}.case-detail-location .case-detail-pair strong{white-space:normal;overflow-wrap:anywhere}
.case-detail-media-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.case-detail-media-grid .case-detail-section{display:flex;min-height:174px;flex-direction:column}.case-detail-photo-count{color:#65789c;font-size:11px}.case-detail-media-empty{display:grid;grid-template-columns:50px minmax(0,1fr);align-items:center;column-gap:12px;min-height:92px;color:#59729a}.case-detail-media-empty>.case-detail-icon{grid-row:1/3;width:50px;height:50px;padding:13px;border-radius:50%;background:#f0f5fb;color:#0a3480}.case-detail-media-empty>div{display:none}.case-detail-media-empty strong{align-self:end;color:#4e6790;font-size:13px}.case-detail-media-empty p{align-self:start;margin:4px 0 0;font-size:11px;line-height:1.4}.case-detail-media-grid .document-link{min-height:72px;border-radius:5px;background:#f2f6fb}.case-detail-media-grid .document-open{padding:0;border:0;background:transparent;box-shadow:none;text-shadow:none;outline:0;color:#0d54bc}.case-detail-media-grid .photo-gallery{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.case-detail-media-grid .photo-thumb{aspect-ratio:1.25;border-radius:5px}.case-detail-media-grid .photo-caption{display:none}.photo-gallery.is-collapsed .photo-thumb:nth-child(n+5){display:none}.case-detail-gallery-more{align-self:flex-end;margin-top:auto;padding:7px 12px;border:1px solid #bfcde0;border-radius:5px;background:#fff;color:#06145d;font:inherit;font-size:11px;font-weight:750;cursor:pointer}
.case-detail-links{display:block}.case-detail-links-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.case-detail-link{display:grid!important;grid-template-columns:26px minmax(0,1fr) 18px;align-items:center;gap:8px;width:100%;min-height:48px;padding:8px 13px;border:1px solid #c7d3e4;border-radius:5px;background:#fff;color:#06145d;font:inherit;font-size:12px;font-weight:750;text-align:left;cursor:pointer}.case-detail-link>.case-detail-icon{width:24px;height:24px}.case-detail-link-arrow{justify-self:end;font-size:18px}.case-detail-link:hover,.case-detail-link:focus-visible{border-color:#7699ca;background:#f7faff}.case-detail-safe{margin-top:0;padding:18px;border:1px solid #d6e0ec;border-radius:7px;background:#f4f7fb}
/* Repair detail values are copied from emma_naprawa_FINAL_1to1.html. */
.case-detail-repair-active .portal-refresh-button{width:188px;height:43px;min-height:43px;padding:0;border-radius:6px;gap:13px;font-size:14px}
.case-detail-repair-head{height:108px;min-height:108px;padding-bottom:0}.case-detail-repair-head .case-detail-breadcrumb{gap:14px;margin-bottom:10px}.case-detail-repair-head .case-detail-title-row{gap:14px}.case-detail-repair-head .case-detail-title-row h1{font-size:29px;line-height:34px;font-weight:800;letter-spacing:-.7px}.case-detail-repair-head .case-detail-status-pill{height:34px;padding:0 17px 0 12px;font-size:13px}.case-detail-repair-head .case-detail-status-pill .case-detail-icon{width:20px;height:20px}.case-detail-repair-head .case-detail-subtitle{margin-top:4px!important;line-height:20px}
.case-detail-repair-hero{height:121px;min-height:121px;grid-template-columns:116px minmax(0,1fr) 212px;gap:20px;border-radius:5px}.case-detail-repair-hero .case-detail-device-icon{width:116px;height:92px;margin:0 0 0 14px;border-radius:4px;background:#edf6fc}.case-detail-repair-hero .case-detail-device-icon .case-detail-icon{width:55px;height:55px}.case-detail-repair-hero .case-detail-device{padding:11px 14px}.case-detail-repair-hero .case-detail-device h2{margin-bottom:6px;font-size:23px;line-height:27px}.case-detail-repair-hero .case-detail-device-sub{font-size:16px;line-height:22px}.case-detail-repair-hero .case-detail-device-id{font-size:15px;line-height:22px}.case-detail-repair-state{height:91px;margin-right:14px;padding:12px 13px;border-radius:0;background:transparent;box-shadow:none}.case-detail-repair-state>span{display:block;margin-bottom:10px;color:#0b246c;font-size:13px;line-height:18px;font-weight:700}.case-detail-repair-state-pill{display:flex;align-items:center;justify-content:center;gap:12px;height:43px;border-radius:22px;font-size:14px;font-weight:800}.case-detail-repair-state-pill .case-detail-icon{width:34px;height:34px;padding:7px;border-radius:50%;color:#fff}.case-detail-repair-state-pill.is-success{background:#dff3e3;color:#09682b}.case-detail-repair-state-pill.is-success .case-detail-icon{background:#188344}.case-detail-repair-state-pill.is-warning{background:#fff0d6;color:#b75200}.case-detail-repair-state-pill.is-warning .case-detail-icon{background:#ff9000}.case-detail-repair-state-pill.is-danger{background:#ffe0e5;color:#b61425}.case-detail-repair-state-pill.is-danger .case-detail-icon{background:#ed1c2c}.case-detail-repair-state-pill.is-neutral{background:#e7edf5;color:#425776}.case-detail-repair-state-pill.is-neutral .case-detail-icon{background:#536c91}
.case-detail-repair-summary{margin-top:15px;padding:9px 15px 15px;border-radius:5px}.case-detail-repair-summary .case-detail-section-head{height:33px;margin-bottom:2px}.case-detail-repair-summary .case-detail-section-title{gap:12px}.case-detail-repair-summary .case-detail-section-title>.case-detail-icon{width:27px;height:27px}.case-detail-repair-summary .case-detail-result-grid{gap:8px}.case-detail-repair-summary .case-detail-summary{min-height:64px;padding:10px 13px;grid-template-columns:36px 1fr;gap:12px;background:#edf6fd}.case-detail-repair-summary .case-detail-summary:nth-child(n+4){min-height:99px}.case-detail-repair-summary .case-detail-summary>.case-detail-icon{width:27px;height:27px}.case-detail-repair-summary .case-detail-summary span{font-size:11px;line-height:14px}.case-detail-repair-summary .case-detail-summary strong{font-size:16px;line-height:20px}.case-detail-repair-summary .case-detail-summary small{margin-top:8px;font-size:11px;line-height:15px}
.case-detail-repair-summary~.case-detail-device-data{margin-top:15px;padding:7px 15px 11px;border-radius:5px}.case-detail-repair-summary~.case-detail-device-data .case-detail-section-head{height:33px;margin-bottom:1px}.case-detail-repair-summary~.case-detail-device-data .case-detail-grid{gap:8px}.case-detail-repair-summary~.case-detail-device-data .case-detail-pair{min-height:61px;padding:10px 14px;background:#eef6fd}.case-detail-repair-summary~.case-detail-device-data .case-detail-pair>span{font-size:11px;line-height:14px}.case-detail-repair-summary~.case-detail-device-data .case-detail-pair>strong{font-size:15px;line-height:19px}.case-detail-repair-summary~.case-detail-device-data .case-detail-rfid-dot{width:14px;height:14px;box-shadow:none}
.case-detail-repair-summary~.case-detail-location{margin-top:17px;padding:8px 15px 15px;border-radius:5px}.case-detail-repair-summary~.case-detail-location .case-detail-section-head{height:33px;margin-bottom:2px}.case-detail-repair-summary~.case-detail-location .case-detail-pair{min-height:60px;background:#eef6fd}.case-detail-repair-notes{margin-top:15px;padding:7px 15px 11px;border-radius:5px}.case-detail-repair-notes .case-detail-section-head{height:33px;margin-bottom:3px}.case-detail-repair-notes-box{min-height:61px;padding:12px 14px;border-radius:4px;background:#eef6fd;color:#526b9b;font-size:12px;line-height:18px;white-space:pre-line}
.case-detail-repair-media{margin-top:16px;gap:8px}.case-detail-repair-media .case-detail-section{min-height:116px;height:auto;margin-top:0;padding:8px 14px;border-radius:5px}.case-detail-repair-media .case-detail-section-head{height:34px;margin-bottom:0}.case-detail-repair-media .case-detail-media-empty{min-height:58px;grid-template-columns:62px 1fr;gap:0 16px}.case-detail-repair-media .case-detail-media-empty>.case-detail-icon{width:52px;height:52px;padding:13px}.case-detail-repair-media .case-detail-media-empty strong{font-size:13px;line-height:18px}.case-detail-repair-media .case-detail-media-empty p{font-size:12px;line-height:17px}.case-detail-repair-media+.case-detail-links{margin-top:18px;padding:7px 15px 13px;border-radius:5px}.case-detail-repair-media+.case-detail-links .case-detail-section-head{height:33px;margin-bottom:2px}.case-detail-repair-media+.case-detail-links .case-detail-link{height:49px;min-height:49px;padding:0 12px;border-radius:4px}.case-detail-repair-media+.case-detail-links .case-detail-link>.case-detail-icon{width:26px;height:26px}
/* Final shared Repair / Inspection responsive shell. */
.case-detail-header{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:24px;min-height:94px;padding:0 2px 17px;border:0}
.case-detail-header-main{min-width:0}
.case-detail-header-actions{position:relative;display:flex;align-items:center;justify-content:flex-end;gap:24px;min-width:0;padding-top:28px}
.case-detail-header .case-detail-head-meta{position:static;display:block;margin:0;color:#63779a;text-align:right}
.case-detail-header .case-detail-head-meta p{margin:0;white-space:nowrap;font-size:12px}
.case-detail-header .portal-refresh-bar{position:static;display:flex;align-items:center;justify-content:flex-end;gap:10px;min-height:44px;margin:0}
.case-detail-header .portal-refresh-message{position:absolute;top:48px;right:0;width:max-content;max-width:330px;padding:0!important;background:transparent!important;font-size:11px;font-weight:650;text-align:right}
.case-detail-repair-head{height:auto;min-height:108px;padding-bottom:14px}
.case-detail-repair-head .case-detail-head-meta{position:static}
.case-detail-active>.portal-refresh-bar{position:static}
.document-link{display:grid;grid-template-columns:minmax(0,1fr) auto}
.document-name>span:last-child{min-width:0}
.document-name b,.document-name span{overflow-wrap:anywhere}
.case-detail-link>span:nth-child(2){min-width:0;overflow-wrap:anywhere}
.case-detail-link-arrow{flex-shrink:0}
.page-title-row{display:flex;align-items:center;justify-content:space-between;gap:24px;min-width:0;min-height:44px}
.page-title-row h1{min-width:0;margin:0}
.page-title-row .portal-refresh-bar{flex:0 0 auto;min-height:44px;margin:0}
.page-title-row .portal-refresh-button{display:inline-flex;align-items:center;justify-content:center;gap:9px;line-height:1}
.page-title-row .portal-refresh-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}
.page-title-row .portal-refresh-icon svg{display:block;stroke:#fff;vertical-align:middle}
.page-title-row .portal-refresh-button>span:last-child{line-height:1.2}
.case-detail-header .portal-refresh-icon svg{stroke:#0d1895}
.case-detail-section>.case-detail-section-head{margin-bottom:16px}
.case-detail-result-grid,.case-detail-device-data .case-detail-grid,.case-detail-location .case-detail-grid{align-items:stretch}
.case-detail-summary,.case-detail-pair{height:100%}
@media(min-width:769px) and (max-width:1080px){
  .workspace.case-detail-active{padding-right:22px;padding-left:22px}
  .case-detail-header{grid-template-columns:1fr;gap:10px}
  .case-detail-header-actions{justify-content:flex-start;padding-top:0}
  .case-detail-header .case-detail-head-meta{text-align:left}
  .case-detail-hero,.case-detail-repair-hero{height:auto;grid-template-columns:100px minmax(0,1fr)}
  .case-detail-result,.case-detail-repair-state{grid-column:1/-1;width:auto;height:auto;margin:0;border-top:1px solid #d6e0ec}
  .case-detail-result-grid,.case-detail-device-data .case-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:768px){
  .content{padding-bottom:0}
  .workspace,.workspace.case-detail-active{width:100%;padding:16px 16px calc(var(--mobile-nav-height) + env(safe-area-inset-bottom) + 16px)}
  .mobile-nav{min-height:calc(var(--mobile-nav-height) + env(safe-area-inset-bottom))}
  .page-title-row{align-items:stretch;flex-direction:column;gap:12px}
  .page-title-row .portal-refresh-bar{width:100%}
  .case-detail-header{display:block;min-height:0;padding:0 0 16px}
  .case-detail-breadcrumb{margin-bottom:14px}
  .case-detail-title-row{align-items:flex-start;flex-direction:column;gap:10px}
  .case-detail-title-row h1,.case-detail-repair-head .case-detail-title-row h1{font-size:clamp(30px,9vw,35px);line-height:1.08;letter-spacing:-.035em}
  .case-detail-subtitle,.case-detail-repair-head .case-detail-subtitle{margin-top:10px!important;line-height:1.5}
  .case-detail-header-actions{display:flex;align-items:stretch;flex-direction:column;gap:10px;padding-top:14px}
  .case-detail-header .case-detail-head-meta{margin:0;text-align:left}
  .case-detail-header .case-detail-head-meta p{white-space:normal}
  .case-detail-header .portal-refresh-bar{align-items:stretch;flex-direction:column;justify-content:flex-start;width:100%;margin:0}
  .case-detail-header .portal-refresh-button,.case-detail-repair-active .portal-refresh-button{width:100%}
  .case-detail-header .portal-refresh-message{position:static;width:auto;max-width:none;text-align:left}
  .case-detail-hero,.case-detail-repair-hero{height:auto;min-height:0;grid-template-columns:82px minmax(0,1fr);gap:0}
  .case-detail-device-icon,.case-detail-repair-hero .case-detail-device-icon{align-self:start;width:64px;height:72px;margin:14px 0 14px 12px}
  .case-detail-device-icon .case-detail-icon,.case-detail-repair-hero .case-detail-device-icon .case-detail-icon{width:40px;height:40px}
  .case-detail-device,.case-detail-repair-hero .case-detail-device{min-width:0;padding:16px 12px}
  .case-detail-device h2,.case-detail-repair-hero .case-detail-device h2{font-size:20px;line-height:1.2;overflow-wrap:anywhere}
  .case-detail-device-sub,.case-detail-device-id,.case-detail-repair-hero .case-detail-device-sub,.case-detail-repair-hero .case-detail-device-id{font-size:12px;line-height:1.5;overflow-wrap:anywhere}
  .case-detail-result,.case-detail-repair-state{grid-column:1/-1;align-items:flex-start;width:auto;height:auto;margin:0;padding:14px 16px;border-top:1px solid #d6e0ec;text-align:left}
  .case-detail-repair-state-pill{width:100%;height:auto;min-height:43px;padding:7px 12px}
  .case-detail-status-pill.is-large{min-width:0;font-size:15px}
  .case-detail-section,.case-detail-repair-summary,.case-detail-repair-summary~.case-detail-device-data,.case-detail-repair-summary~.case-detail-location,.case-detail-repair-notes,.case-detail-repair-media .case-detail-section,.case-detail-repair-media+.case-detail-links{padding:15px}
  .case-detail-section-head,.case-detail-repair-summary .case-detail-section-head,.case-detail-repair-summary~.case-detail-device-data .case-detail-section-head,.case-detail-repair-summary~.case-detail-location .case-detail-section-head,.case-detail-repair-notes .case-detail-section-head,.case-detail-repair-media .case-detail-section-head,.case-detail-repair-media+.case-detail-links .case-detail-section-head{height:auto;min-height:33px;align-items:flex-start}
  .case-detail-section-title h3{font-size:clamp(17px,5vw,19px)!important}
  .case-detail-section-action{max-width:48%;text-align:right}
  .case-detail-result-grid,.case-detail-device-data .case-detail-grid,.case-detail-location .case-detail-grid,.case-detail-media-grid,.case-detail-links-grid{grid-template-columns:1fr}
  .case-detail-summary,.case-detail-repair-summary .case-detail-summary,.case-detail-repair-summary .case-detail-summary:nth-child(n+4),.case-detail-pair,.case-detail-repair-summary~.case-detail-device-data .case-detail-pair{height:auto;min-height:0}
  .case-detail-status-panel{grid-template-columns:1fr}
  .case-detail-media-grid .case-detail-section,.case-detail-repair-media .case-detail-section{height:auto;min-height:0}
  .case-detail-links-grid{gap:8px}
  .document-link{grid-template-columns:minmax(0,1fr) auto;min-width:0}
}
@media(max-width:420px){
  .case-detail-hero,.case-detail-repair-hero{grid-template-columns:1fr}
  .case-detail-device-icon,.case-detail-repair-hero .case-detail-device-icon{width:calc(100% - 24px);height:72px;margin:12px}
  .case-detail-device,.case-detail-repair-hero .case-detail-device{padding:4px 16px 16px}
  .document-link{grid-template-columns:minmax(0,1fr)}
  .document-open{justify-self:start;margin-left:37px;white-space:normal}
}
[hidden]{display:none!important}
`;
