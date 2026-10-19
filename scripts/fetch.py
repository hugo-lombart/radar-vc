#!/usr/bin/env python3
"""
Radar VC — collecte automatique (lancée par GitHub Actions, 3 fois par jour).

Produit :
  data/radar.json     -> actus récentes, signaux BODACC / SEC, lancements, état des sources
  data/deals.json     -> base historique de TOUTES les levées repérées (jamais effacée)
  data/countries.json -> pays, continents et codes carte (pour le dashboard)

Sources :
  1. ~40 médias startups/VC dans le monde (RSS)
  2. ~30 recherches Google News par pays et par langue
  3. BODACC (France, officiel) : modifications de capital
  4. SEC Form D (États-Unis, officiel) : déclarations de levées privées
  5. Product Hunt : lancements de produits

Pour ajouter une source : ajoute une ligne dans RSS_SOURCES ou GOOGLE_NEWS.
Pour changer les secteurs, pays, fonds suivis : voir taxonomy.py
"""

import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import feedparser
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract import analyse, company_key, norm  # noqa: E402
from taxonomy import CONTINENTS, COUNTRIES, TECH_ACTIVITY  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT_RADAR = DATA / "radar.json"
OUT_DEALS = DATA / "deals.json"
OUT_COUNTRIES = DATA / "countries.json"

KEEP_DEAL_ARTICLES_DAYS = 45
KEEP_OTHER_ARTICLES_DAYS = 14
MAX_ARTICLES = 3500
KEEP_SIGNALS_DAYS = 30
BODACC_LOOKBACK_DAYS = 10
MAX_SIGNALS = 400
UA = "Mozilla/5.0 (compatible; RadarVC/2.0; veille personnelle via GitHub Actions)"
# La SEC demande un contact dans l'en-tête : ajoute ton e-mail dans Settings > Secrets and variables > Actions > Variables > SEC_CONTACT
SEC_UA = f"RadarVC {os.environ.get('SEC_CONTACT') or 'radar-vc@users.noreply.github.com'}"

