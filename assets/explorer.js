/* Radar VC — Carte du monde, Explorer, Tendances en vogue, fiche levée.
   Données : data/deals.json (historique), data/countries.json (pays), data/world-110m.json (fond de carte). */
(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const DAY = 864e5;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

d3.timeFormatDefaultLocale({dateTime: "%A %e %B %Y à %X", date: "%d/%m/%Y", time: "%H:%M:%S", periods: ["AM", "PM"],
  days: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"], shortDays: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
  months: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
  shortMonths: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]});

/* ------------------------------------------------------------------ constantes */
const STAGE_ORDER = ["Pre-seed", "Seed", "Série A", "Série B", "Série C", "Série D+", "Croissance", "Dette", "Subvention", "Non précisé", "Fonds VC", "M&A", "IPO"];
const PERIOD_DAYS = {"24h": 1, "7d": 7, "30d": 30, "3m": 91, "6m": 182, "1y": 365, "5y": 1826, "all": null};
const PERIOD_LABEL = {"24h": "le dernier jour", "7d": "7 jours", "30d": "30 jours", "3m": "3 mois", "6m": "6 mois", "1y": "1 an", "5y": "5 ans", "all": "tout l'historique", "custom": "la période choisie"};
const AMT_MIN = Math.log10(0.05), AMT_MAX = Math.log10(20000);
const SMALL = {SG: [103.82, 1.35], HK: [114.17, 22.3], BH: [50.56, 26.07], LU: [6.13, 49.61], MT: [14.45, 35.9], MU: [57.55, -20.3]};
const SLOTS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7"];
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; };

/* ------------------------------------------------------------------ état */
const DEFAULT = {period: "1y", from: null, to: null, continent: "", country: "", sector: "", stage: "", theme: "", amin: null, amax: null, q: "",
                 kinds: ["round"], official: true};
const S = {...DEFAULT, kinds: [...DEFAULT.kinds], view: "radar", metric: "amount", mapMetric: "amount", sort: {key: "d", dir: -1}, page: 0};
let DEALS = [], META = {continents: [], countries: {}}, WORLD = null, MIN_TS = Date.now() - 365 * DAY;
let SECTOR_TOP = [], CONT_ORDER = [];
const NEW_VIEWS = ["carte", "explorer", "vogue"];

/* ------------------------------------------------------------------ utilitaires */
const flag = cc => cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : "🌐";
const cname = cc => META.countries[cc]?.n || (cc ? cc : "Pays inconnu");
const fmtM = m => {
  if (m == null || isNaN(m)) return "–";
  if (m >= 1000) return (m / 1000).toLocaleString("fr-FR", {maximumFractionDigits: m >= 10000 ? 0 : 1}) + " Md€";
  if (m >= 1) return m.toLocaleString("fr-FR", {maximumFractionDigits: m < 10 ? 1 : 0}) + " M€";
  return Math.round(m * 1000).toLocaleString("fr-FR") + " k€";
};
const fmtN = n => (n ?? 0).toLocaleString("fr-FR");
const fmtD = ts => new Date(ts).toLocaleDateString("fr-FR", {day: "numeric", month: "short", year: "numeric"});
const growth = (cur, prev) => prev > 0 ? (cur - prev) / prev : (cur > 0 ? Infinity : 0);
const fmtG = g => g === Infinity ? `<span class="growth up">nouveau</span>` : !isFinite(g) || g === 0 ? `<span class="growth">=</span>`
  : `<span class="growth ${g > 0 ? "up" : "down"}">${g > 0 ? "▲" : "▼"} ${Math.abs(Math.round(g * 100))} %</span>`;
const sliderToAmt = v => Math.pow(10, AMT_MIN + v / 1000 * (AMT_MAX - AMT_MIN));
const amtToSlider = a => Math.round((Math.log10(a) - AMT_MIN) / (AMT_MAX - AMT_MIN) * 1000);

function sectorKey(d) {
  const s = d.sec || [];
  const top = SECTOR_TOP.find(x => s.includes(x));
  return top || (s.length ? "Autres" : "Non classé");
}
const sectorColor = k => { const i = SECTOR_TOP.indexOf(k); return i >= 0 ? `var(${SLOTS[i]})` : "var(--other)"; };
const contColor = k => { const i = CONT_ORDER.indexOf(k); return i >= 0 ? `var(${SLOTS[i]})` : "var(--other)"; };

/* ------------------------------------------------------------------ tooltip */
const tip = {
  el: null,
  show(html, ev) {
    this.el = this.el || $("#tip");
    this.el.innerHTML = html; this.el.classList.add("on");
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
    if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
    this.el.style.left = Math.max(8, x) + "px"; this.el.style.top = Math.max(8, y) + "px";
  },
  hide() { (this.el || $("#tip")).classList.remove("on"); }
};

/* ------------------------------------------------------------------ chargement */
async function getJSON(url) {
  try { const r = await fetch(url + (url.startsWith("http") ? "" : "?" + Date.now())); return r.ok ? await r.json() : null; } catch { return null; }
}

async function load() {
  const [deals, meta, radar] = await Promise.all([getJSON("data/deals.json"), getJSON("data/countries.json"), getJSON("data/radar.json")]);
  if (meta) META = meta;
  let raw = deals?.deals;
  if (!raw && radar) {  // transition : pas encore de base historique
    raw = (radar.articles || []).filter(a => a.deal).map(a => ({id: a.id, c: a.company || a.title.split(" ").slice(0, 2).join(" "), t: a.title, u: a.link,
      d: a.date.slice(0, 10), a: a.amount?.eur_m ?? null, al: a.amount?.label, st: a.round || "Non précisé", sec: a.sectors || [], th: a.themes || [],
      cc: a.country || "", inv: a.investors || [], src: [a.source], n: 1, k: a.kind || "round"}));
  }
  DEALS = (raw || []).map(d => ({...d, ts: Date.parse(d.d + "T12:00:00Z"), ct: META.countries[d.cc]?.ct || "", k: d.k || "round",
                                 sec: d.sec || [], th: d.th || [], inv: d.inv || [], src: d.src || [], n: d.n || (d.src || []).length || 1}));
  DEALS.sort((a, b) => b.ts - a.ts);
  if (DEALS.length) MIN_TS = d3.min(DEALS, d => d.ts);
  const secCount = d3.rollup(DEALS.flatMap(d => d.sec), v => v.length, s => s);
  SECTOR_TOP = [...secCount].sort((a, b) => b[1] - a[1]).slice(0, 7).map(x => x[0]);
  CONT_ORDER = META.continents?.length ? META.continents : [...new Set(DEALS.map(d => d.ct).filter(Boolean))];
  const n = DEALS.length;
  $("#dbcount").textContent = n ? `· ${fmtN(n)} levées en base depuis ${new Date(MIN_TS).getFullYear()}` : "";
  buildBar();
  readHash();
  update(true);
}

/* ------------------------------------------------------------------ filtres */
function range() {
  const end = Date.now() + DAY;
  if (S.period === "custom" && S.from && S.to) return [S.from, S.to];
  const days = PERIOD_DAYS[S.period];
  return days ? [end - (days + 1) * DAY, end] : [Math.min(MIN_TS, end - 30 * DAY) - DAY, end];
}
const prevRange = r => [r[0] - (r[1] - r[0]), r[0]];
/* Périodes servant aux évolutions. Sur « Tout », on compare les 12 derniers mois aux 12 précédents. */
function cmpRanges() {
  if (S.period === "all") { const e = Date.now() + DAY; return [[e - 366 * DAY, e], [e - 731 * DAY, e - 366 * DAY]]; }
  const r = range(); return [r, prevRange(r)];
}
const CMP_LABEL = () => S.period === "all" ? "12 derniers mois vs 12 précédents" : `${PERIOD_LABEL[S.period]} vs période précédente`;

function pass(d, skip, r) {
  if (d.ts < r[0] || d.ts >= r[1]) return false;
  if (!S.kinds.includes(d.k)) return false;
  if (!S.official && d.o && d.n === 1) return false;
  if (!skip.has("continent") && S.continent && d.ct !== S.continent) return false;
  if (!skip.has("country") && S.country && d.cc !== S.country) return false;
  if (!skip.has("sector") && S.sector && !d.sec.includes(S.sector)) return false;
  if (!skip.has("stage") && S.stage && d.st !== S.stage) return false;
  if (!skip.has("theme") && S.theme && !d.th.includes(S.theme)) return false;
  if (!skip.has("amount") && (S.amin != null || S.amax != null)) {
    if (d.a == null) return false;
    if (S.amin != null && d.a < S.amin) return false;
    if (S.amax != null && d.a > S.amax) return false;
  }
  if (S.q) {
    const hay = `${d.c || ""} ${d.t} ${d.inv.join(" ")} ${d.src.join(" ")}`.toLowerCase();
    if (!hay.includes(S.q.toLowerCase())) return false;
  }
  return true;
}
const sel = (skip = [], r = range()) => { const sk = new Set(skip); return DEALS.filter(d => pass(d, sk, r)); };

function stats(arr) {
  const amts = arr.map(d => d.a).filter(a => a != null).sort((a, b) => a - b);
  let max = null;
  for (const d of arr) if (d.a != null && (!max || d.a > max.a)) max = d;
  return {n: arr.length, sum: d3.sum(amts), med: d3.median(amts), max, multi: arr.filter(d => d.n > 1).length};
}

