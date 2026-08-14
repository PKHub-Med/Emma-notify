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
}
*{box-sizing:border-box}
body{
  margin:0;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  background:var(--bg);
  color:var(--text);
}
button{font:inherit}
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
.page-head{margin-bottom:18px}
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
@media(max-width:800px){
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
@media(max-width:768px){
  html,body{max-width:100%;overflow-x:hidden}
  .app{display:block;min-height:0}.sidebar{display:none!important}
  .mobile-header{position:sticky;z-index:20;top:0;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:58px;padding:8px 16px;background:#fff;border-bottom:1px solid var(--line)}
  .mobile-header div{display:grid;gap:1px}.mobile-header strong{font-size:21px;color:var(--navy)}.mobile-header span{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:750}.mobile-header small{color:var(--muted);font-size:11px}
  .mobile-nav{position:fixed;z-index:40;right:0;bottom:0;left:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));padding:4px 4px calc(4px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:#fff;box-shadow:0 -5px 18px rgba(20,35,60,.1)}
  .mobile-nav button{display:grid;place-items:center;gap:2px;min-width:0;min-height:52px;padding:4px 1px;border:0;border-radius:8px;background:transparent;color:#526075;font:inherit;font-size:10px;font-weight:750}
  .mobile-nav button.active{background:#eaf1ff;color:var(--navy)}.mobile-nav .nav-icon{display:grid;width:22px;height:22px}.mobile-nav svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8}
  .content{padding-bottom:calc(68px + env(safe-area-inset-bottom))}.workspace{width:100%;padding:18px 14px 24px}.page-head h1{font-size:clamp(26px,9vw,34px);line-height:1.08}.page-head p{max-width:100%;font-size:15px}.panel{max-width:100%}.summary-grid{grid-template-columns:1fr}.task,.repair-row,.list-row{grid-template-columns:1fr}.search-bar input,.document-tools input,.document-tools select{min-height:44px}.summary-card,.history-btn,.clear-filter,.back{min-height:44px}
  .upgrade-teaser{align-items:flex-start;flex-direction:column;padding:17px}.upgrade-teaser a{width:100%;white-space:normal;text-align:center}
  .communication-empty{grid-template-columns:1fr;margin:14px;padding:18px}.communication-empty .upgrade-cta{width:100%;white-space:normal;text-align:center}
}
[hidden]{display:none!important}
`;