# ---------------------------------------------------------------------------
# 1. Médias (RSS). zone = étiquette d'affichage, hint = pays par défaut si le texte n'en cite aucun
# ---------------------------------------------------------------------------
RSS_SOURCES = [
    # France / Europe
    {"name": "Maddyness", "url": "https://www.maddyness.com/feed/", "hint": "FR"},
    {"name": "FrenchWeb", "url": "https://www.frenchweb.fr/feed", "hint": "FR"},
    {"name": "Sifted", "url": "https://sifted.eu/feed"},
    {"name": "Tech.eu", "url": "https://tech.eu/feed/"},
    {"name": "EU-Startups", "url": "https://www.eu-startups.com/feed/"},
    {"name": "UKTN", "url": "https://www.uktech.news/feed", "hint": "GB"},
    {"name": "Deutsche Startups", "url": "https://www.deutsche-startups.de/feed/", "hint": "DE"},
    {"name": "Trending Topics", "url": "https://www.trendingtopics.eu/feed/"},
    {"name": "The Recursive", "url": "https://therecursive.com/feed/"},
    {"name": "El Referente", "url": "https://elreferente.es/feed/", "hint": "ES"},
    {"name": "StartupItalia", "url": "https://startupitalia.eu/feed", "hint": "IT"},
    {"name": "Silicon Republic", "url": "https://www.siliconrepublic.com/feed", "hint": "IE"},
    # Amérique du Nord
    {"name": "TechCrunch", "url": "https://techcrunch.com/category/venture/feed/"},
    {"name": "Crunchbase News", "url": "https://news.crunchbase.com/feed/"},
    {"name": "FinSMEs", "url": "https://www.finsmes.com/feed"},
    {"name": "AlleyWatch", "url": "https://www.alleywatch.com/feed/", "hint": "US"},
    {"name": "GeekWire", "url": "https://www.geekwire.com/feed/", "hint": "US"},
    {"name": "PR Newswire VC", "url": "https://www.prnewswire.com/rss/financial-services-latest-news/venture-capital-list.rss"},
    {"name": "BetaKit", "url": "https://betakit.com/feed/", "hint": "CA"},
    # Amérique latine
    {"name": "LatamList", "url": "https://latamlist.com/feed/"},
    {"name": "Startupi", "url": "https://startupi.com.br/feed/", "hint": "BR"},
    # Afrique / Moyen-Orient
    {"name": "TechCabal", "url": "https://techcabal.com/feed/"},
    {"name": "Disrupt Africa", "url": "https://disruptafrica.com/feed/"},
    {"name": "Techpoint Africa", "url": "https://techpoint.africa/feed/", "hint": "NG"},
    {"name": "WeeTracker", "url": "https://weetracker.com/feed/"},
    {"name": "MENAbytes", "url": "https://www.menabytes.com/feed/"},
    {"name": "Wamda", "url": "https://www.wamda.com/feed"},
    {"name": "Geektime", "url": "https://www.geektime.com/feed/", "hint": "IL"},
    # Asie / Océanie
    {"name": "Inc42", "url": "https://inc42.com/feed/", "hint": "IN"},
    {"name": "Entrackr", "url": "https://entrackr.com/feed/", "hint": "IN"},
    {"name": "YourStory", "url": "https://yourstory.com/feed", "hint": "IN"},
    {"name": "e27", "url": "https://e27.co/feed/"},
    {"name": "KrASIA", "url": "https://kr-asia.com/feed"},
    {"name": "DealStreetAsia", "url": "https://www.dealstreetasia.com/feed/"},
    {"name": "TechNode", "url": "https://technode.com/feed/", "hint": "CN"},
    {"name": "Pandaily", "url": "https://pandaily.com/feed/", "hint": "CN"},
    {"name": "The Bridge", "url": "https://thebridge.jp/en/feed", "hint": "JP"},
    {"name": "Startup Daily", "url": "https://www.startupdaily.net/feed/", "hint": "AU"},
    {"name": "SmartCompany", "url": "https://www.smartcompany.com.au/feed/", "hint": "AU"},
]

# ---------------------------------------------------------------------------
# 2. Google News : une recherche par pays / langue (nom, requête, hl, gl, ceid, pays par défaut)
# ---------------------------------------------------------------------------
GOOGLE_NEWS = [
    ("GN Monde · Série A", '"Series A" raises', "en-US", "US", "US:en", None),
    ("GN Monde · Seed", '"seed round" OR "seed funding" raises', "en-US", "US", "US:en", None),
    ("GN Monde · Séries B-D", '"Series B" OR "Series C" OR "Series D" raises', "en-US", "US", "US:en", None),
    ("GN Monde · Levées", 'startup raises million funding round', "en-US", "US", "US:en", None),
    ("GN Royaume-Uni", 'startup raises funding round', "en-GB", "GB", "GB:en", "GB"),
    ("GN France", '"lève" millions startup', "fr", "FR", "FR:fr", "FR"),
    ("GN Allemagne", 'Startup Finanzierungsrunde Millionen', "de", "DE", "DE:de", "DE"),
    ("GN Suisse", 'Startup Finanzierungsrunde Millionen', "de", "CH", "CH:de", "CH"),
    ("GN Espagne", 'startup ronda de financiación millones', "es", "ES", "ES:es", "ES"),
    ("GN Italie", 'startup round milioni di euro', "it", "IT", "IT:it", "IT"),
    ("GN Pays-Bas", 'startup investering miljoen', "nl", "NL", "NL:nl", "NL"),
    ("GN Pologne", 'startup runda finansowania mln', "pl", "PL", "PL:pl", "PL"),
    ("GN Portugal", 'startup ronda de investimento milhões', "pt-PT", "PT", "PT:pt-150", "PT"),
    ("GN Nordiques", 'startup raises Sweden OR Norway OR Denmark OR Finland', "en-US", "US", "US:en", None),
    ("GN Turquie", 'girişim yatırım aldı milyon', "tr", "TR", "TR:tr", "TR"),
    ("GN Canada", 'startup raises funding', "en-CA", "CA", "CA:en", "CA"),
    ("GN Brésil", 'startup rodada de investimento milhões', "pt-BR", "BR", "BR:pt-419", "BR"),
    ("GN Mexique", 'startup ronda de inversión millones', "es-419", "MX", "MX:es-419", "MX"),
    ("GN Amérique latine", 'startup levanta ronda millones de dólares', "es-419", "AR", "AR:es-419", None),
    ("GN Inde", 'startup raises funding crore', "en-IN", "IN", "IN:en", "IN"),
    ("GN Asie du Sud-Est", 'startup raises funding Series', "en-SG", "SG", "SG:en", None),
    ("GN Indonésie", 'startup pendanaan seri', "id", "ID", "ID:id", "ID"),
    ("GN Japon", 'スタートアップ 資金調達 億円', "ja", "JP", "JP:ja", "JP"),
    ("GN Corée", '스타트업 투자 유치 억원', "ko", "KR", "KR:ko", "KR"),
    ("GN Chine", 'Chinese startup raises funding', "en-US", "US", "US:en", None),
    ("GN Israël", 'Israeli startup raises', "en-US", "US", "US:en", "IL"),
    ("GN Golfe & MENA", 'startup raises UAE OR Saudi OR Egypt OR Qatar', "en-US", "US", "US:en", None),
    ("GN Afrique", 'African startup raises funding', "en-US", "US", "US:en", None),
    ("GN Australie", 'startup raises funding', "en-AU", "AU", "AU:en", "AU"),
]


