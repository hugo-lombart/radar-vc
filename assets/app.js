const $ = s => document.querySelector(s);
const store = {
  get(k, d){ try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const DAY = 864e5, now = Date.now();
const daysAgo = d => (now - new Date(d).getTime()) / DAY;
const fmtDate = d => new Date(d).toLocaleDateString("fr-FR", {day:"numeric", month:"short"});
const fmtEur = m => m >= 1000 ? (m/1000).toFixed(1).replace(".", ",") + " Md€" : Math.round(m).toLocaleString("fr-FR") + " M€";
const pct = (a, b) => b ? Math.round((a - b) / b * 100) : null;
const delta = (a, b, label) => { const p = pct(a, b); if (p === null) return ""; return `<span class="${p >= 0 ? "up" : "down"}">${p >= 0 ? "▲" : "▼"} ${Math.abs(p)} %</span> vs ${label}`; };

/* Thème */
const applyTheme = t => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
applyTheme(store.get("theme", null));
$("#theme").onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const t = dark ? "light" : "dark"; store.set("theme", t); applyTheme(t);
};

/* Onglets */
document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => {
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll("#views > section").forEach(s => s.hidden = s.id !== b.dataset.tab);
  if (b.dataset.tab === "favoris") renderFav();
  document.dispatchEvent(new CustomEvent("radar:tab", {detail: b.dataset.tab}));
});
const flag = cc => cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : "";

let D = {articles: [], signals: [], launches: [], sources: []};
const lastVisit = store.get("lastVisit", 0);
let favs = new Set(store.get("favs", []));

fetch("data/radar.json?" + Date.now()).then(r => r.ok ? r.json() : Promise.reject(r.status))
  .then(d => { D = d; init(); store.set("lastVisit", now); })
  .catch(() => { $("#updated").textContent = "Pas encore de données : lance le workflow dans l'onglet Actions de GitHub."; init(); });
window.RADAR = { store, esc };

function init(){
  if (D.updated) $("#updated").textContent = "Mis à jour le " + new Date(D.updated).toLocaleString("fr-FR", {dateStyle:"medium", timeStyle:"short"});
  $("#n-actus").textContent = D.articles.length;
  $("#n-signaux").textContent = D.signals.length;
  $("#n-fav").textContent = favs.size;
  const sectors = [...new Set(D.articles.flatMap(a => a.sectors))].sort();
  $("#f-sector").innerHTML += sectors.map(s => `<option>${esc(s)}</option>`).join("");
  const rounds = [...new Set(D.articles.map(a => a.round).filter(Boolean))].sort();
  $("#f-round").innerHTML += rounds.map(s => `<option>${esc(s)}</option>`).join("");
  const depts = [...new Set(D.signals.map(s => s.dept).filter(Boolean))].sort();
  $("#s-dept").innerHTML += depts.map(s => `<option>${esc(s)}</option>`).join("");
  D.signals.sort((a, b) => b.date.localeCompare(a.date) || (b.press ? 1 : 0) - (a.press ? 1 : 0));
  renderRadar(); renderFeed(); renderSignals(); renderTrends(); renderSources();
}

/* ---------- Radar ---------- */
function renderRadar(){
  const deals = D.articles.filter(a => a.deal);
  const w1 = deals.filter(a => daysAgo(a.date) <= 7), w0 = deals.filter(a => daysAgo(a.date) > 7 && daysAgo(a.date) <= 14);
  const sum = arr => arr.reduce((s, a) => s + (a.amount ? a.amount.eur_m : 0), 0);
  $("#k-deals").textContent = w1.length;
  $("#k-deals-d").innerHTML = delta(w1.length, w0.length, "sem. préc.");
  $("#k-amount").textContent = fmtEur(sum(w1));
  $("#k-amount-d").innerHTML = delta(sum(w1), sum(w0), "sem. préc.");
  const s1 = D.signals.filter(s => daysAgo(s.date) <= 7);
  $("#k-signals").textContent = s1.length;
  $("#k-signals-d").textContent = s1.filter(s => s.tech).length + " au profil tech";

  // Thermomètre : volume de deals vs moyenne hebdo de l'historique
  const weeks = Math.max(1, Math.min(6, Math.ceil(Math.max(...D.articles.map(a => daysAgo(a.date)), 7) / 7)));
  const avg = deals.length / weeks || 1;
  const ratio = Math.max(0, Math.min(2, w1.length / avg));
  const label = ratio > 1.3 ? "Brûlant" : ratio > 1.05 ? "Chaud" : ratio > 0.8 ? "Normal" : ratio > 0.5 ? "Frais" : "Glacial";
  $("#k-temp").textContent = deals.length ? label : "–";
  $("#k-temp-b").style.left = (ratio / 2 * 100) + "%";
  $("#k-temp-d").textContent = deals.length ? `Activité à ${Math.round(ratio * 100)} % de la moyenne` : "";

  const top = w1.filter(a => a.amount).sort((a, b) => b.amount.eur_m - a.amount.eur_m).slice(0, 8);
  $("#top-deals").innerHTML = top.length ? top.map((a, i) => `
    <div class="deal"><div class="rank">${String(i + 1).padStart(2, "0")}</div>
      <div><a class="t" href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.title)}</a>
        <div>${a.round ? `<span class="tag round">${esc(a.round)}</span>` : ""}${a.sectors.slice(0, 2).map(s => `<span class="tag">${esc(s)}</span>`).join("")}<span class="tag">${esc(a.source)}</span></div></div>
      <div class="amt">${esc(a.amount.label)}</div></div>`).join("") : `<div class="empty">Aucune levée chiffrée cette semaine pour l'instant.</div>`;

  const inv = {};
  deals.filter(a => daysAgo(a.date) <= 30).forEach(a => a.investors.forEach(i => inv[i] = (inv[i] || 0) + 1));
  const invTop = Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxI = invTop[0]?.[1] || 1;
  $("#top-inv").innerHTML = invTop.length ? invTop.map(([n, c]) => bar(n, c, maxI)).join("") : `<div class="empty">Aucun fonds repéré.</div>`;

  const conf = D.signals.filter(s => s.press).slice(0, 6);
  $("#confirmed").innerHTML = conf.length ? conf.map(s => `
    <div class="deal" style="grid-template-columns:1fr"><div><a class="t" href="${esc(s.press.link)}" target="_blank" rel="noopener">${esc(s.name)}</a>
    <div class="meta">${esc(s.city)} · capital modifié le ${fmtDate(s.date)}</div></div></div>`).join("")
    : `<div class="empty" style="padding:16px">Pas de recoupement presse / BODACC pour l'instant.</div>`;
}

