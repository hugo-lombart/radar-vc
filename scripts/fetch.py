#!/usr/bin/env python3
"""
Radar VC — collecte automatique des actualités et signaux faibles.

Ce script est lancé par GitHub Actions (voir .github/workflows/radar.yml).
Il produit data/radar.json, que la page index.html affiche.

Sources :
  1. Flux RSS de médias VC / startups (actus, levées de fonds)
  2. BODACC (open data officiel) : modifications de capital de sociétés
     -> souvent le signe d'une levée de fonds, parfois avant l'annonce
  3. Product Hunt : lancements de produits

Pour ajouter une source : ajoute une ligne dans SOURCES ci-dessous.
"""

import datetime as dt
import hashlib
import html
import json
import re
import sys
import unicodedata
from pathlib import Path

import feedparser
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "radar.json"

KEEP_ARTICLES_DAYS = 45      # historique gardé pour les tendances
KEEP_SIGNALS_DAYS = 30
BODACC_LOOKBACK_DAYS = 10
MAX_SIGNALS = 400
UA = "RadarVC/1.0 (projet personnel de veille; GitHub Actions)"

# ---------------------------------------------------------------------------
# 1. Sources (modifie librement cette liste)
# ---------------------------------------------------------------------------
SOURCES = [
    {"name": "Maddyness", "url": "https://www.maddyness.com/feed/", "zone": "France"},
    {"name": "FrenchWeb", "url": "https://www.frenchweb.fr/feed", "zone": "France"},
    {"name": "Sifted", "url": "https://sifted.eu/feed", "zone": "Europe"},
    {"name": "Tech.eu", "url": "https://tech.eu/feed/", "zone": "Europe"},
    {"name": "EU-Startups", "url": "https://www.eu-startups.com/feed/", "zone": "Europe"},
    {"name": "TechCrunch", "url": "https://techcrunch.com/category/venture/feed/", "zone": "Monde"},
    {"name": "Crunchbase News", "url": "https://news.crunchbase.com/feed/", "zone": "Monde"},
    {"name": "Google News FR",
     "url": "https://news.google.com/rss/search?q=%22l%C3%A8ve%22+millions+startup+when:7d&hl=fr&gl=FR&ceid=FR:fr",
     "zone": "France"},
]

LAUNCH_SOURCES = [
    {"name": "Product Hunt", "url": "https://www.producthunt.com/feed"},
]

BODACC_URL = ("https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/"
              "catalog/datasets/annonces-commerciales/records")

# ---------------------------------------------------------------------------
# 2. Dictionnaires de classification
# ---------------------------------------------------------------------------
SECTORS = {
    "IA": ["ia", "intelligence artificielle", "ai", "artificial intelligence", "llm",
           "genai", "generative", "générative", "machine learning", "agentic", "agents ia", "ai agent"],
    "Fintech": ["fintech", "paiement", "payment", "payments", "banque", "banking", "néobanque",
                "neobank", "crypto", "blockchain", "assurance", "insurtech", "lending", "crédit"],
    "Climat & énergie": ["climat", "climate", "climatetech", "énergie", "energy", "solaire", "solar",
                         "hydrogène", "hydrogen", "carbone", "carbon", "batterie", "battery", "greentech",
                         "décarbonation", "décarboner", "décarboniser", "recyclage", "recycling"],
    "Santé & bio": ["santé", "health", "healthtech", "medtech", "biotech", "medical", "médical",
                    "pharma", "thérapie", "therapy", "patients", "clinique", "clinical"],
    "SaaS B2B": ["saas", "b2b", "logiciel", "software", "plateforme", "platform", "devtools",
                 "developer", "no-code", "erp", "crm"],
    "Cybersécurité": ["cyber", "cybersécurité", "cybersecurity", "security", "sécurité informatique"],
    "Défense & spatial": ["défense", "defense", "defence", "spatial", "space", "satellite", "drone", "dual-use"],
    "Deeptech": ["deeptech", "quantique", "quantum", "semiconducteur", "semiconductor", "puce", "chip",
                 "robotique", "robotics", "photonique", "photonics"],
    "Mobilité": ["mobilité", "mobility", "véhicule", "vehicle", "ev", "logistique", "logistics", "transport"],
    "Commerce & conso": ["e-commerce", "ecommerce", "retail", "marketplace", "d2c", "consumer", "marque"],
    "Food & agri": ["foodtech", "agritech", "alimentation", "food", "agriculture", "restauration"],
    "RH & éducation": ["rh", "hr", "recrutement", "recruiting", "hiring", "edtech", "formation", "éducation", "education"],
    "Immobilier": ["proptech", "immobilier", "real estate", "construction", "bâtiment"],
}