def google_news_url(query, hl, gl, ceid, window="when:2d"):
    q = urllib.parse.quote(f"{query} {window}".strip())
    return f"https://news.google.com/rss/search?q={q}&hl={hl}&gl={gl}&ceid={ceid}"


LAUNCH_SOURCES = [{"name": "Product Hunt", "url": "https://www.producthunt.com/feed"}]
BODACC_URL = "https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records"
SEC_FEED = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=D&company=&dateb=&owner=include&start=0&count=100&output=atom"


# ---------------------------------------------------------------------------
# Utilitaires
# ---------------------------------------------------------------------------
def log(*a):
    print("[radar]", *a, file=sys.stderr, flush=True)


def clean_text(s, limit=None):
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    if limit and len(s) > limit:
        s = s[: limit - 1].rsplit(" ", 1)[0] + "…"
    return s


def make_id(*parts):
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:12]


def entry_date(e):
    for key in ("published_parsed", "updated_parsed"):
        v = e.get(key)
        if v:
            return dt.datetime(*v[:6], tzinfo=dt.timezone.utc)
    return dt.datetime.now(dt.timezone.utc)


def get(url, ua=UA, **kw):
    return requests.get(url, headers={"User-Agent": ua, "Accept-Language": "en,fr;q=0.8"}, timeout=30, **kw)


def zone_of(country):
    if country == "FR":
        return "France"
    if country and COUNTRIES.get(country, (None, None, ""))[2] == "Europe":
        return "Europe"
    return "Monde"


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