function bar(label, v, max, prev){
  return `<div class="bar"><div>${esc(label)}</div><div class="track"><div class="fill" style="width:${v / max * 100}%"></div>${prev != null ? `<div class="prev" style="width:${Math.min(100, prev / max * 100)}%"></div>` : ""}</div><div class="num">${v}${prev != null ? ` <span>(${prev})</span>` : ""}</div></div>`;
}

/* ---------- Actus ---------- */
let onlyDeals = false;
["#q", "#f-zone", "#f-sector", "#f-round"].forEach(s => $(s).addEventListener("input", renderFeed));
$("#f-deals").onclick = e => { onlyDeals = !onlyDeals; e.target.classList.toggle("on", onlyDeals); renderFeed(); };

function artHTML(a){
  const isNew = new Date(a.date).getTime() > lastVisit && lastVisit > 0;
  return `<article class="art ${a.deal ? "isdeal" : ""}">
    <div><h3><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
      <div class="meta">${isNew ? `<span class="tag new">Nouveau</span>` : ""}${a.country ? flag(a.country) + " " : ""}${esc(a.source)} · ${esc(a.zone)} · ${fmtDate(a.date)}</div></div>
    <div class="row">${a.amount ? `<span class="amt">${esc(a.amount.label)}</span>` : ""}<button class="star ${favs.has(a.id) ? "on" : ""}" data-id="${a.id}" aria-label="Favori">★</button></div>
    ${a.summary ? `<p>${esc(a.summary)}</p>` : ""}
    <div style="grid-column:1/-1">${a.round ? `<span class="tag round">${esc(a.round)}</span>` : ""}${(a.themes || []).slice(0, 2).map(t => `<span class="tag theme">${esc(t)}</span>`).join("")}${a.investors.map(i => `<span class="tag inv">${esc(i)}</span>`).join("")}${a.sectors.map(s => `<span class="tag">${esc(s)}</span>`).join("")}</div>
  </article>`;
}
function bindStars(root){
  root.querySelectorAll(".star").forEach(b => b.onclick = () => {
    const id = b.dataset.id; favs.has(id) ? favs.delete(id) : favs.add(id);
    store.set("favs", [...favs]); b.classList.toggle("on"); $("#n-fav").textContent = favs.size;
  });
}
function renderFeed(){
  const q = $("#q").value.trim().toLowerCase(), z = $("#f-zone").value, s = $("#f-sector").value, r = $("#f-round").value;
  const list = D.articles.filter(a =>
    (!q || (a.title + " " + a.summary + " " + a.investors.join(" ")).toLowerCase().includes(q)) &&
    (!z || a.zone === z) && (!s || a.sectors.includes(s)) && (!r || a.round === r) && (!onlyDeals || a.deal));
  $("#feed").innerHTML = list.length ? list.slice(0, 200).map(artHTML).join("") : `<div class="empty">Aucun article ne correspond.</div>`;
  bindStars($("#feed"));
}
function renderFav(){
  const list = D.articles.filter(a => favs.has(a.id));
  $("#fav-feed").innerHTML = list.length ? list.map(artHTML).join("") : `<div class="empty">Pas encore de favoris.</div>`;
  bindStars($("#fav-feed"));
}