/* ------------------------------------------------------------------ barre de filtres */
function buildBar() {
  const opt = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;
  $("#g-continent").innerHTML = opt("", "Tous continents") + CONT_ORDER.map(c => opt(c, c)).join("");
  const secs = [...new Set(DEALS.flatMap(d => d.sec))].sort((a, b) => a.localeCompare(b, "fr"));
  $("#g-sector").innerHTML = opt("", "Tous secteurs") + secs.map(s => opt(s, s)).join("");
  const ths = [...new Set(DEALS.flatMap(d => d.th))].sort((a, b) => a.localeCompare(b, "fr"));
  $("#g-theme").innerHTML = opt("", "Toutes tendances") + ths.map(s => opt(s, s)).join("");
  const sts = STAGE_ORDER.filter(s => DEALS.some(d => d.st === s));
  $("#g-stage").innerHTML = opt("", "Toutes étapes") + sts.map(s => opt(s, s)).join("");

  $$("#f-period button").forEach(b => b.onclick = () => {
    S.period = b.dataset.p;
    if (S.period === "custom" && !S.from) { const r = [Date.now() - 365 * DAY, Date.now() + DAY]; S.from = r[0]; S.to = r[1]; }
    update();
  });
  $("#f-from").onchange = e => { S.from = Date.parse(e.target.value + "T00:00:00Z") || S.from; S.period = "custom"; update(); };
  $("#f-to").onchange = e => { S.to = (Date.parse(e.target.value + "T00:00:00Z") || S.to) + DAY; S.period = "custom"; update(); };
  $("#g-continent").onchange = e => { S.continent = e.target.value; if (S.country && META.countries[S.country]?.ct !== S.continent) S.country = ""; update(); };
  $("#g-country").onchange = e => { S.country = e.target.value; if (S.country) S.continent = META.countries[S.country]?.ct || ""; update(); };
  $("#g-sector").onchange = e => { S.sector = e.target.value; update(); };
  $("#g-theme").onchange = e => { S.theme = e.target.value; update(); };
  $("#g-stage").onchange = e => { S.stage = e.target.value; update(); };
  let qT; $("#g-q").oninput = e => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value.trim(); update(); }, 250); };
  [["k-round", "round"], ["k-fund", "fund"], ["k-exit", "exit"]].forEach(([id, k]) => $("#" + id).onchange = e => {
    S.kinds = e.target.checked ? [...new Set([...S.kinds, k])] : S.kinds.filter(x => x !== k);
    if (!S.kinds.length) { S.kinds = ["round"]; }
    update();
  });
  $("#k-off").onchange = e => { S.official = e.target.checked; update(); };
  const mn = $("#amt-min"), mx = $("#amt-max");
  const onSlide = () => {
    let a = +mn.value, b = +mx.value;
    if (a > b - 20) { if (document.activeElement === mn) a = mn.value = b - 20; else b = mx.value = a + 20; }
    S.amin = a <= 0 ? null : +sliderToAmt(a).toPrecision(2);
    S.amax = b >= 1000 ? null : +sliderToAmt(b).toPrecision(2);
    paintSlider();
  };
  let sT;
  [mn, mx].forEach(el => { el.oninput = () => { onSlide(); clearTimeout(sT); sT = setTimeout(() => update(), 180); }; });
  $$("#amt-quick button").forEach(b => b.onclick = () => {
    const [lo, hi] = b.dataset.r.split(",");
    const same = S.amin === (+lo || null) && S.amax === (hi ? +hi : null);
    S.amin = same ? null : (+lo || null); S.amax = same ? null : (hi ? +hi : null);
    update();
  });
}

function paintSlider() {
  const a = S.amin == null ? 0 : Math.max(0, amtToSlider(S.amin)), b = S.amax == null ? 1000 : Math.min(1000, amtToSlider(S.amax));
  $("#amt-min").value = a; $("#amt-max").value = b;
  $("#amt-sel").style.left = a / 10 + "%"; $("#amt-sel").style.right = (100 - b / 10) + "%";
  $("#amt-out").textContent = S.amin == null && S.amax == null ? "Tous montants"
    : S.amax == null ? `${fmtM(S.amin)} et plus` : S.amin == null ? `jusqu'à ${fmtM(S.amax)}` : `${fmtM(S.amin)} – ${fmtM(S.amax)}`;
  $$("#amt-quick button").forEach(btn => { const [lo, hi] = btn.dataset.r.split(","); btn.classList.toggle("on", S.amin === (+lo || null) && S.amax === (hi ? +hi : null)); });
}

function syncBar() {
  $$("#f-period button").forEach(b => b.classList.toggle("on", b.dataset.p === S.period));
  $("#f-dates").hidden = S.period !== "custom";
  if (S.period === "custom" && S.from) { $("#f-from").value = new Date(S.from).toISOString().slice(0, 10); $("#f-to").value = new Date(S.to - DAY).toISOString().slice(0, 10); }
  $("#g-continent").value = S.continent;
  const counts = d3.rollup(DEALS, v => v.length, d => d.cc);
  const ccs = Object.keys(META.countries).filter(c => counts.get(c) && (!S.continent || META.countries[c].ct === S.continent))
    .sort((a, b) => cname(a).localeCompare(cname(b), "fr"));
  $("#g-country").innerHTML = `<option value="">${S.continent ? "Tous pays · " + esc(S.continent) : "Tous pays"}</option>` +
    ccs.map(c => `<option value="${c}">${flag(c)} ${esc(cname(c))} (${counts.get(c)})</option>`).join("");
  $("#g-country").value = S.country;
  $("#g-sector").value = S.sector; $("#g-theme").value = S.theme; $("#g-stage").value = S.stage;
  if ($("#g-q") !== document.activeElement) $("#g-q").value = S.q;
  $("#k-round").checked = S.kinds.includes("round"); $("#k-fund").checked = S.kinds.includes("fund"); $("#k-exit").checked = S.kinds.includes("exit");
  $("#k-off").checked = S.official;
  paintSlider();
  const chips = [];
  const add = (label, clear) => chips.push({label, clear});
  if (S.continent && !S.country) add(S.continent, () => S.continent = "");
  if (S.country) add(`${flag(S.country)} ${cname(S.country)}`, () => S.country = "");
  if (S.sector) add(S.sector, () => S.sector = "");
  if (S.theme) add("Tendance : " + S.theme, () => S.theme = "");
  if (S.stage) add(S.stage, () => S.stage = "");
  if (S.amin != null || S.amax != null) add($("#amt-out").textContent, () => { S.amin = null; S.amax = null; });
  if (S.q) add(`« ${S.q} »`, () => S.q = "");
  const r = range();
  const total = sel([], r).length;
  $("#f-active").innerHTML = `<button class="btn small" id="f-toggle">${$("#fbar").classList.contains("collapsed") ? "Afficher les filtres" : "Masquer les filtres"}</button><span class="fb-label"><strong>${fmtN(total)}</strong> levées · ${S.period === "custom" ? fmtD(r[0]) + " → " + fmtD(r[1] - DAY) : PERIOD_LABEL[S.period]}</span>` +
    chips.map((c, i) => `<span class="fchip">${esc(c.label)}<button data-i="${i}" aria-label="Retirer ce filtre">×</button></span>`).join("") +
    (chips.length ? `<button class="linkbtn" id="f-reset">Tout réinitialiser</button>` : "");
  $$("#f-active .fchip button").forEach(b => b.onclick = () => { chips[+b.dataset.i].clear(); update(); });
  $("#f-toggle").onclick = () => { $("#fbar").classList.toggle("collapsed"); syncBar(); };
  if ($("#f-reset")) $("#f-reset").onclick = () => { Object.assign(S, {...DEFAULT, kinds: [...DEFAULT.kinds]}); update(); };
}

/* ------------------------------------------------------------------ URL partageable */
function writeHash() {
  if (!NEW_VIEWS.includes(S.view)) return;
  const p = new URLSearchParams();
  if (S.period !== DEFAULT.period) p.set("p", S.period);
  if (S.period === "custom") { p.set("from", new Date(S.from).toISOString().slice(0, 10)); p.set("to", new Date(S.to - DAY).toISOString().slice(0, 10)); }
  [["ct", "continent"], ["cc", "country"], ["sec", "sector"], ["st", "stage"], ["th", "theme"], ["q", "q"]].forEach(([k, f]) => S[f] && p.set(k, S[f]));
  if (S.amin != null) p.set("amin", S.amin);
  if (S.amax != null) p.set("amax", S.amax);
  if (S.kinds.join() !== "round") p.set("k", S.kinds.join(","));
  if (!S.official) p.set("off", "0");
  const h = "#" + S.view + (p.toString() ? "?" + p : "");
  if (location.hash !== h) history.replaceState(null, "", h);
}
function readHash() {
  const [view, qs] = location.hash.slice(1).split("?");
  if (!NEW_VIEWS.includes(view)) return;
  const p = new URLSearchParams(qs || "");
  S.period = p.get("p") || DEFAULT.period;
  if (S.period === "custom") { S.from = Date.parse(p.get("from") + "T00:00:00Z"); S.to = Date.parse(p.get("to") + "T00:00:00Z") + DAY; if (!S.from || !S.to) S.period = DEFAULT.period; }
  S.continent = p.get("ct") || ""; S.country = p.get("cc") || ""; S.sector = p.get("sec") || ""; S.stage = p.get("st") || "";
  S.theme = p.get("th") || ""; S.q = p.get("q") || "";
  S.amin = p.has("amin") ? +p.get("amin") : null; S.amax = p.has("amax") ? +p.get("amax") : null;
  S.kinds = (p.get("k") || "round").split(","); S.official = p.get("off") !== "0";
  const btn = $(`#tabs button[data-tab="${view}"]`);
  if (btn) btn.click();
}