# ---------------------------------------------------------------------------
# Base historique des levées (dédoublonnage multi-sources)
# ---------------------------------------------------------------------------
class DealStore:
    """Une levée citée par plusieurs médias n'est comptée qu'une fois ; on garde la liste des sources."""

    def __init__(self, deals):
        self.deals = deals
        self.by_company, self.by_title, self.by_id = {}, {}, {}
        for d in deals:
            self._index(d)

    def _index(self, d):
        self.by_id[d["id"]] = d
        if d.get("c"):
            self.by_company.setdefault(company_key(d["c"]), []).append(d)
        self.by_title[norm(d["t"])[:80]] = d

    @staticmethod
    def _close(a, b, days):
        try:
            return abs((dt.date.fromisoformat(a) - dt.date.fromisoformat(b)).days) <= days
        except ValueError:
            return False

    def _merge(self, old, new):
        for s in new["src"]:
            if s not in old["src"]:
                old["src"].append(s)
        old["n"] = len(old["src"])
        old["d"] = min(old["d"], new["d"])
        if not old.get("a") and new.get("a"):
            old["a"], old["al"], old["cur"] = new["a"], new.get("al"), new.get("cur")
        if old.get("st") in (None, "Non précisé") and new.get("st") not in (None, "Non précisé"):
            old["st"] = new["st"]
        for k in ("sec", "th", "inv"):
            old[k] = sorted(set(old.get(k, [])) | set(new.get(k, [])))
        if not old.get("cc") and new.get("cc"):
            old["cc"] = new["cc"]
        if new.get("o"):
            old["o"] = 1
        links = old.setdefault("alt", [])
        if new["u"] != old["u"] and new["u"] not in links and len(links) < 4:
            links.append(new["u"])
        return old

    def add(self, d, loose=False):
        if d["id"] in self.by_id:
            return self._merge(self.by_id[d["id"]], d)
        ck = company_key(d.get("c") or "")
        if ck:
            for old in self.by_company.get(ck, []):
                if old.get("k") != d.get("k"):
                    continue
                if loose and self._close(old["d"], d["d"], 75):
                    return self._merge(old, d)
                if not self._close(old["d"], d["d"], 21):
                    continue
                a, b = old.get("a"), d.get("a")
                if not a or not b or max(a, b) / max(min(a, b), 1e-6) <= 1.35:
                    return self._merge(old, d)
        tk = norm(d["t"])[:80]
        if tk in self.by_title and self._close(self.by_title[tk]["d"], d["d"], 10):
            return self._merge(self.by_title[tk], d)
        if loose:  # un dépôt SEC sans équivalent presse : on l'ajoute tel quel
            pass
        self.deals.append(d)
        self._index(d)
        return d

    def sorted(self):
        return sorted(self.deals, key=lambda x: (x["d"], x.get("a") or 0), reverse=True)


def deal_record(article, info, source):
    am = info["amount"]
    return {
        "id": article["id"], "c": info["company"], "t": article["title"], "u": article["link"], "d": article["date"][:10],
        "a": am["eur_m"] if am else None, "al": am["label"] if am else None, "cur": am["currency"] if am else None,
        "st": info["stage"] or "Non précisé", "sec": info["sectors"], "th": info["themes"], "cc": info["country"] or "",
        "inv": info["investors"], "src": [source], "n": 1, "k": info["kind"],
    }


# ---------------------------------------------------------------------------
# Collecte des flux
# ---------------------------------------------------------------------------
def fetch_feed(url):
    r = get(url)
    r.raise_for_status()
    feed = feedparser.parse(r.content)
    if not feed.entries:
        raise ValueError("flux vide ou illisible")
    return feed.entries


def parse_entries(entries, source_name, hint, is_gn, limit=60):
    out = []
    for e in entries[:limit]:
        title = clean_text(e.get("title"))
        link = e.get("link") or ""
        if not title or not link:
            continue
        source = source_name
        if is_gn and " - " in title:
            title, _, source = title.rpartition(" - ")
            source = source.strip()
        summary = "" if is_gn else clean_text(e.get("summary") or e.get("description"), 260)
        if summary.lower().startswith(title.lower()[:40]):
            summary = ""
        info = analyse(title, summary, hint)
        date = entry_date(e)
        out.append(({
            "id": make_id(norm(title)[:80] if is_gn else link),
            "title": title, "link": link, "source": source, "via": source_name if is_gn else None,
            "zone": zone_of(info["country"]), "country": info["country"] or "", "company": info["company"],
            "date": date.isoformat(), "summary": summary, "sectors": info["sectors"], "themes": info["themes"],
            "round": info["stage"], "amount": info["amount"], "investors": info["investors"], "deal": info["deal"], "kind": info["kind"],
        }, info))
    return out