/* ---------- Signaux ---------- */
let sTech = true, sSas = true;
$("#sq").addEventListener("input", renderSignals); $("#s-dept").addEventListener("input", renderSignals);
$("#s-tech").onclick = e => { sTech = !sTech; e.target.classList.toggle("on", sTech); renderSignals(); };
$("#s-sas").onclick = e => { sSas = !sSas; e.target.classList.toggle("on", sSas); renderSignals(); };
function renderSignals(){
  const q = $("#sq").value.trim().toLowerCase(), dp = $("#s-dept").value;
  const list = D.signals.filter(s => (!sTech || s.tech) && (!sSas || s.sas) && (!dp || s.dept === dp) &&
    (!q || (s.name + " " + s.city + " " + s.activity).toLowerCase().includes(q)));
  $("#sig-body").innerHTML = list.slice(0, 300).map(s => `<tr>
    <td class="mono">${fmtDate(s.date)}</td>
    <td><strong>${esc(s.name)}</strong><div class="meta">${esc(s.form)}</div>
      ${s.tech ? `<span class="pill tech">tech</span> ` : ""}${s.press ? `<a class="pill press" href="${esc(s.press.link)}" target="_blank" rel="noopener">vu dans la presse</a>` : ""}</td>
    <td>${esc(s.city)}${s.dept ? ` <span class="meta">(${esc(s.dept)})</span>` : ""}</td>
    <td class="mono">${s.capital ? Math.round(s.capital).toLocaleString("fr-FR") + " €" : "–"}</td>
    <td class="meta">${esc(s.activity || "–")}</td>
    <td>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="meta">Annonce</a>` : ""}${s.siren ? `<br><a href="https://annuaire-entreprises.data.gouv.fr/entreprise/${esc(s.siren)}" target="_blank" rel="noopener" class="meta">Fiche</a>` : ""}</td>
  </tr>`).join("");
  $("#sig-empty").hidden = list.length > 0;
  const us = D.us_signals || [];
  $("#sec-body").innerHTML = us.slice(0, 200).map(s => `<tr>
    <td class="mono">${fmtDate(s.date)}</td><td><strong>${esc(s.name)}</strong><div class="meta">${esc(s.industry)}</div></td>
    <td>${esc(s.city)}${s.state ? ` <span class="meta">(${esc(s.state)})</span>` : ""}</td>
    <td class="mono">${(s.sold_usd / 1e6).toLocaleString("fr-FR", {maximumFractionDigits: 1})} M$</td>
    <td class="mono">${s.offering_usd ? (s.offering_usd / 1e6).toLocaleString("fr-FR", {maximumFractionDigits: 1}) + " M$" : "–"}</td>
    <td><a href="${esc(s.url)}" target="_blank" rel="noopener" class="meta">Dépôt</a></td></tr>`).join("");
  $("#sec-empty").hidden = us.length > 0;
  $("#launches").innerHTML = (D.launches || []).slice(0, 12).map(l => `<li><a href="${esc(l.link)}" target="_blank" rel="noopener"><strong>${esc(l.title)}</strong></a> <span class="meta">${esc(l.summary)}</span></li>`).join("") || `<li class="meta">Aucun lancement récupéré.</li>`;
}

/* ---------- Tendances ---------- */
function renderTrends(){
  const cnt = (from, to) => { const c = {}; D.articles.filter(a => daysAgo(a.date) > from && daysAgo(a.date) <= to).forEach(a => a.sectors.forEach(s => c[s] = (c[s] || 0) + 1)); return c; };
  const now7 = cnt(-1, 7), prev7 = cnt(7, 14);
  const rows = Object.keys({...now7, ...prev7}).map(k => [k, now7[k] || 0, prev7[k] || 0]).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(r => Math.max(r[1], r[2])));
  $("#sectors").innerHTML = rows.length ? rows.map(([k, v, p]) => bar(k, v, max, p)).join("") : `<div class="empty">Pas assez de données.</div>`;

  const days = [...Array(14)].map((_, i) => D.articles.filter(a => a.deal && Math.floor(daysAgo(a.date)) === 13 - i).length);
  const mx = Math.max(1, ...days);
  $("#spark").innerHTML = days.map((v, i) => `<span class="${i === 13 ? "today" : ""}" style="height:${v / mx * 100}%" title="${v} levée(s)"></span>`).join("");

  const rc = {}; D.articles.filter(a => a.deal && a.round && daysAgo(a.date) <= 30).forEach(a => rc[a.round] = (rc[a.round] || 0) + 1);
  const rr = Object.entries(rc).sort((a, b) => b[1] - a[1]); const rm = rr[0]?.[1] || 1;
  $("#rounds").innerHTML = rr.length ? rr.map(([k, v]) => bar(k, v, rm)).join("") : `<div class="empty">Pas assez de données.</div>`;
}

function renderSources(){
  const all = D.sources || [], ok = all.filter(s => s.ok).length;
  $("#sources").innerHTML = `<strong>${ok}/${all.length} sources actives</strong>` + all.map(s => `<span class="src ${s.ok ? "" : "ko"}" title="${esc(s.error || s.count + " éléments")}"><i></i>${esc(s.name)}</span>`).join("");
}