/* ------------------------------------------------------------------ rendu central */
function update(first) {
  S.page = 0;
  syncBar();
  writeHash();
  render();
}
function render() {
  if (!DEALS.length && NEW_VIEWS.includes(S.view)) {
    const msg = `<div class="card empty">Pas encore de levées en base. Lance le workflow « Mise à jour du radar » (et « Remplir l'historique ») dans l'onglet Actions de GitHub.</div>`;
    if (S.view === "carte") $("#scope").innerHTML = msg;
    if (S.view === "explorer") $("#x-table").innerHTML = "";
    if (S.view === "vogue") $("#v-cards").innerHTML = msg;
  }
  if (S.view === "carte") renderMap();
  if (S.view === "explorer") renderExplorer();
  if (S.view === "vogue") renderVogue();
  if (S.view === "favoris") renderFavDeals();
}

document.addEventListener("radar:tab", e => {
  S.view = e.detail;
  $("#fbar").hidden = !NEW_VIEWS.includes(S.view);
  if (NEW_VIEWS.includes(S.view)) writeHash(); else if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  if (DEALS.length || S.view !== "favoris") requestAnimationFrame(render);
});
$("#theme").addEventListener("click", () => setTimeout(render, 30));
let rT; addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(render, 200); });

/* ------------------------------------------------------------------ composants */
function kpiRow(cur, prev) {
  const a = stats(cur), b = S.period === "all" ? {n: 0, sum: 0, med: null} : stats(prev);
  const pct = a.n ? Math.round(a.multi / a.n * 100) : 0;
  return `
  <div class="card kpi"><div class="l">Levées</div><div class="v">${fmtN(a.n)}</div><div class="d">${S.period === "all" ? "sur tout l'historique" : fmtG(growth(a.n, b.n)) + " vs période préc."}</div></div>
  <div class="card kpi"><div class="l">Montant total annoncé</div><div class="v">${fmtM(a.sum)}</div><div class="d">${S.period === "all" ? "sur tout l'historique" : fmtG(growth(a.sum, b.sum)) + " vs période préc."}</div></div>
  <div class="card kpi"><div class="l">Ticket médian</div><div class="v">${fmtM(a.med)}</div><div class="d">${S.period === "all" ? "toutes périodes" : "préc. : " + fmtM(b.med)}</div></div>
  <div class="card kpi" ${a.max ? `style="cursor:pointer" data-deal="${esc(a.max.id)}"` : ""}><div class="l">Plus grosse levée</div><div class="v">${a.max ? fmtM(a.max.a) : "–"}</div>
    <div class="d">${a.max ? flag(a.max.cc) + " " + esc(a.max.c || "") : ""}</div></div>
  <div class="card kpi" title="Part des levées citées par au moins 2 sources indépendantes"><div class="l">Fiabilité des données</div><div class="v">${pct} %</div>
    <div class="d">confirmées par 2 sources +</div></div>`;
}
function bindDeals(root) { $$("[data-deal]", root).forEach(el => el.onclick = () => openDeal(el.dataset.deal)); }

function hbars(el, items, {selected, onClick, fmt = fmtN, color} = {}) {
  const max = d3.max(items, d => d.value) || 1;
  el.innerHTML = items.length ? items.map((d, i) => `<button class="hb ${selected && selected === d.key ? "on" : ""}" data-i="${i}" title="${esc(d.title || d.label)}">
    <span class="lbl">${d.label}</span><span class="trk"><span class="fl" style="width:${Math.max(2, d.value / max * 100)}%;background:${color ? color(d) : "var(--ink)"}"></span></span>
    <span class="vv">${d.extra ?? fmt(d.value)}</span></button>`).join("") : `<div class="empty" style="padding:16px">Aucune donnée.</div>`;
  $$(".hb", el).forEach(b => b.onclick = () => onClick && onClick(items[+b.dataset.i]));
}

function legend(el, keys, {colorFn, active, onClick, values} = {}) {
  el.innerHTML = keys.map(k => `<button class="it ${active && active !== k ? "off" : ""}" data-k="${esc(k)}"><i style="background:${colorFn(k)}"></i>${esc(k)}${values ? ` <b>${values(k)}</b>` : ""}</button>`).join("");
  $$(".it", el).forEach(b => b.onclick = () => onClick && onClick(b.dataset.k));
}

function bucketing(r) {
  const days = (r[1] - r[0]) / DAY;
  if (days <= 45) return {iv: d3.utcDay, fmt: d3.utcFormat("%e %b"), label: "jour"};
  if (days <= 200) return {iv: d3.utcMonday, fmt: d3.utcFormat("%e %b"), label: "semaine"};
  if (days <= 1900) return {iv: d3.utcMonth, fmt: d3.utcFormat(days > 800 ? "%b %Y" : "%b %y"), label: "mois"};
  return {iv: d3.utcMonth.every(3), fmt: d3.utcFormat("%b %Y"), label: "trimestre"};
}