def collect_feeds(status):
    jobs = [(s["name"], s["url"], s.get("hint"), False) for s in RSS_SOURCES]
    jobs += [(n, google_news_url(q, hl, gl, ceid), hint, True) for n, q, hl, gl, ceid, hint in GOOGLE_NEWS]

    def run(job):
        name, url, hint, is_gn = job
        try:
            return name, parse_entries(fetch_feed(url), name, hint, is_gn), None
        except Exception as e:
            return name, [], str(e)[:120]

    results = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for name, items, err in pool.map(run, jobs):
            status.append({"name": name, "ok": err is None, "count": len(items), **({"error": err} if err else {}),
                           "type": "Google News" if name.startswith("GN ") else "Média"})
            log(f"{name}: {'échec ' + err if err else str(len(items)) + ' articles'}")
            results += items
    return results


def collect_launches(status):
    out = []
    for src in LAUNCH_SOURCES:
        try:
            entries = fetch_feed(src["url"])
        except Exception as e:
            status.append({"name": src["name"], "ok": False, "count": 0, "error": str(e)[:120], "type": "Lancements"})
            continue
        for e in entries[:30]:
            out.append({"id": make_id(e.get("link", "")), "title": clean_text(e.get("title")), "link": e.get("link"),
                        "date": entry_date(e).isoformat(), "summary": clean_text(e.get("summary"), 160)})
        status.append({"name": src["name"], "ok": True, "count": len(out), "type": "Lancements"})
    return out


# ---------------------------------------------------------------------------
# BODACC (France) : modifications de capital — sociétés uniquement
# ---------------------------------------------------------------------------
TECH_RX = re.compile(TECH_ACTIVITY, re.I)


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
    company = None
    for d in walk(as_obj(rec.get("listepersonnes"))):
        if d.get("typePersonne") == "pp":  # personne physique : ignorée (vie privée)
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
    activity = " ".join(str(d.get("activite", "")) for d in walk(as_obj(rec.get("listeetablissements"))) if d.get("activite"))
    activity = activity or str(company.get("activite", ""))
    registre = rec.get("registre")
    siren = registre[0] if isinstance(registre, list) and registre else str(registre or "").split(",")[0]
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
        "name": name, "siren": re.sub(r"\D", "", siren)[:9], "form": form, "city": clean_text(rec.get("ville") or ""),
        "dept": str(rec.get("numerodepartement") or ""), "date": str(rec.get("dateparution") or ""), "capital": capital,
        "direction": direction, "activity": clean_text(activity, 160),
        "tech": bool(TECH_RX.search(activity or "") or TECH_RX.search(name)),
        "sas": "actions simplifiée" in form.lower() or re.search(r"\bSAS\b", form) is not None, "url": rec.get("url_complete") or "",
    }


def collect_bodacc(status):
    since = (dt.date.today() - dt.timedelta(days=BODACC_LOOKBACK_DAYS)).isoformat()
    base = f"familleavis=\"modification\" AND dateparution>=date'{since}'"
    for where in (base + ' AND search(modificationsgenerales, "capital")', base + ' AND modificationsgenerales like "*capital*"', base):
        records, offset = [], 0
        try:
            while offset < 2000:
                r = get(BODACC_URL, params={"where": where, "limit": 100, "offset": offset, "order_by": "dateparution desc"})
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
        status.append({"name": "BODACC", "ok": True, "count": len(signals), "type": "Officiel"})
        log(f"BODACC: {len(records)} annonces lues, {len(signals)} signaux")
        return signals
    status.append({"name": "BODACC", "ok": False, "count": 0, "error": "API indisponible", "type": "Officiel"})
    return []