ROUNDS = [  # ordre important : le plus précis d'abord
    ("Pre-seed", r"pre[- ]?seed|pré[- ]?amorçage"),
    ("Seed", r"\bseed\b|amorçage"),
    ("Série A", r"s[ée]ries? a\b"),
    ("Série B", r"s[ée]ries? b\b"),
    ("Série C", r"s[ée]ries? c\b"),
    ("Série D+", r"s[ée]ries? [d-h]\b"),
    ("Dette", r"\bdebt\b|\bdette\b|venture debt"),
    ("M&A", r"\bacqui[rs]|\brach[eè]t|\bm&a\b|\bmerger\b|fusion"),
    ("IPO", r"\bipo\b|introduction en bourse|entrée en bourse"),
]

INVESTORS = [
    "Bpifrance", "Partech", "Eurazeo", "Elaia", "Kima Ventures", "Serena", "Alven", "Daphni",
    "Frst", "ISAI", "Breega", "XAnge", "Idinvest", "Ventech", "Newfund", "Seventure", "Truffle",
    "Iris", "Red River West", "Headline", "Singular", "Raise Ventures", "Galion.exe", "Founders Future",
    "Axeleo", "Side Capital", "Cathay Innovation", "Jolt Capital", "Supernova Invest", "Sofinnova",
    "Balderton", "Index Ventures", "Accel", "Sequoia", "Andreessen Horowitz", "a16z", "Lightspeed",
    "General Catalyst", "Point Nine", "Creandum", "Northzone", "Atomico", "Seedcamp", "LocalGlobe",
    "Speedinvest", "HV Capital", "Lakestar", "Earlybird", "Cherry Ventures", "Project A", "Notion Capital",
    "Mistral", "EQT", "Tiger Global", "SoftBank", "Insight Partners", "Khosla", "Y Combinator",
    "Plural", "Blossom", "Hoxton", "Kibo", "Visionaries Club", "Felix Capital", "Dawn Capital",
]

TECH_ACTIVITY = re.compile(
    r"logiciel|informatique|numérique|digital|plateforme|application|données|data|"
    r"intelligence artificielle|algorithm|saas|internet|cloud|biotech|recherche et développement|"
    r"r&d|électronique|robot|cyber|fintech|édition de logiciels|programmation|innovation",
    re.I,
)

FX_TO_EUR = {"EUR": 1.0, "USD": 0.92, "GBP": 1.17, "CHF": 1.05}  # approximatif, pour classer


# ---------------------------------------------------------------------------
# Utilitaires
# ---------------------------------------------------------------------------
def log(*a):
    print("[radar]", *a, file=sys.stderr)


def clean_text(s, limit=None):
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    if limit and len(s) > limit:
        s = s[: limit - 1].rsplit(" ", 1)[0] + "…"
    return s


def norm_title(t):
    t = unicodedata.normalize("NFKD", (t or "").lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"[^a-z0-9 ]", " ", t)
    return re.sub(r"\s+", " ", t).strip()[:90]


def make_id(*parts):
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:12]


def entry_date(e):
    for key in ("published_parsed", "updated_parsed"):
        v = e.get(key)
        if v:
            return dt.datetime(*v[:6], tzinfo=dt.timezone.utc)
    return dt.datetime.now(dt.timezone.utc)


def kw_regex(words):
    return re.compile(r"(?<![\w-])(" + "|".join(re.escape(w) for w in words) + r")(?![\w-])", re.I)


SECTOR_RX = {k: kw_regex(v) for k, v in SECTORS.items()}
ROUND_RX = [(k, re.compile(v, re.I)) for k, v in ROUNDS]
INVESTOR_RX = [(name, re.compile(r"(?<!\w)" + re.escape(name) + r"(?!\w)", re.I)) for name in INVESTORS]

AMOUNT_RX = [
    # €12M, $1.5bn, £30 million
    re.compile(r"(?P<cur>[€$£])\s?(?P<num>\d{1,4}(?:[.,]\d{1,2})?)\s?(?P<unit>bn|billion|b|m|mn|million|millions)\b", re.I),
    # 12 millions d'euros, 1,5 milliard de dollars, 30M€, 20 M$
    re.compile(r"(?P<num>\d{1,4}(?:[.,]\d{1,2})?)\s?(?P<unit>milliards?|md|bn|billion|millions?|mn|m)\s?"
               r"(?P<cur>d['’]euros|d['’]€|€|euros?|de dollars|dollars|\$|£|eur|usd|chf)", re.I),
]