/* Histogramme temporel empilé, avec brosse pour zoomer */
function timeChart(el, arr, r, {metric = "amount", keys, keyFn, colorFn, onBrush, height = 250} = {}) {
  const {iv, fmt} = bucketing(r);
  const buckets = iv.range(iv.floor(new Date(r[0])), new Date(r[1]));
  if (!buckets.length) buckets.push(iv.floor(new Date(r[0])));
  const idx = new Map(buckets.map((b, i) => [+b, i]));
  const rows = buckets.map(b => { const o = {t: b}; keys.forEach(k => o[k] = 0); return o; });
  for (const d of arr) {
    const i = idx.get(+iv.floor(new Date(d.ts)));
    if (i == null) continue;
    const k = keyFn(d);
    rows[i][k] = (rows[i][k] || 0) + (metric === "amount" ? (d.a || 0) : 1);
  }
  const W = Math.max(320, el.clientWidth || 800), H = height, m = {t: 10, r: 8, b: 26, l: 56};
  const series = d3.stack().keys(keys)(rows);
  const x = d3.scaleBand(buckets.map(b => +b), [m.l, W - m.r]).padding(buckets.length > 60 ? 0.08 : 0.18);
  const ymax = d3.max(series, s => d3.max(s, p => p[1])) || 1;
  const y = d3.scaleLinear([0, ymax], [H - m.b, m.t]).nice();
  const yfmt = metric === "amount" ? (v => fmtM(v)) : (v => fmtN(v));
  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
    .attr("aria-label", `Levées par ${bucketing(r).label}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(yfmt).tickSizeOuter(0)).call(g => g.select(".domain").remove());
  const step = Math.ceil(buckets.length / Math.max(2, Math.floor((W - m.l) / 70)));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickValues(x.domain().filter((_, i) => i % step === 0)).tickFormat(t => fmt(new Date(t))).tickSizeOuter(0));
  const bw = x.bandwidth();
  svg.append("g").selectAll("g").data(series).join("g").attr("fill", s => colorFn(s.key))
    .selectAll("rect").data(s => s).join("rect")
    .attr("x", p => x(+p.data.t)).attr("width", bw)
    .attr("y", p => y(p[1])).attr("height", p => Math.max(0, y(p[0]) - y(p[1]) - (y(p[0]) - y(p[1]) > 3 ? 1 : 0)))
    .attr("rx", Math.min(3, bw / 4));
  const hover = svg.append("g");
  hover.selectAll("rect").data(rows).join("rect").attr("x", d => x(+d.t)).attr("width", bw).attr("y", m.t).attr("height", H - m.b - m.t)
    .attr("fill", "transparent")
    .on("mousemove", (ev, d) => {
      const tot = d3.sum(keys, k => d[k]);
      const lines = keys.filter(k => d[k] > 0).sort((a, b) => d[b] - d[a]).slice(0, 8)
        .map(k => `<div class="tr"><span><i style="background:${colorFn(k)}"></i>${esc(k)}</span><span>${yfmt(d[k])}</span></div>`).join("");
      tip.show(`<div class="tt">${fmt(d.t)} · ${yfmt(tot)}</div>${lines || '<div class="meta">Aucune levée</div>'}`, ev);
    })
    .on("mouseleave", () => tip.hide());
  if (onBrush && buckets.length > 2) {
    const brush = d3.brushX().extent([[m.l, m.t], [W - m.r, H - m.b]]).on("end", ev => {
      if (!ev.selection) return;
      const [a, b] = ev.selection;
      const inside = x.domain().filter(t => x(t) + bw > a && x(t) < b);
      if (!inside.length) return;
      tip.hide();
      onBrush(inside[0], +iv.offset(new Date(inside[inside.length - 1]), 1));
    });
    svg.append("g").attr("class", "brush").call(brush).selectAll(".overlay").style("cursor", "crosshair")
      .on("mousemove.tip", function (ev) {
        const [px] = d3.pointer(ev, this);
        const t = x.domain().find(t => px >= x(t) && px <= x(t) + bw + x.step() * x.paddingInner());
        const d = t != null && rows[idx.get(t)];
        if (!d) return tip.hide();
        const tot = d3.sum(keys, k => d[k]);
        const lines = keys.filter(k => d[k] > 0).sort((a, b) => d[b] - d[a]).slice(0, 8)
          .map(k => `<div class="tr"><span><i style="background:${colorFn(k)}"></i>${esc(k)}</span><span>${yfmt(d[k])}</span></div>`).join("");
        tip.show(`<div class="tt">${fmt(d.t)} · ${yfmt(tot)}</div>${lines || '<div class="meta">Aucune levée</div>'}`, ev);
      })
      .on("mouseleave.tip", () => tip.hide());
  }
  el.replaceChildren(svg.node());
}

function donut(el, items, {selected, onClick, fmt = fmtN, centerLabel = "levées"} = {}) {
  const total = d3.sum(items, d => d.value);
  el.innerHTML = `<div class="donut-wrap"><svg viewBox="-90 -90 180 180" style="width:170px;height:170px" role="img" aria-label="Répartition"></svg><div class="hbars"></div></div>`;
  const svg = d3.select($("svg", el));
  const pie = d3.pie().value(d => d.value).sort(null).padAngle(items.length > 1 ? 0.02 : 0);
  const arc = d3.arc().innerRadius(54).outerRadius(80).cornerRadius(3);
  const arcSel = d3.arc().innerRadius(54).outerRadius(87).cornerRadius(3);
  svg.selectAll("path").data(pie(items)).join("path")
    .attr("d", p => (selected === p.data.key ? arcSel : arc)(p)).attr("fill", p => p.data.color)
    .attr("opacity", p => selected && selected !== p.data.key ? 0.3 : 1).style("cursor", "pointer")
    .on("mousemove", (ev, p) => tip.show(`<div class="tt">${esc(p.data.label)}</div><div class="tr"><span>${fmt(p.data.value)}</span><span>${total ? Math.round(p.data.value / total * 100) : 0} %</span></div>`, ev))
    .on("mouseleave", () => tip.hide()).on("click", (ev, p) => { tip.hide(); onClick && onClick(p.data); });
  svg.append("text").attr("text-anchor", "middle").attr("y", -2).attr("fill", "var(--ink)").style("font", "700 20px var(--display)").text(fmt(total));
  svg.append("text").attr("text-anchor", "middle").attr("y", 16).attr("fill", "var(--muted)").style("font", "11px Inter").text(centerLabel);
  hbars($(".hbars", el), items.slice(0, 9), {selected, onClick, fmt, color: d => d.color});
}

function topList(el, arr, {limit = 15, showRank = true} = {}) {
  const list = arr.filter(d => d.a != null).sort((a, b) => b.a - a.a).slice(0, limit);
  const max = list[0]?.a || 1;
  el.innerHTML = list.length ? list.map((d, i) => `<div class="deal" data-deal="${esc(d.id)}">
    <div class="rank">${showRank ? String(i + 1).padStart(2, "0") : ""}</div>
    <div><span class="t">${flag(d.cc)} ${esc(d.c || d.t)}</span>
      <div class="meta">${esc(d.st)} · ${fmtD(d.ts)}${d.sec.length ? " · " + esc(d.sec.slice(0, 2).join(", ")) : ""}${d.n > 1 ? ` · ${d.n} sources` : ""}</div>
      <div class="dealbar" style="width:${Math.max(3, d.a / max * 100)}%"></div></div>
    <div class="amt">${esc(d.al || fmtM(d.a))}</div></div>`).join("") : `<div class="empty" style="padding:16px">Aucune levée chiffrée avec ces filtres.</div>`;
  bindDeals(el);
}

function growthRows(cur, prev, keyFn, labelFn, minN = 3) {
  const c = d3.rollup(cur.flatMap(d => keyFn(d).map(k => [k, d])), v => ({n: v.length, s: d3.sum(v, x => x[1].a || 0)}), x => x[0]);
  const p = d3.rollup(prev.flatMap(d => keyFn(d).map(k => [k, d])), v => ({n: v.length, s: d3.sum(v, x => x[1].a || 0)}), x => x[0]);
  return [...new Set([...c.keys(), ...p.keys()])].filter(Boolean).map(k => {
    const a = c.get(k) || {n: 0, s: 0}, b = p.get(k) || {n: 0, s: 0};
    return {key: k, label: labelFn(k), n: a.n, pn: b.n, s: a.s, ps: b.s, g: growth(a.n, b.n), gs: growth(a.s, b.s),
            score: Math.log((a.n + 1) / (b.n + 1)) + 0.5 * Math.log((a.s + 1) / (b.s + 1))};
  }).filter(r => Math.max(r.n, r.pn) >= minN);
}

function growthTable(el, rows, onClick) {
  rows = rows.sort((a, b) => b.score - a.score).slice(0, 10);
  el.innerHTML = rows.length ? `<div class="scroll"><table><thead><tr><th></th><th>Levées</th><th>Évol.</th><th>Montant</th><th>Évol.</th></tr></thead><tbody>${rows.map((r, i) => `
    <tr data-i="${i}" style="cursor:pointer"><td>${r.label}</td><td class="mono">${r.n} <span class="meta">(${r.pn})</span></td><td>${fmtG(r.g)}</td>
    <td class="mono">${fmtM(r.s)}</td><td>${fmtG(r.gs)}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty" style="padding:16px">Pas assez de levées pour comparer. Élargis la période.</div>`;
  $$("tr[data-i]", el).forEach(tr => tr.onclick = () => onClick(rows[+tr.dataset.i]));
}

/* ------------------------------------------------------------------ CARTE */
function topoFeatures(topo, name) {
  const tf = topo.transform;
  const arcs = topo.arcs.map(arc => {
    let x = 0, y = 0;
    return arc.map(p => tf ? (x += p[0], y += p[1], [x * tf.scale[0] + tf.translate[0], y * tf.scale[1] + tf.translate[1]]) : p.slice());
  });
  const line = i => i >= 0 ? arcs[i] : arcs[~i].slice().reverse();
  const ring = ids => { const pts = []; ids.forEach((i, k) => { const a = line(i); pts.push(...(k ? a.slice(1) : a)); }); return pts; };
  return topo.objects[name].geometries.map(g => ({
    type: "Feature", id: g.id, properties: g.properties || {},
    geometry: g.type === "Polygon" ? {type: "Polygon", coordinates: g.arcs.map(ring)}
      : g.type === "MultiPolygon" ? {type: "MultiPolygon", coordinates: g.arcs.map(p => p.map(ring))} : null
  })).filter(f => f.geometry);
}
function mainPart(f) {
  if (f.geometry.type !== "MultiPolygon") return f;
  let best = null, area = -1;
  for (const coords of f.geometry.coordinates) {
    const g = {type: "Feature", geometry: {type: "Polygon", coordinates: coords}};
    const a = d3.geoArea(g);
    if (a > area && a < 6) { area = a; best = g; }
  }
  return best || f;
}

const MAP = {W: 960, H: 470, svg: null, g: null, path: null, feats: [], k: 1};

async function ensureMap() {
  if (MAP.svg) return true;
  if (!WORLD) {
    WORLD = await getJSON("data/world-110m.json") || await getJSON("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json");
    if (!WORLD) { $("#map").innerHTML = `<div class="empty">Fond de carte indisponible pour l'instant. Il sera téléchargé automatiquement au prochain passage du workflow.</div>`; return false; }
  }
  const num2iso = new Map(Object.entries(META.countries).map(([iso, c]) => [+c.num, iso]));
  MAP.feats = topoFeatures(WORLD, "countries").filter(f => f.id !== "010" && f.properties.name !== "Antarctica");
  MAP.feats.forEach(f => { f.iso = num2iso.get(+f.id) || null; f.main = mainPart(f); });
  const proj = d3.geoNaturalEarth1().fitExtent([[4, 4], [MAP.W - 4, MAP.H - 4]], {type: "FeatureCollection", features: MAP.feats});
  MAP.proj = proj; MAP.path = d3.geoPath(proj);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${MAP.W} ${MAP.H}`).attr("role", "img").attr("aria-label", "Carte des levées par pays");
  svg.append("rect").attr("width", MAP.W).attr("height", MAP.H).attr("fill", "transparent").on("click", () => { if (S.country) { S.country = ""; update(); } });
  MAP.g = svg.append("g");
  MAP.g.selectAll("path").data(MAP.feats).join("path").attr("d", MAP.path).attr("class", d => "country" + (d.iso ? " known" : ""))
    .on("mousemove", (ev, d) => mapTip(ev, d.iso, d.properties.name)).on("mouseleave", () => tip.hide())
    .on("click", (ev, d) => { ev.stopPropagation(); if (d.iso) pickCountry(d.iso); });
  MAP.g.selectAll("circle").data(Object.entries(SMALL).filter(([iso]) => META.countries[iso])).join("circle").attr("class", "dot")
    .attr("cx", d => proj(d[1])[0]).attr("cy", d => proj(d[1])[1]).attr("r", 4)
    .on("mousemove", (ev, d) => mapTip(ev, d[0])).on("mouseleave", () => tip.hide())
    .on("click", (ev, d) => { ev.stopPropagation(); pickCountry(d[0]); });
  MAP.svg = svg;
  $("#map").replaceChildren(svg.node());
  return true;
}

function pickCountry(iso) {
  if (S.country === iso) { S.country = ""; } else { S.country = iso; S.continent = META.countries[iso]?.ct || ""; }
  tip.hide();
  update();
  $("#scope").scrollIntoView({behavior: "smooth", block: "start"});
}

let MAPVAL = new Map();
function mapTip(ev, iso, fallback) {
  if (!iso) return tip.show(`<div class="tt">${esc(fallback || "")}</div><div class="meta">Pays non suivi</div>`, ev);
  const v = MAPVAL.get(iso) || {n: 0, s: 0, pn: 0, ps: 0};
  tip.show(`<div class="tt">${flag(iso)} ${esc(cname(iso))}</div>
    <div class="tr"><span>Levées</span><span>${fmtN(v.n)}</span></div><div class="tr"><span>Montant</span><span>${fmtM(v.s)}</span></div>
    <div class="tr"><span>Évolution</span><span>${fmtG(growth(v.gcur ?? v.n, v.pn))}</span></div><div class="meta" style="margin-top:4px">Clique pour ouvrir la fiche</div>`, ev);
}

async function renderMap() {
  $("#continents").innerHTML = ["", ...CONT_ORDER].map(c => `<button class="chip ${S.continent === c && !S.country ? "on" : (S.continent === c ? "on" : "")}" data-c="${esc(c)}">${c ? esc(c) : "Monde"}</button>`).join("");
  $$("#continents button").forEach(b => b.onclick = () => { S.continent = b.dataset.c; S.country = ""; update(); });
  $$("#map-metric button").forEach(b => { b.classList.toggle("on", b.dataset.m === S.mapMetric); b.onclick = () => { S.mapMetric = b.dataset.m; render(); }; });

  const r = range(), pr = cmpRanges()[1];
  const cur = sel(["country", "continent"], r), prev = sel(["country", "continent"], S.period === "all" ? cmpRanges()[1] : pr);
  const curG = S.period === "all" ? sel(["country", "continent"], cmpRanges()[0]) : null;
  MAPVAL = new Map();
  cur.forEach(d => { if (!d.cc) return; const v = MAPVAL.get(d.cc) || {n: 0, s: 0, pn: 0, ps: 0}; v.n++; v.s += d.a || 0; MAPVAL.set(d.cc, v); });
  prev.forEach(d => { if (!d.cc) return; const v = MAPVAL.get(d.cc) || {n: 0, s: 0, pn: 0, ps: 0}; v.pn++; v.ps += d.a || 0; MAPVAL.set(d.cc, v); });

  if (curG) { MAPVAL.forEach(v => v.gn = 0); curG.forEach(d => { const v = MAPVAL.get(d.cc); if (v) v.gn++; }); MAPVAL.forEach(v => { v.gcur = v.gn; }); }
  renderRanking(cur);
  renderScope(r, prevRange(r));

  if (!(await ensureMap())) return;
  const dark = isDark();
  const seq = dark ? ["#1d3150", "#184f95", "#2a78d6", "#6da7ec", "#cde2fb"] : ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"];
  const val = iso => { const v = MAPVAL.get(iso); if (!v) return null;
    return S.mapMetric === "amount" ? (v.s || null) : S.mapMetric === "count" ? (v.n || null) : (v.n + v.pn >= 2 ? growth(v.gcur ?? v.n, v.pn) : null); };
  const vals = [...MAPVAL.keys()].map(val).filter(v => v != null && isFinite(v));
  let color, legendHTML;
  if (S.mapMetric === "growth") {
    const ramp = dark ? ["#e66767", "#383835", "#3987e5"] : ["#d03b3b", "#f0efec", "#1c5cab"];
    const sc = d3.scaleDiverging([-1, 0, 2], d3.interpolateRgbBasis(ramp)).clamp(true);
    color = v => v === Infinity ? ramp[2] : sc(v);
    legendHTML = `<span>−100 %</span><span class="g" style="background:linear-gradient(90deg,${ramp.join(",")})"></span><span>+200 % et plus</span>`;
  } else {
    const lo = d3.min(vals) || 1, hi = d3.max(vals) || 1;
    const sc = (S.mapMetric === "amount" ? d3.scaleSequentialLog : d3.scaleSequentialSqrt)([Math.max(lo, S.mapMetric === "amount" ? 0.1 : 1), Math.max(hi, lo * 1.01 + 0.01)], d3.interpolateRgbBasis(seq)).clamp(true);
    color = v => sc(v);
    const f = S.mapMetric === "amount" ? fmtM : fmtN;
    legendHTML = `<span>${f(lo)}</span><span class="g" style="background:linear-gradient(90deg,${seq.join(",")})"></span><span>${f(hi)}</span><span style="margin-left:10px">${S.mapMetric === "amount" ? "montant levé" : "nombre de levées"}</span>`;
  }
  $("#map-legend").innerHTML = legendHTML + `<span style="margin-left:auto">Gris : aucune levée repérée</span>`;
  const fill = iso => { const v = iso && val(iso); return v != null && v !== false ? color(v) : "var(--map-empty)"; };
  MAP.g.selectAll("path.country").attr("fill", d => fill(d.iso))
    .classed("dim", d => !!S.continent && (!d.iso || META.countries[d.iso]?.ct !== S.continent))
    .classed("sel", d => d.iso && d.iso === S.country);
  MAP.g.selectAll("circle.dot").attr("fill", d => fill(d[0])).attr("stroke", d => d[0] === S.country ? "var(--ink)" : null);

  // zoom sur la zone choisie
  let target = MAP.feats;
  if (S.country) target = MAP.feats.filter(f => f.iso === S.country);
  else if (S.continent) target = MAP.feats.filter(f => f.iso && META.countries[f.iso]?.ct === S.continent);
  let k = 1, tx = 0, ty = 0;
  if (target.length && target !== MAP.feats) {
    const [[x0, y0], [x1, y1]] = MAP.path.bounds({type: "FeatureCollection", features: target.map(f => f.main)});
    k = Math.min(S.country ? 6 : 4.5, 0.85 / Math.max((x1 - x0) / MAP.W, (y1 - y0) / MAP.H));
    k = Math.max(1, k);
    tx = MAP.W / 2 - k * (x0 + x1) / 2; ty = MAP.H / 2 - k * (y0 + y1) / 2;
  } else if (S.country && SMALL[S.country]) {
    const [px, py] = MAP.proj(SMALL[S.country]); k = 5; tx = MAP.W / 2 - k * px; ty = MAP.H / 2 - k * py;
  }
  MAP.k = k;
  MAP.g.transition().duration(650).attr("transform", `translate(${tx},${ty}) scale(${k})`);
  MAP.g.selectAll("circle.dot").transition().duration(650).attr("r", 4 / Math.sqrt(k));
}

function renderRanking(cur) {
  const pool = [...MAPVAL.entries()].filter(([iso, v]) => v.n > 0 && (!S.continent || META.countries[iso]?.ct === S.continent));
  const key = S.mapMetric === "count" ? (v => v.n) : S.mapMetric === "growth" ? (v => (v.n + v.pn >= 3 ? growth(v.gcur ?? v.n, v.pn) : -Infinity)) : (v => v.s);
  pool.sort((a, b) => key(b[1]) - key(a[1]));
  $("#rank-title").textContent = S.continent ? `Classement · ${S.continent}` : "Classement des pays";
  const unknown = cur.filter(d => !d.cc && (!S.continent)).length;
  $("#rank-hint").textContent = `Clique sur un pays pour ouvrir sa fiche.${unknown ? ` ${fmtN(unknown)} levées sans pays identifié.` : ""}`;
  const items = pool.slice(0, 18).map(([iso, v]) => ({key: iso, label: `${flag(iso)} ${esc(cname(iso))}`,
    value: S.mapMetric === "growth" ? Math.max(0, isFinite(key(v)) ? key(v) : 3) : key(v),
    extra: S.mapMetric === "count" ? fmtN(v.n) : S.mapMetric === "growth" ? fmtG(growth(v.gcur ?? v.n, v.pn)) : fmtM(v.s)}));
  hbars($("#rank"), items, {selected: S.country, onClick: d => pickCountry(d.key), color: () => "var(--s1)"});
}

function renderScope(r, pr) {
  const cur = sel([], r), prev = sel([], pr);
  const title = S.country ? cname(S.country) : S.continent || "Monde";
  const crumbs = [`<button data-go="world">Monde</button>`];
  if (S.continent) crumbs.push(S.country ? `<button data-go="cont">${esc(S.continent)}</button>` : esc(S.continent));
  if (S.country) crumbs.push(esc(cname(S.country)));
  const el = $("#scope");
  el.innerHTML = `
    <div class="scope-title"><span class="flag">${S.country ? flag(S.country) : "🌍"}</span>
      <div><div class="crumbs">${crumbs.join(" › ")}</div><h2>${esc(title)}</h2></div><div class="spacer"></div>
      <button class="btn small" id="sc-explore">Voir le détail dans l'Explorer →</button></div>
    <div class="grid kpis five">${kpiRow(cur, prev)}</div>
    <div class="grid two" style="margin-top:16px">
      <div class="card"><div class="card-head"><div><h2>Levées dans le temps</h2><p class="hint">Glisse pour zoomer · par secteur</p></div>
        <div class="seg" id="sc-metric"><button data-m="amount">Montant</button><button data-m="count">Nombre</button></div></div>
        <div class="chart" id="sc-time"></div><div class="legend" id="sc-legend"></div></div>
      <div class="card"><h2>Secteurs</h2><p class="hint">Clique pour filtrer tout le dashboard.</p><div id="sc-sectors"></div></div>
    </div>
    <div class="grid three" style="margin-top:16px">
      <div class="card"><h2>Étapes</h2><p class="hint">Nombre de levées par étape.</p><div class="hbars" id="sc-stages"></div></div>
      <div class="card"><h2>Tendances qui montent ici</h2><p class="hint">${CMP_LABEL()}.</p><div id="sc-themes"></div></div>
      <div class="card"><h2>Investisseurs actifs</h2><p class="hint">Clique pour voir leurs deals.</p><div class="hbars" id="sc-inv"></div></div>
    </div>
    <div class="card toplist" style="margin-top:16px"><h2>Les plus grosses levées</h2><p class="hint">${esc(title)} · ${PERIOD_LABEL[S.period]}. Clique pour la fiche complète.</p><div id="sc-top"></div></div>`;
  $$("[data-go]", el).forEach(b => b.onclick = () => { if (b.dataset.go === "world") { S.continent = ""; S.country = ""; } else S.country = ""; update(); });
  $("#sc-explore").onclick = () => $(`#tabs button[data-tab="explorer"]`).click();
  bindDeals(el);
  $$("#sc-metric button").forEach(b => { b.classList.toggle("on", b.dataset.m === S.metric); b.onclick = () => { S.metric = b.dataset.m; render(); }; });
  const keys = [...SECTOR_TOP, "Autres", "Non classé"];
  timeChart($("#sc-time"), cur, r, {metric: S.metric, keys, keyFn: sectorKey, colorFn: sectorColor, onBrush: brushTo});
  const secCounts = d3.rollup(cur.map(sectorKey), v => v.length, k => k);
  legend($("#sc-legend"), keys.filter(k => secCounts.get(k)), {colorFn: sectorColor, active: S.sector || null,
    onClick: k => { if (k !== "Autres" && k !== "Non classé") { S.sector = S.sector === k ? "" : k; update(); } }});
  sectorDonut($("#sc-sectors"), sel(["sector"], r));
  stageBars($("#sc-stages"), sel(["stage"], r));
  const [cr, cpr] = cmpRanges();
  const rows = growthRows(sel(["theme"], cr), sel(["theme"], cpr), d => d.th, k => esc(k), 2);
  growthTable($("#sc-themes"), rows, row => { S.theme = row.key; update(); $(`#tabs button[data-tab="vogue"]`).click(); });
  investorBars($("#sc-inv"), cur);
  topList($("#sc-top"), cur, {limit: 20});
}

function brushTo(a, b) { S.period = "custom"; S.from = a; S.to = b; update(); }

function sectorDonut(el, arr) {
  const c = d3.rollup(arr.flatMap(d => d.sec.length ? d.sec : ["Non classé"]), v => v.length, k => k);
  const items = [...c].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({key: k, label: k, value: v, color: sectorColor(k)}));
  donut(el, items, {selected: S.sector, onClick: d => { if (d.key !== "Non classé") { S.sector = S.sector === d.key ? "" : d.key; update(); } }});
}
function stageBars(el, arr) {
  const c = d3.rollup(arr, v => ({n: v.length, med: d3.median(v.filter(d => d.a != null), d => d.a)}), d => d.st);
  const items = STAGE_ORDER.filter(s => c.get(s)).map(s => ({key: s, label: esc(s), value: c.get(s).n,
    extra: `${fmtN(c.get(s).n)} · méd. ${fmtM(c.get(s).med)}`}));
  hbars(el, items, {selected: S.stage, onClick: d => { S.stage = S.stage === d.key ? "" : d.key; update(); }, color: () => "var(--s7)"});
}
function investorBars(el, arr) {
  const c = d3.rollup(arr.flatMap(d => d.inv), v => v.length, k => k);
  const items = [...c].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({key: k, label: esc(k), value: v}));
  hbars(el, items, {selected: S.q, onClick: d => { S.q = S.q === d.key ? "" : d.key; update(); }, color: () => "var(--s3)"});
}

/* ------------------------------------------------------------------ EXPLORER */
function renderExplorer() {
  const r = range(), pr = prevRange(r);
  const cur = sel([], r), prev = sel([], pr);
  $("#x-kpis").innerHTML = kpiRow(cur, prev);
  bindDeals($("#x-kpis"));
  $$("#x-metric button").forEach(b => { b.classList.toggle("on", b.dataset.m === S.metric); b.onclick = () => { S.metric = b.dataset.m; render(); }; });
  const keys = [...SECTOR_TOP, "Autres", "Non classé"];
  timeChart($("#x-time"), cur, r, {metric: S.metric, keys, keyFn: sectorKey, colorFn: sectorColor, onBrush: brushTo, height: 290});
  const sums = d3.rollup(cur, v => S.metric === "amount" ? d3.sum(v, d => d.a || 0) : v.length, sectorKey);
  legend($("#x-time-legend"), keys.filter(k => sums.get(k)), {colorFn: sectorColor, active: S.sector || null,
    values: k => S.metric === "amount" ? fmtM(sums.get(k)) : fmtN(sums.get(k)),
    onClick: k => { if (k !== "Autres" && k !== "Non classé") { S.sector = S.sector === k ? "" : k; update(); } }});
  const [cr, cpr] = cmpRanges();
  $("#x-grow-hint").textContent = `${CMP_LABEL()} (au moins 3 levées).`;
  growthTable($("#x-grow-sec"), growthRows(sel(["sector"], cr), sel(["sector"], cpr), d => d.sec, k => esc(k)),
    row => { S.sector = row.key; update(); });
  growthTable($("#x-grow-cc"), growthRows(sel(["country"], cr), sel(["country"], cpr), d => d.cc ? [d.cc] : [], k => `${flag(k)} ${esc(cname(k))}`),
    row => { S.country = row.key; S.continent = META.countries[row.key]?.ct || ""; update(); });
  histogram($("#x-hist"), sel(["amount"], r));
  stageBars($("#x-stages"), sel(["stage"], r));
  dealTable(cur);
}

const BINS = [0.05, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 1e9];
function histogram(el, arr) {
  const counts = BINS.slice(0, -1).map((lo, i) => ({lo, hi: BINS[i + 1], n: arr.filter(d => d.a != null && d.a >= (i ? lo : 0) && d.a < BINS[i + 1]).length}));
  const W = Math.max(300, el.clientWidth || 500), H = 210, m = {t: 8, r: 4, b: 34, l: 36};
  const x = d3.scaleBand(counts.map((_, i) => i), [m.l, W - m.r]).padding(0.15);
  const y = d3.scaleLinear([0, d3.max(counts, c => c.n) || 1], [H - m.b, m.t]).nice();
  const lab = c => c.hi >= 1e9 ? `${fmtM(c.lo)}+` : c.lo < 0.25 ? `< ${fmtM(c.hi)}` : fmtM(c.lo);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", "Répartition des tailles de tickets");
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(d3.format("~s"))).call(g => g.select(".domain").remove());
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickFormat(i => i % 2 === 0 ? lab(counts[i]) : "").tickSizeOuter(0));
  const isSel = c => S.amin != null && S.amax != null && Math.abs(S.amin - (c.lo < 0.25 ? 0.05 : c.lo)) < 1e-6 && Math.abs(S.amax - c.hi) < 1e-6;
  const any = counts.some(isSel);
  svg.append("g").selectAll("rect").data(counts).join("rect")
    .attr("x", (_, i) => x(i)).attr("width", x.bandwidth()).attr("y", c => y(c.n)).attr("height", c => Math.max(0, y(0) - y(c.n)))
    .attr("rx", 3).attr("fill", "var(--s1)").attr("opacity", c => any && !isSel(c) ? 0.3 : 1).style("cursor", "pointer")
    .on("mousemove", (ev, c) => tip.show(`<div class="tt">${c.hi >= 1e9 ? fmtM(c.lo) + " et plus" : (c.lo < 0.25 ? "moins de " + fmtM(c.hi) : fmtM(c.lo) + " – " + fmtM(c.hi))}</div><div class="tr"><span>Levées</span><span>${fmtN(c.n)}</span></div><div class="meta">Clique pour cibler</div>`, ev))
    .on("mouseleave", () => tip.hide())
    .on("click", (ev, c) => { tip.hide(); if (isSel(c)) { S.amin = S.amax = null; } else { S.amin = c.lo < 0.25 ? 0.05 : c.lo; S.amax = c.hi >= 1e9 ? null : c.hi; } update(); });
  el.replaceChildren(svg.node());
}