# ---------------------------------------------------------------------------
# SEC Form D (États-Unis) : levées privées déclarées
# ---------------------------------------------------------------------------
SEC_SECTORS = {
    "Computers": "Tech", "Telecommunications": "Tech", "Other Technology": "Tech", "Biotechnology": "Santé & bio",
    "Pharmaceuticals": "Santé & bio", "Other Health Care": "Santé & bio", "Hospitals and Physicians": "Santé & bio",
    "Health Insurance": "Fintech", "Insurance": "Fintech", "Other Energy": "Climat & énergie", "Energy Conservation": "Climat & énergie",
    "Environmental Services": "Climat & énergie", "Electric Utilities": "Climat & énergie", "Manufacturing": "Industrie",
    "Retailing": "Commerce & conso", "Restaurants": "Food & agri", "Agriculture": "Food & agri", "Business Services": "SaaS B2B",
    "Other Travel": "Médias & loisirs", "Tourism and Travel Services": "Médias & loisirs", "Airlines and Airports": "Mobilité",
}


def _xt(root, path):
    el = root.find(path)
    return (el.text or "").strip() if el is not None and el.text else ""


def parse_form_d(xml_bytes):
    root = ET.fromstring(xml_bytes)
    for el in root.iter():  # supprime les espaces de noms
        if "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    if _xt(root, ".//typeOfFiling/newOrAmendment/isAmendment").lower() == "true":
        return None
    industry = _xt(root, ".//industryGroup/industryGroupType")
    if industry not in SEC_SECTORS:
        return None  # fonds, immobilier, pétrole, banques... ignorés
    if _xt(root, ".//typesOfSecuritiesOffered/isEquityType").lower() != "true":
        return None
    try:
        sold = float(_xt(root, ".//offeringSalesAmounts/totalAmountSold") or 0)
    except ValueError:
        sold = 0
    if sold < 500_000:
        return None
    try:
        total = float(_xt(root, ".//offeringSalesAmounts/totalOfferingAmount") or 0)
    except ValueError:
        total = 0
    name = _xt(root, ".//primaryIssuer/entityName")
    state = _xt(root, ".//primaryIssuer/issuerAddress/stateOrCountryDescription")
    city = _xt(root, ".//primaryIssuer/issuerAddress/city")
    first_sale = _xt(root, ".//typeOfFiling/dateOfFirstSale/value")
    return {"name": name, "industry": industry, "sold_usd": sold, "offering_usd": total or None, "state": state, "city": city.title(),
            "first_sale": first_sale}