def parse_amount(text):
    best = None
    for rx in AMOUNT_RX:
        for m in rx.finditer(text or ""):
            num = float(m.group("num").replace(",", "."))
            unit = m.group("unit").lower()
            millions = num * 1000 if unit.startswith(("b", "md", "milliard")) else num
            cur_raw = m.group("cur").lower()
            if "$" in cur_raw or "dollar" in cur_raw or "usd" in cur_raw:
                cur = "USD"
            elif "£" in cur_raw:
                cur = "GBP"
            elif "chf" in cur_raw:
                cur = "CHF"
            else:
                cur = "EUR"
            if not (0.05 <= millions <= 50000):
                continue
            eur = millions * FX_TO_EUR[cur]
            if best is None or eur > best["eur_m"]:
                sym = {"EUR": "€", "USD": "$", "GBP": "£", "CHF": "CHF"}[cur]
                label = (f"{millions/1000:.1f} Md{sym}" if millions >= 1000
                         else f"{millions:g} M{sym}")
                best = {"value_m": millions, "currency": cur, "eur_m": round(eur, 2), "label": label}
    return best


def classify(title, summary):
    text = f"{title}. {summary}"
    sectors = [k for k, rx in SECTOR_RX.items() if rx.search(text)]
    rnd = next((k for k, rx in ROUND_RX if rx.search(text)), None)
    amount = parse_amount(title) or parse_amount(summary)
    investors = sorted({name for name, rx in INVESTOR_RX if rx.search(text)})
    raise_words = re.search(r"\b(l[eè]ve|lev[ée]e|raises?|raised|secures?|funding|tour de table|"
                            r"financement|investit|backs|closes)\b", text, re.I)
    is_deal = bool(amount and (raise_words or rnd)) or bool(rnd and rnd not in ("M&A", "IPO") and raise_words)
    return sectors, rnd, amount, investors, is_deal


def get(url, **kw):
    return requests.get(url, headers={"User-Agent": UA}, timeout=30, **kw)


# ---------------------------------------------------------------------------
# Collecte RSS
# ---------------------------------------------------------------------------
def fetch_feed(src):
    r = get(src["url"])
    r.raise_for_status()
    feed = feedparser.parse(r.content)
    if not feed.entries:
        raise ValueError("flux vide ou illisible")
    return feed.entries


def collect_articles(status):
    items = []
    for src in SOURCES:
        try:
            entries = fetch_feed(src)
        except Exception as e:  # une source en panne ne bloque pas les autres
            log(f"{src['name']}: échec ({e})")
            status.append({"name": src["name"], "ok": False, "count": 0, "error": str(e)[:120]})
            continue
        n = 0
        for e in entries[:60]:
            title = clean_text(e.get("title"))
            link = e.get("link") or ""
            if not title or not link:
                continue
            source = src["name"]
            if src["name"].startswith("Google News") and " - " in title:
                title, _, source = title.rpartition(" - ")
            summary = clean_text(e.get("summary") or e.get("description"), 240)
            if summary.lower().startswith(title.lower()[:40]):
                summary = ""
            sectors, rnd, amount, investors, is_deal = classify(title, summary)
            items.append({
                "id": make_id(link),
                "title": title,
                "link": link,
                "source": source,
                "zone": src["zone"],
                "date": entry_date(e).isoformat(),
                "summary": summary,
                "sectors": sectors,
                "round": rnd,
                "amount": amount,
                "investors": investors,
                "deal": is_deal,
            })
            n += 1
        status.append({"name": src["name"], "ok": True, "count": n})
        log(f"{src['name']}: {n} articles")
    return items


def collect_launches(status):
    out = []
    for src in LAUNCH_SOURCES:
        try:
            entries = fetch_feed(src)
        except Exception as e:
            status.append({"name": src["name"], "ok": False, "count": 0, "error": str(e)[:120]})
            continue
        for e in entries[:30]:
            out.append({
                "id": make_id(e.get("link", "")),
                "title": clean_text(e.get("title")),
                "link": e.get("link"),
                "date": entry_date(e).isoformat(),
                "summary": clean_text(e.get("summary"), 160),
            })
        status.append({"name": src["name"], "ok": True, "count": len(out)})
    return out