const COLS = [
  {k: "d", l: "Date", v: d => d.ts, f: d => `<span class="mono">${fmtD(d.ts)}</span>`},
  {k: "c", l: "Entreprise", v: d => (d.c || "").toLowerCase(), f: d => `<strong>${esc(d.c || "—")}</strong><div class="meta" style="max-width:380px">${esc(d.t)}</div>`},
  {k: "a", l: "Montant", v: d => d.a ?? -1, f: d => d.a != null ? `<span class="amt">${esc(d.al || fmtM(d.a))}</span><div class="meta">≈ ${fmtM(d.a)}</div>` : "–"},
  {k: "st", l: "Étape", v: d => STAGE_ORDER.indexOf(d.st), f: d => `<span class="tag round">${esc(d.st)}</span>`},
  {k: "cc", l: "Pays", v: d => cname(d.cc), f: d => d.cc ? `${flag(d.cc)} ${esc(cname(d.cc))}` : `<span class="meta">?</span>`},
  {k: "sec", l: "Secteurs", v: d => d.sec.join(), f: d => d.sec.slice(0, 3).map(s => `<span class="tag">${esc(s)}</span>`).join("")},
  {k: "n", l: "Sources", v: d => d.n, f: d => `<span class="mono">${d.n}</span>${d.o ? ` <span class="pill tech" title="Confirmé par un dépôt officiel">officiel</span>` : ""}`},
];
let TABLE_ROWS = [];
function dealTable(cur) {
  const col = COLS.find(c => c.k === S.sort.key) || COLS[0];
  TABLE_ROWS = cur.slice().sort((a, b) => { const x = col.v(a), y = col.v(b); return (x < y ? -1 : x > y ? 1 : 0) * S.sort.dir; });
  const per = 50, pages = Math.max(1, Math.ceil(TABLE_ROWS.length / per));
  S.page = Math.min(S.page, pages - 1);
  const rows = TABLE_ROWS.slice(S.page * per, S.page * per + per);
  $("#x-table-hint").textContent = `${fmtN(TABLE_ROWS.length)} levées. Clique sur une ligne pour la fiche, sur un titre de colonne pour trier.`;
  $("#x-table").innerHTML = `<thead><tr>${COLS.map(c => `<th><button data-k="${c.k}">${c.l}${S.sort.key === c.k ? (S.sort.dir > 0 ? " ↑" : " ↓") : ""}</button></th>`).join("")}</tr></thead>
    <tbody>${rows.map(d => `<tr data-deal="${esc(d.id)}">${COLS.map(c => `<td>${c.f(d)}</td>`).join("")}</tr>`).join("") ||
    `<tr><td colspan="7" class="empty">Aucune levée avec ces filtres.</td></tr>`}</tbody>`;
  $$("#x-table th button").forEach(b => b.onclick = () => {
    S.sort = {key: b.dataset.k, dir: S.sort.key === b.dataset.k ? -S.sort.dir : (b.dataset.k === "c" || b.dataset.k === "cc" ? 1 : -1)};
    dealTable(cur);
  });
  bindDeals($("#x-table"));
  $("#x-pager").innerHTML = pages > 1 ? `<button class="btn small" id="pg-prev" ${S.page ? "" : "disabled"}>← Précédent</button> Page ${S.page + 1} / ${pages}
    <button class="btn small" id="pg-next" ${S.page < pages - 1 ? "" : "disabled"}>Suivant →</button>` : "";
  if ($("#pg-prev")) { $("#pg-prev").onclick = () => { S.page--; dealTable(cur); }; $("#pg-next").onclick = () => { S.page++; dealTable(cur); }; }
}
$("#x-csv").onclick = () => {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["date", "entreprise", "montant_annonce", "montant_eur_millions", "etape", "pays", "continent", "secteurs", "tendances", "investisseurs", "sources", "nb_sources", "titre", "lien"].join(",")]
    .concat(TABLE_ROWS.map(d => [d.d, d.c, d.al, d.a, d.st, cname(d.cc), d.ct, d.sec.join(" | "), d.th.join(" | "), d.inv.join(" | "), d.src.join(" | "), d.n, d.t, d.u].map(q).join(",")));
  const blob = new Blob(["﻿" + lines.join("\n")], {type: "text/csv;charset=utf-8"});
  const a = Object.assign(document.createElement("a"), {href: URL.createObjectURL(blob), download: `radar-vc-levees-${new Date().toISOString().slice(0, 10)}.csv`});
  document.body.append(a); a.click(); a.remove();
};