def collect_sec(status, limit=100):
    try:
        r = get(SEC_FEED, ua=SEC_UA)
        r.raise_for_status()
        feed = feedparser.parse(r.content)
    except Exception as e:
        status.append({"name": "SEC Form D", "ok": False, "count": 0, "error": str(e)[:120], "type": "Officiel"})
        return []
    out = []
    for e in feed.entries[:limit]:
        link = e.get("link", "")
        m = re.search(r"/data/(\d+)/(\d{10}-?\d{2}-?\d{6})", link)
        if not m or not re.match(r"^D\b", e.get("title", "")):
            continue
        cik, acc = m.group(1), m.group(2).replace("-", "")
        try:
            time.sleep(0.15)  # la SEC limite à 10 requêtes / seconde
            x = get(f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/primary_doc.xml", ua=SEC_UA)
            x.raise_for_status()
            info = parse_form_d(x.content)
        except Exception as ex:
            log(f"SEC {cik}: {ex}")
            continue
        if not info:
            continue
        info.update({"id": make_id("sec", acc), "date": entry_date(e).date().isoformat(), "url": link})
        out.append(info)
    status.append({"name": "SEC Form D", "ok": True, "count": len(out), "type": "Officiel"})
    log(f"SEC: {len(out)} levées déclarées retenues")
    return out


def sec_to_deal(s):
    eur = round(s["sold_usd"] / 1e6 * 0.92, 3)
    usd_m = s["sold_usd"] / 1e6
    return {"id": s["id"], "c": s["name"], "t": f"{s['name']} déclare une levée de {usd_m:.1f} M$ (SEC Form D)", "u": s["url"],
            "d": s["date"], "a": eur, "al": f"{usd_m:.1f} M$", "cur": "USD", "st": "Non précisé", "sec": [SEC_SECTORS[s["industry"]]],
            "th": [], "cc": "US", "inv": [], "src": ["SEC Form D"], "n": 1, "k": "round", "o": 1}


# ---------------------------------------------------------------------------
# Croisements et sauvegarde
# ---------------------------------------------------------------------------
def merge_articles(old, new):
    now = dt.datetime.now(dt.timezone.utc)
    cut_deal = (now - dt.timedelta(days=KEEP_DEAL_ARTICLES_DAYS)).isoformat()
    cut_other = (now - dt.timedelta(days=KEEP_OTHER_ARTICLES_DAYS)).isoformat()
    by_id = {a["id"]: a for a in old}
    for a in new:
        by_id.setdefault(a["id"], a)
    seen, items = set(), []
    for a in sorted(by_id.values(), key=lambda x: x["date"], reverse=True):
        k = norm(a["title"])[:80]
        if k in seen or a["date"] < (cut_deal if a.get("deal") else cut_other):
            continue
        seen.add(k)
        items.append(a)
    return items[:MAX_ARTICLES]


def merge_signals(old, new):
    cut = (dt.date.today() - dt.timedelta(days=KEEP_SIGNALS_DAYS)).isoformat()
    by_id = {x["id"]: x for x in old}
    by_id.update({x["id"]: x for x in new})
    return sorted([x for x in by_id.values() if x.get("date", "") >= cut], key=lambda s: (s["date"], s.get("tech"), s.get("sas")), reverse=True)


def cross_match(signals, deals):
    by_key = {}
    for d in deals:
        if d.get("c"):
            by_key.setdefault(company_key(d["c"]), d)
    for s in signals:
        s["press"] = None
        k = company_key(re.sub(r"\b(sas|sa|sarl|sasu|holding|group|groupe)\b", " ", s["name"], flags=re.I))
        if len(k) >= 4 and k in by_key and "SEC Form D" not in by_key[k]["src"]:
            d = by_key[k]
            s["press"] = {"title": d["t"], "link": d["u"]}


def write_countries():
    data = {"continents": CONTINENTS,
            "countries": {iso: {"n": n, "num": num, "ct": ct} for iso, (n, num, ct, _kw) in COUNTRIES.items()}}
    OUT_COUNTRIES.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def save_deals(store):
    deals = store.sorted()
    OUT_DEALS.write_text(json.dumps({"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"), "count": len(deals),
                                     "deals": deals}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return deals


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    old = load_json(OUT_RADAR, {})
    store = DealStore(load_json(OUT_DEALS, {}).get("deals", []))
    status = []

    collected = collect_feeds(status)
    for art, info in collected:
        if art["deal"]:
            store.add(deal_record(art, info, art["source"]))
    articles = merge_articles(old.get("articles", []), [a for a, _ in collected])

    sec = collect_sec(status)
    for s in sec:
        store.add(sec_to_deal(s), loose=True)
    deals = save_deals(store)

    signals = merge_signals(old.get("signals", []), collect_bodacc(status))[:MAX_SIGNALS]
    cross_match(signals, deals)
    us_signals = merge_signals(old.get("us_signals", []), sec)[:MAX_SIGNALS]
    launches = collect_launches(status) or old.get("launches", [])

    OUT_RADAR.write_text(json.dumps({
        "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
        "sources": status, "articles": articles, "signals": signals, "us_signals": us_signals, "launches": launches,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    write_countries()
    ok = sum(1 for s in status if s["ok"])
    log(f"OK : {ok}/{len(status)} sources, {len(articles)} articles, {len(deals)} levées en base, {len(signals)} signaux BODACC, {len(us_signals)} SEC")


if __name__ == "__main__":
    main()