# ---------------------------------------------------------------------------
# BODACC : modifications de capital (sociétés uniquement)
# ---------------------------------------------------------------------------
def as_obj(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return {"_text": v}
    return v or {}


def walk(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from walk(v)


def parse_bodacc(rec):
    modifs = as_obj(rec.get("modificationsgenerales"))
    modif_text = " ".join(str(d.get("descriptif", "")) for d in walk(modifs)) or str(modifs.get("_text", ""))
    if "capital" not in modif_text.lower():
        return None
    personnes = as_obj(rec.get("listepersonnes"))
    company = None
    for d in walk(personnes):
        if d.get("typePersonne") == "pp":  # personne physique : on ignore (vie privée)
            return None
        if d.get("denomination") or d.get("formeJuridique"):
            company = d
            break
    if company is None:
        return None
    capital = None
    cap = company.get("capital")
    if isinstance(cap, dict):
        try:
            capital = float(str(cap.get("montantCapital", "")).replace(" ", "").replace(",", "."))
        except ValueError:
            capital = None
    etab = as_obj(rec.get("listeetablissements"))
    activity = " ".join(str(d.get("activite", "")) for d in walk(etab) if d.get("activite"))
    activity = activity or str(company.get("activite", ""))
    registre = rec.get("registre")
    siren = (registre[0] if isinstance(registre, list) and registre else str(registre or "").split(",")[0])
    low = modif_text.lower()
    direction = "hausse" if "augment" in low else ("baisse" if "réduc" in low or "reduc" in low else "modif")
    if direction == "baisse":
        return None
    name = clean_text(rec.get("commercant") or company.get("denomination") or "")
    if not name:
        return None
    form = clean_text(str(company.get("formeJuridique", "")))
    return {
        "id": make_id(str(rec.get("id") or rec.get("numeroannonce") or name), str(rec.get("dateparution"))),
        "name": name,
        "siren": re.sub(r"\D", "", siren)[:9],
        "form": form,
        "city": clean_text(rec.get("ville") or ""),
        "dept": str(rec.get("numerodepartement") or ""),
        "date": str(rec.get("dateparution") or ""),
        "capital": capital,
        "direction": direction,
        "activity": clean_text(activity, 160),
        "tech": bool(TECH_ACTIVITY.search(activity or "") or TECH_ACTIVITY.search(name)),
        "sas": "actions simplifiée" in form.lower() or re.search(r"\bSAS\b", form) is not None,
        "url": rec.get("url_complete") or "",
    }


def collect_bodacc(status):
    since = (dt.date.today() - dt.timedelta(days=BODACC_LOOKBACK_DAYS)).isoformat()
    base = f"familleavis=\"modification\" AND dateparution>=date'{since}'"
    attempts = [
        base + ' AND search(modificationsgenerales, "capital")',
        base + ' AND modificationsgenerales like "*capital*"',
        base,
    ]
    for where in attempts:
        records, offset = [], 0
        try:
            while offset < 2000:
                r = get(BODACC_URL, params={"where": where, "limit": 100, "offset": offset,
                                            "order_by": "dateparution desc"})
                r.raise_for_status()
                batch = r.json().get("results", [])
                records += batch
                if len(batch) < 100:
                    break
                offset += 100
        except Exception as e:
            log(f"BODACC requête rejetée ({e}), essai suivant")
            continue
        signals = [s for s in (parse_bodacc(x) for x in records) if s]
        status.append({"name": "BODACC", "ok": True, "count": len(signals)})
        log(f"BODACC: {len(records)} annonces lues, {len(signals)} signaux")
        return signals
    status.append({"name": "BODACC", "ok": False, "count": 0, "error": "API indisponible"})
    return []


# ---------------------------------------------------------------------------
# Fusion avec l'historique + croisements
# ---------------------------------------------------------------------------
def merge(old, new, key_date, keep_days, dedupe_title=False):
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=keep_days)).isoformat()
    by_id = {x["id"]: x for x in old}
    for x in new:
        by_id[x["id"]] = x
    items = [x for x in by_id.values() if str(x.get(key_date, "")) >= cutoff[:len(str(x.get(key_date, "")))]]
    if dedupe_title:
        seen, uniq = set(), []
        for x in sorted(items, key=lambda x: x[key_date]):
            k = norm_title(x["title"])
            if k in seen:
                continue
            seen.add(k)
            uniq.append(x)
        items = uniq
    return sorted(items, key=lambda x: x[key_date], reverse=True)


def cross_match(signals, articles):
    """Signal BODACC dont le nom apparaît dans la presse = confirmé."""
    titles = [(norm_title(a["title"]), a) for a in articles]
    for s in signals:
        n = norm_title(re.sub(r"\b(sas|sa|sarl|sasu|holding|group|groupe)\b", " ", s["name"], flags=re.I))
        s["press"] = None
        if len(n) < 4:
            continue
        rx = re.compile(r"(?<!\w)" + re.escape(n) + r"(?!\w)")
        for t, a in titles:
            if rx.search(t):
                s["press"] = {"title": a["title"], "link": a["link"]}
                break


def main():
    old = {}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            old = {}
    status = []
    articles = merge(old.get("articles", []), collect_articles(status), "date",
                     KEEP_ARTICLES_DAYS, dedupe_title=True)
    signals = merge(old.get("signals", []), collect_bodacc(status), "date", KEEP_SIGNALS_DAYS)
    signals.sort(key=lambda s: (s["date"], s["tech"], s["sas"]), reverse=True)
    signals = signals[:MAX_SIGNALS]
    cross_match(signals, articles)
    launches = collect_launches(status) or old.get("launches", [])

    data = {
        "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
        "sources": status,
        "articles": articles,
        "signals": signals,
        "launches": launches,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"OK : {len(articles)} articles, {len(signals)} signaux, {len(launches)} lancements")


if __name__ == "__main__":
    main()