/* ------------------------------------------------------------------ TENDANCES EN VOGUE */
function themeRows(r, pr) {
  return growthRows(sel(["theme"], r), sel(["theme"], pr), d => d.th, k => k, 1);
}
function badge(row) {
  const g = Math.exp(row.score) - 1;
  if (row.pn === 0 && row.n >= 2) return `<span class="badge fire">Nouvelle vague</span>`;
  if (g > 0.5) return `<span class="badge fire">En feu</span>`;
  if (g > 0.12) return `<span class="badge upb">En hausse</span>`;
  if (g < -0.12) return `<span class="badge downb">En baisse</span>`;
  return `<span class="badge flat">Stable</span>`;
}
function sparkline(arr, r) {
  const nb = 24, step = (r[1] - r[0]) / nb;
  const v = Array(nb).fill(0);
  arr.forEach(d => { const i = Math.floor((d.ts - r[0]) / step); if (i >= 0 && i < nb) v[i]++; });
  const W = 240, H = 36, x = d3.scaleLinear([0, Math.max(1, v.length - 1)], [2, W - 2]), y = d3.scaleLinear([0, d3.max(v) || 1], [H - 3, 3]);
  const line = d3.line((_, i) => x(i), y).curve(d3.curveMonotoneX);
  const area = d3.area((_, i) => x(i), H - 1, y).curve(d3.curveMonotoneX);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${area(v)}" fill="var(--s1)" opacity=".12"/><path d="${line(v)}" fill="none" stroke="var(--s1)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderVogue() {
  const r = range(), [cr, cpr] = cmpRanges();
  if (S.theme) { $("#vogue-home").hidden = true; return renderThemeDetail(r, cr, cpr); }
  $("#vogue-detail").innerHTML = ""; $("#vogue-home").hidden = false;
  const rows = themeRows(cr, cpr).sort((a, b) => b.score - a.score);
  $("#v-hint").textContent = `Chiffres et évolution : ${CMP_LABEL()}. À droite : ce qui accélère. En haut : ce qui attire le plus d'argent. Taille : nombre de levées. Clique sur une bulle.`;
  matrix($("#v-matrix"), rows.filter(x => x.n > 0));
  const pool = sel(["theme"], r);
  $("#v-cards").innerHTML = rows.filter(x => x.n > 0).map(row => `<button class="theme" data-th="${esc(row.key)}">
    ${badge(row)}<h3>${esc(row.key)}</h3>
    <div class="nums"><span>${fmtN(row.n)} levée${row.n > 1 ? "s" : ""}</span><span>${row.s ? fmtM(row.s) : "montant n.c."}</span><span>${fmtG(row.g)}</span></div>
    ${sparkline(pool.filter(d => d.th.includes(row.key)), r)}</button>`).join("") || `<div class="card empty">Aucune tendance repérée sur cette période.</div>`;
  $$("#v-cards .theme").forEach(b => b.onclick = () => { S.theme = b.dataset.th; update(); scrollTo({top: 0, behavior: "smooth"}); });
}

function matrix(el, rows) {
  const W = Math.max(320, el.clientWidth || 900), H = 380, m = {t: 18, r: 24, b: 40, l: 64};
  if (!rows.length) { el.innerHTML = `<div class="empty">Pas encore assez de données.</div>`; return; }
  const gx = r => r.g === Infinity ? 3 : Math.max(-1, Math.min(3, r.g));
  const x = d3.scaleLinear([Math.min(-0.5, d3.min(rows, gx)), Math.max(1, d3.max(rows, gx))], [m.l, W - m.r]).nice();
  const ys = rows.map(r => Math.max(0.5, r.s));
  const y = d3.scaleLog([d3.min(ys) * 0.8, d3.max(ys) * 1.3], [H - m.b, m.t]);
  const rad = d3.scaleSqrt([0, d3.max(rows, r => r.n)], [4, 30]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", "Matrice des tendances : croissance et montants");
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickFormat(""));
  const [y0, y1] = y.domain(), tv = [];
  for (let p = Math.floor(Math.log10(y0)); p <= Math.ceil(Math.log10(y1)); p++) [1, 3].forEach(k => { const v = k * 10 ** p; if (v >= y0 && v <= y1) tv.push(v); });
  svg.selectAll(".gridline").remove();
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues(tv).tickSize(-(W - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues(tv).tickFormat(v => fmtM(v))).call(g => g.select(".domain").remove());
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(6).tickFormat(v => (v > 0 ? "+" : "") + Math.round(v * 100) + " %"));
  svg.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", "var(--muted)").attr("stroke-dasharray", "3 4");
  svg.append("text").attr("x", W - m.r).attr("y", H - m.b - 8).attr("text-anchor", "end").attr("fill", "var(--muted)").style("font", "11px Inter").text("accélère →");
  svg.append("text").attr("x", x(0) - 6).attr("y", H - m.b - 8).attr("text-anchor", "end").attr("fill", "var(--muted)").style("font", "11px Inter").text("← ralentit");
  const sorted = rows.slice().sort((a, b) => b.n - a.n);
  const g = svg.append("g").selectAll("g").data(sorted).join("g").attr("transform", r => `translate(${x(gx(r))},${y(Math.max(0.5, r.s))})`).style("cursor", "pointer")
    .on("mousemove", (ev, r) => tip.show(`<div class="tt">${esc(r.key)}</div><div class="tr"><span>Levées</span><span>${r.n} (préc. ${r.pn})</span></div>
      <div class="tr"><span>Montant</span><span>${fmtM(r.s)}</span></div><div class="tr"><span>Évolution</span><span>${fmtG(r.g)}</span></div>`, ev))
    .on("mouseleave", () => tip.hide()).on("click", (ev, r) => { tip.hide(); S.theme = r.key; update(); });
  g.append("circle").attr("r", r => rad(r.n)).attr("fill", r => gx(r) > 0 ? "var(--s1)" : "var(--other)").attr("fill-opacity", .75)
    .attr("stroke", "var(--panel)").attr("stroke-width", 2);
  const placed = [];
  g.filter((r, i) => i < 14).append("text").attr("x", r => rad(r.n) + 4).attr("y", 4).attr("fill", "var(--ink)").style("font", "600 11.5px Inter")
    .text(r => r.key).each(function (r) {
      const px = x(gx(r)) + rad(r.n) + 4, py = y(Math.max(0.5, r.s)), w = r.key.length * 6.4;
      if (px + w > W) d3.select(this).attr("x", -rad(r.n) - 4).attr("text-anchor", "end");
      const box = [px + (px + w > W ? -w - 2 * rad(r.n) - 8 : 0), py - 8, w, 14];
      if (placed.some(p => box[0] < p[0] + p[2] && box[0] + box[2] > p[0] && box[1] < p[1] + p[3] && box[1] + box[3] > p[1])) d3.select(this).remove();
      else placed.push(box);
    });
  el.replaceChildren(svg.node());
}

function renderThemeDetail(r, cr, cpr) {
  const cur = sel([], r), prev = sel([], prevRange(r));
  const row = themeRows(cr, cpr).find(x => x.key === S.theme) || {key: S.theme, n: cur.length, pn: prev.length, s: 0, ps: 0, g: 0, score: 0};
  const el = $("#vogue-detail");
  el.innerHTML = `
    <button class="linkbtn" id="th-back">← Toutes les tendances</button>
    <div class="scope-title"><div><div class="crumbs">Tendance ${badge(row)}</div><h2>${esc(S.theme)}</h2>
      <p class="meta" style="margin:4px 0 0">${fmtN(cur.length)} levées et ${fmtM(stats(cur).sum)} sur ${PERIOD_LABEL[S.period]}. Évolution du nombre de levées (${CMP_LABEL()}) : ${row.pn ? fmtG(row.g) : "aucune levée sur la période de comparaison"}.
      Affine avec la zone, l'étape et la barre de montant en haut.</p></div></div>
    <div class="grid kpis five">${kpiRow(cur, prev)}</div>
    <div class="grid two" style="margin-top:16px">
      <div class="card toplist"><h2>Les plus grosses levées</h2><p class="hint">Classées par montant. Clique pour la fiche.</p><div id="th-top"></div></div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Où ça se passe</h2><p class="hint">Clique sur un pays pour filtrer.</p><div class="hbars" id="th-cc"></div></div>
        <div class="card"><h2>Étapes</h2><div class="hbars" id="th-st"></div></div>
        <div class="card"><h2>Qui investit</h2><div class="hbars" id="th-inv"></div></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><div><h2>Dans le temps, par continent</h2><p class="hint">Glisse pour zoomer.</p></div>
      <div class="seg" id="th-metric"><button data-m="amount">Montant</button><button data-m="count">Nombre</button></div></div>
      <div class="chart" id="th-time"></div><div class="legend" id="th-legend"></div></div>`;
  $("#th-back").onclick = () => { S.theme = ""; update(); };
  bindDeals(el);
  topList($("#th-top"), cur, {limit: 30});
  const cc = d3.rollup(sel(["country"], r).filter(d => d.cc), v => ({n: v.length, s: d3.sum(v, d => d.a || 0)}), d => d.cc);
  hbars($("#th-cc"), [...cc].sort((a, b) => b[1].s - a[1].s || b[1].n - a[1].n).slice(0, 10).map(([k, v]) => ({key: k, label: `${flag(k)} ${esc(cname(k))}`, value: v.s || v.n, extra: `${fmtM(v.s)} · ${v.n}`})),
    {selected: S.country, onClick: d => { S.country = S.country === d.key ? "" : d.key; S.continent = S.country ? META.countries[S.country]?.ct || "" : S.continent; update(); }, color: () => "var(--s1)"});
  stageBars($("#th-st"), sel(["stage"], r));
  investorBars($("#th-inv"), cur);
  $$("#th-metric button").forEach(b => { b.classList.toggle("on", b.dataset.m === S.metric); b.onclick = () => { S.metric = b.dataset.m; render(); }; });
  const keys = [...CONT_ORDER, "Inconnu"];
  const cKey = d => d.ct || "Inconnu";
  timeChart($("#th-time"), cur, r, {metric: S.metric, keys, keyFn: cKey, colorFn: contColor, onBrush: brushTo});
  const present = new Set(cur.map(cKey));
  legend($("#th-legend"), keys.filter(k => present.has(k)), {colorFn: contColor, active: S.continent || null,
    onClick: k => { if (k !== "Inconnu") { S.continent = S.continent === k ? "" : k; S.country = ""; update(); } }});
}

/* ------------------------------------------------------------------ FICHE LEVÉE */
const favDeals = () => new Set(store.get("favDeals", []));
function openDeal(id) {
  const d = DEALS.find(x => x.id === id);
  if (!d) return;
  const key = (d.c || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const history = key ? DEALS.filter(x => x.id !== d.id && (x.c || "").toLowerCase().replace(/[^a-z0-9]/g, "") === key).sort((a, b) => a.ts - b.ts) : [];
  const simil = DEALS.filter(x => x.id !== d.id && x.k === d.k && Math.abs(x.ts - d.ts) < 365 * DAY && (d.th[0] ? x.th.includes(d.th[0]) : x.sec.some(s => d.sec.includes(s))))
    .map(x => ({x, score: (x.st === d.st ? 0 : 1) + (x.a && d.a ? Math.abs(Math.log(x.a / d.a)) : 2) + (x.ct === d.ct ? 0 : 0.5)}))
    .sort((a, b) => a.score - b.score).slice(0, 5).map(o => o.x);
  const fav = favDeals().has(d.id);
  const conf = `<span class="conf">${[1, 2, 3, 4].map(i => `<i class="${d.n >= i ? "on" : ""}"></i>`).join("")}</span>`;
  const links = [d.u, ...(d.alt || [])].filter(Boolean);
  const mini = x => `<div class="deal" data-deal="${esc(x.id)}" style="grid-template-columns:1fr auto;cursor:pointer"><div><span class="t">${flag(x.cc)} ${esc(x.c || x.t)}</span>
    <div class="meta">${esc(x.st)} · ${fmtD(x.ts)}</div></div><div class="amt">${x.a != null ? esc(x.al || fmtM(x.a)) : "–"}</div></div>`;
  $("#deal-in").innerHTML = `
    <div class="dlg-top"><span style="font-size:34px;line-height:1">${flag(d.cc)}</span><h2>${esc(d.c || "Levée")}</h2>
      <button class="star ${fav ? "on" : ""}" id="dl-star" aria-label="Suivre cette levée" style="font-size:24px">★</button>
      <button class="btn small" id="dl-close" aria-label="Fermer">✕</button></div>
    <p class="meta" style="margin:8px 0 0">${esc(d.t)}</p>
    <div class="dlg-grid">
      <div><small>Montant annoncé</small><strong>${d.a != null ? esc(d.al || fmtM(d.a)) : "Non communiqué"}</strong>${d.a != null && d.cur !== "EUR" ? `<div class="meta">≈ ${fmtM(d.a)}</div>` : ""}</div>
      <div><small>Étape</small><strong>${esc(d.st)}</strong></div>
      <div><small>Date</small><strong>${fmtD(d.ts)}</strong></div>
      <div><small>Pays</small><strong>${d.cc ? esc(cname(d.cc)) : "Non identifié"}</strong>${d.ct ? `<div class="meta">${esc(d.ct)}</div>` : ""}</div>
      <div><small>Secteurs</small><strong style="font-size:13.5px">${esc(d.sec.join(", ") || "—")}</strong></div>
      <div><small>Fiabilité</small><strong>${d.n} source${d.n > 1 ? "s" : ""}</strong>${conf}${d.o ? `<div class="meta">dépôt officiel SEC</div>` : ""}</div>
    </div>
    ${d.th.length ? `<div><small class="meta">Tendances</small><div>${d.th.map(t => `<button class="tag theme" data-th="${esc(t)}" style="cursor:pointer">${esc(t)}</button>`).join("")}</div></div>` : ""}
    ${d.inv.length ? `<div style="margin-top:10px"><small class="meta">Investisseurs repérés</small><div>${d.inv.map(t => `<button class="tag inv" data-inv="${esc(t)}" style="cursor:pointer">${esc(t)}</button>`).join("")}</div></div>` : ""}
    <div style="margin-top:12px"><small class="meta">Sources : ${esc(d.src.join(", "))}</small>
      <ul class="list" style="margin-top:4px">${links.map((u, i) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${i ? "Autre article" : "Lire l'article"} ↗</a></li>`).join("")}</ul></div>
    ${history.length ? `<h3 style="font:700 15px var(--display);margin:18px 0 4px">Historique de financement de ${esc(d.c)}</h3><div class="toplist">${history.map(mini).join("")}</div>` : ""}
    ${simil.length ? `<h3 style="font:700 15px var(--display);margin:18px 0 4px">Levées similaires</h3><div class="toplist">${simil.map(mini).join("")}</div>` : ""}`;
  const dlg = $("#deal");
  $("#dl-close").onclick = () => dlg.close();
  $("#dl-star").onclick = e => {
    const f = favDeals(); f.has(d.id) ? f.delete(d.id) : f.add(d.id); store.set("favDeals", [...f]);
    e.target.classList.toggle("on"); if (S.view === "favoris") renderFavDeals();
  };
  $$("[data-th]", $("#deal-in")).forEach(b => b.onclick = () => { dlg.close(); S.theme = b.dataset.th; update(); $(`#tabs button[data-tab="vogue"]`).click(); });
  $$("[data-inv]", $("#deal-in")).forEach(b => b.onclick = () => { dlg.close(); S.q = b.dataset.inv; update(); $(`#tabs button[data-tab="explorer"]`).click(); });
  bindDeals($("#deal-in"));
  if (!dlg.open) dlg.showModal();
  $("#deal-in").scrollTop = 0;
}
$("#deal").addEventListener("click", e => { if (e.target.id === "deal") e.target.close(); });

function renderFavDeals() {
  const f = favDeals();
  const list = DEALS.filter(d => f.has(d.id));
  const el = $("#fav-deals");
  if (!el) return;
  el.innerHTML = list.length ? list.map(d => `<div class="deal" data-deal="${esc(d.id)}" style="grid-template-columns:1fr auto;cursor:pointer"><div><span class="t">${flag(d.cc)} ${esc(d.c || d.t)}</span>
    <div class="meta">${esc(d.st)} · ${fmtD(d.ts)}</div></div><div class="amt">${d.a != null ? esc(d.al || fmtM(d.a)) : "–"}</div></div>`).join("")
    : `<div class="empty" style="padding:16px">Aucune levée suivie pour l'instant.</div>`;
  bindDeals(el);
}

window.RADARX = {openDeal, state: S};
load();
})();
