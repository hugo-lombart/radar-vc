"""
Radar VC — extraction d'informations à partir d'un titre / résumé d'article.

  analyse(title, summary, hint_country) -> dict avec :
    company, amount, stage, sectors, themes, investors, country, deal, kind
"""

import re
import unicodedata

from taxonomy import (COUNTRIES, CURRENCY_HINT, FX_TO_EUR, INVESTORS, SECTORS, STAGES, THEMES)


def strip_accents(s):
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c))


def norm(s):
    s = strip_accents((s or "").lower())
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def company_key(name):
    n = norm(name)
    n = re.sub(r"\b(inc|ltd|llc|sas|sa|sarl|gmbh|ag|bv|plc|corp|corporation|co|limited|technologies|technology|labs|group|groupe|holding|io|the)\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def _kw_regex(words):
    words = [w for w in words if w]
    if not words:
        return None
    return re.compile(r"(?<![\w-])(" + "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True)) + r")(?![\w-])", re.I)


SECTOR_RX = {k: _kw_regex(v) for k, v in SECTORS.items()}
THEME_RX = {k: _kw_regex(v) for k, v in THEMES.items()}
STAGE_RX = [(k, re.compile(v, re.I)) for k, v in STAGES]
INVESTOR_RX = [(name, re.compile(r"(?<![\w-])(" + "|".join(re.escape(a) for a in aliases) + r")(?![\w-])",
                                 0 if all(len(a) <= 4 and a.isupper() for a in aliases) else re.I))
               for name, aliases in INVESTORS.items()]

# ---------------------------------------------------------------- pays
_COUNTRY_PATTERNS = []
for iso, (_name, _num, _cont, kws) in COUNTRIES.items():
    for kw in kws:
        strict = (len(kw) <= 4 and kw.replace(".", "").replace(",", "").isupper()) or kw in ("Kiwi", "Aussie")
        if re.search(r"[぀-ヿ一-鿿가-힯]", kw):
            rx = re.compile(re.escape(kw))
        else:
            rx = re.compile(r"(?<![\w-])" + re.escape(kw) + r"(?:['’]s)?(?![\w])", 0 if strict else re.I)
        _COUNTRY_PATTERNS.append((iso, rx))


def detect_country(text):
    """Renvoie (iso2, position) du pays mentionné le plus tôt dans le texte."""
    best = None
    for iso, rx in _COUNTRY_PATTERNS:
        m = rx.search(text or "")
        if m and (best is None or m.start() < best[1]):
            best = (iso, m.start())
    return best


# ---------------------------------------------------------------- montants
_NUM = r"(?P<num>\d{1,4}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)"
_MILLION = r"m|mn|mln|mio\.?|millions?|million|millones|millón|milioni|milione|milhões|milhão|millionen"
_BILLION = r"b|bn|billions?|milliards?|md|mrd\.?|miliardi|miliardo|mil millones|bilhões|bilhão|milliarden?"
_THOUSAND = r"k|thousand|mille"
_INDIAN = r"cr|crores?|lakhs?"
_UNIT = rf"(?P<unit>{_BILLION}|{_MILLION}|{_INDIAN}|{_THOUSAND})"
_CUR_PREFIX = (r"(?P<cur>US\$|USD|C\$|CA\$|CAD|A\$|AU\$|AUD|NZ\$|NZD|S\$|SGD|HK\$|HKD|R\$|BRL|EUR|GBP|CHF|INR|Rs\.?|₹|JPY|¥|CNY|RMB|KRW|₩|"
               r"SEK|NOK|DKK|PLN|ILS|AED|SAR|ZAR|NGN|₦|KES|KSh|EGP|MXN|TRY|IDR|Rp|€|\$|£)")
_CUR_WORD = (r"(?P<cur>d['’]euros?|de euros|euros?|eur|€|de dollars|dollars?|dólares|dollari|dollar|usd|\$|livres sterling|pounds?|sterling|£|"
             r"francs suisses|chf|rupees|roupies|inr|₹|yen|jpy|yuan|renminbi|rmb|cny|won|krw|reais|real|brl|shekels?|ils|dirhams?|aed|riyals?|sar|"
             r"rand|zar|naira|ngn|pesos|mxn|kronor|sek|nok|dkk|złoty|pln|liras?|try)")

AMOUNT_RX = [
    re.compile(_CUR_PREFIX + r"\s?" + _NUM + r"\s?-?" + _UNIT + r"(?![a-zà-ü])", re.I),
    re.compile(_NUM + r"\s?" + _UNIT + r"\.?\s?(?:de |d['’]|of |di |em )?" + _CUR_WORD + r"(?![a-zà-ü])", re.I),
    re.compile(r"(?P<num>\d{1,5}(?:[.,]\d{1,2})?)\s?(?P<unit>億円|億|万円|억\s?원|억|조\s?원)"),
]
_SYMBOL_CUR = {
    "us$": "USD", "usd": "USD", "$": "USD", "c$": "CAD", "ca$": "CAD", "cad": "CAD", "a$": "AUD", "au$": "AUD", "aud": "AUD", "nz$": "NZD", "nzd": "NZD",
    "s$": "SGD", "sgd": "SGD", "hk$": "HKD", "hkd": "HKD", "r$": "BRL", "brl": "BRL", "eur": "EUR", "€": "EUR", "gbp": "GBP", "£": "GBP", "chf": "CHF",
    "inr": "INR", "rs": "INR", "rs.": "INR", "₹": "INR", "jpy": "JPY", "¥": "JPY", "cny": "CNY", "rmb": "CNY", "krw": "KRW", "₩": "KRW",
    "sek": "SEK", "nok": "NOK", "dkk": "DKK", "pln": "PLN", "ils": "ILS", "aed": "AED", "sar": "SAR", "zar": "ZAR", "ngn": "NGN", "₦": "NGN",
    "kes": "KES", "ksh": "KES", "egp": "EGP", "mxn": "MXN", "try": "TRY", "idr": "IDR", "rp": "IDR",
}
_WORD_CUR = [("eur", "EUR"), ("€", "EUR"), ("dóla", "USD"), ("dolla", "USD"), ("dollar", "USD"), ("usd", "USD"), ("$", "USD"), ("sterling", "GBP"),
             ("pound", "GBP"), ("£", "GBP"), ("franc", "CHF"), ("chf", "CHF"), ("rupee", "INR"), ("roupie", "INR"), ("inr", "INR"), ("₹", "INR"),
             ("yen", "JPY"), ("jpy", "JPY"), ("yuan", "CNY"), ("renminbi", "CNY"), ("rmb", "CNY"), ("cny", "CNY"), ("won", "KRW"), ("krw", "KRW"),
             ("rea", "BRL"), ("brl", "BRL"), ("shekel", "ILS"), ("ils", "ILS"), ("dirham", "AED"), ("aed", "AED"), ("riyal", "SAR"), ("sar", "SAR"),
             ("rand", "ZAR"), ("zar", "ZAR"), ("naira", "NGN"), ("ngn", "NGN"), ("peso", "MXN"), ("mxn", "MXN"), ("kronor", "SEK"), ("sek", "SEK"),
             ("nok", "NOK"), ("dkk", "DKK"), ("złoty", "PLN"), ("pln", "PLN"), ("lira", "TRY"), ("try", "TRY")]
_SKIP_AFTER = re.compile(r"^\s*(?:post-money |pre-money |in |of |d['’]|de |annual |annuel |a |an )?(?:post-money |pre-money )?"
                         r"(valuation|valorisation|valoris|valued|valutazione|bewertung|valoración|avaliação|arr\b|revenue|revenues|"
                         r"chiffre d'affaires|turnover|in sales|of sales|gmv|market cap|capitalisation|fund size|under management|aum\b)", re.I)
_SKIP_BEFORE = re.compile(r"(\bat|valued at|valuation of|valuation to|valorisée à|valorisé à|valorisation de|worth|at a|revenue of|arr of|chiffre d'affaires de|"
                          r"market of|marché de|fund of|fonds de)\s*$", re.I)
SYM = {"EUR": "€", "USD": "$", "GBP": "£", "INR": "₹", "JPY": "¥", "KRW": "₩", "BRL": "R$", "CAD": "C$", "AUD": "A$", "SGD": "S$"}


def _to_float(num):
    num = num.strip()
    # 1,200 / 1.200 -> milliers ; 1,5 / 1.5 -> décimal
    if re.fullmatch(r"\d{1,3}([.,]\d{3})+", num):
        return float(re.sub(r"[.,]", "", num))
    m = re.fullmatch(r"(\d{1,3}(?:[.,]\d{3})+)[.,](\d{1,2})", num)
    if m:
        return float(re.sub(r"[.,]", "", m.group(1)) + "." + m.group(2))
    return float(num.replace(",", "."))


def _currency(raw):
    raw = (raw or "").strip().lower()
    if raw in _SYMBOL_CUR:
        return _SYMBOL_CUR[raw]
    for k, v in _WORD_CUR:
        if k in raw:
            return v
    return "USD"


def parse_amount(text):
    """Premier montant de levée trouvé (hors valorisation / chiffre d'affaires), en millions."""
    text = text or ""
    found = []
    for i, rx in enumerate(AMOUNT_RX):
        for m in rx.finditer(text):
            if _SKIP_AFTER.search(text[m.end():m.end() + 40]) or _SKIP_BEFORE.search(text[max(0, m.start() - 30):m.start()]):
                continue
            try:
                num = _to_float(m.group("num"))
            except ValueError:
                continue
            unit = m.group("unit").lower().replace(" ", "")
            if i == 2:
                if unit in ("億円", "億"):
                    millions, cur = num * 100, "JPY"
                elif unit == "万円":
                    millions, cur = num / 100, "JPY"
                elif unit in ("억원", "억"):
                    millions, cur = num * 100, "KRW"
                else:
                    millions, cur = num * 1_000_000, "KRW"
            else:
                cur = _currency(m.group("cur"))
                if re.fullmatch(_BILLION, unit, re.I):
                    millions = num * 1000
                elif unit.startswith("cr"):
                    millions, cur = num * 10, "INR"
                elif unit.startswith("lakh"):
                    millions, cur = num * 0.1, "INR"
                elif re.fullmatch(_THOUSAND, unit, re.I):
                    millions = num / 1000
                else:
                    millions = num
                # "$" seul dans un contexte canadien/australien : ajusté par l'appelant si besoin
            eur = millions * FX_TO_EUR.get(cur, 1)
            if not (0.02 <= eur <= 60000):
                continue
            found.append((m.start(), millions, cur, eur))
    if not found:
        return None
    _, millions, cur, eur = min(found, key=lambda x: x[0])
    sym = SYM.get(cur)
    if millions >= 1000:
        val = f"{millions / 1000:.2f}".rstrip("0").rstrip(".")
        label = f"{val} Md{sym}" if sym else f"{val} Md {cur}"
    elif millions < 1:
        label = f"{round(millions * 1000)} k{sym}" if sym else f"{round(millions * 1000)} k {cur}"
    else:
        val = f"{millions:.1f}".rstrip("0").rstrip(".")
        label = f"{val} M{sym}" if sym else f"{val} M {cur}"
    return {"value_m": round(millions, 3), "currency": cur, "eur_m": round(eur, 3), "label": label}


# ---------------------------------------------------------------- entreprise
_RAISE_VERBS = (r"lève|a levé|levant|boucle|réalise|obtient|sécurise|raises|raised|has raised|is raising|raising|secures|secured|lands|landed|bags|bagged|nabs|"
                r"chalks up|closes|closed|gets|snags|scores|pulls in|attracts|banks|grabs|collects|receives|picks up|rakes in|draws|wins|"
                r"recauda|levanta|consigue|capta|cierra|obtiene|sammelt|erhält|holt sich|sichert sich|raccoglie|chiude|ottiene|recebe|capta|anuncia")
_COMPANY_RX = re.compile(r"^(?P<c>.{2,90}?)\s+(?:" + _RAISE_VERBS + r")\b", re.I)
_DESCRIPTORS = {"das", "die", "der", "the", "la", "le", "les", "el", "il", "lo", "l'", "startup", "start-up", "scaleup", "scale-up", "fintech", "insurtech",
                "healthtech", "edtech", "proptech", "biotech", "medtech", "deeptech", "greentech", "foodtech", "agritech", "cleantech", "company", "firm",
                "platform", "plateforme", "unicorn", "licorne", "jungunternehmen", "unternehmen", "empresa", "société", "pépite", "berliner", "münchner",
                "hamburger", "kölner", "wiener", "züricher", "zürcher", "pariser"}
_CJK_RX = re.compile(r"^(?P<c>[^、，,:：]{2,40})[、，,：:]")


def extract_company(title):
    t = re.sub(r"^\s*(exclusive|exclusif|breaking|funding|scoop|news|deal|deals|update|startup|startups|levée de fonds|financement)\s*[:|—–-]\s*", "", title or "", flags=re.I)
    if ":" in t[:60]:
        t = t.split(":", 1)[1].strip() if _COMPANY_RX.match(t.split(":", 1)[1].strip()) else t
    acq = re.match(r"^(?P<a>.{2,60}?)\s+(?:acquires|acquired|to acquire|rachète|a racheté|s'offre|übernimmt|adquiere|compra|buys|snaps up)\s+(?P<t>.{2,60}?)(?:\s+(?:for|pour|in|para|für|from|,)\b|[,:]|$)", t.strip(), re.I)
    if acq:
        return _clean_name(acq.group("t"))
    m = _COMPANY_RX.match(t.strip())
    if not m:
        c = _CJK_RX.match(t.strip())
        if c and re.search(r"[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]", t):
            return c.group("c").strip()
        return None
    return _clean_name(m.group("c"))


def _clean_name(raw):
    raw = raw.strip(" ,'\"“”‘’«»")
    raw = re.split(r",\s*(?:a|an|the|une?|la|le)\s", raw, flags=re.I)[0]
    tokens = raw.split()
    keep = []
    for tok in reversed(tokens):
        bare = tok.strip(",;()\"'“”«»")
        if not bare:
            continue
        if bare[0].isupper() or bare[0].isdigit() or re.match(r"^[a-z]+[A-Z]", bare) or bare.lower() in ("de", "du", "des", "&", "and", "of", "x", "et", "y", "e", "la"):
            if re.search(r"['’]s$", bare) and keep:  # "Saudi's Orbii" -> on s'arrête au possessif
                break
            keep.append(bare)
            if len(keep) >= 5:
                break
        else:
            break
    while keep and keep[-1].lower() in ("de", "du", "des", "&", "and", "of", "x", "et", "y", "e", "la"):
        keep.pop()
    name = " ".join(reversed(keep)).strip(" -")
    name = re.sub(r"['’]s$", "", name)
    # retire un pays / démonyme en tête ("Saudi Orbii" -> "Orbii", "French AI Nebula" -> "Nebula")
    parts = name.split()
    while len(parts) > 1 and (detect_country(parts[0]) or parts[0].upper() in ("AI", "IA", "SAAS", "B2B", "EV", "UK", "US")):
        parts = parts[1:]
    cut = max([i for i, p in enumerate(parts) if p.lower().strip(",") in _DESCRIPTORS or re.search(r"-(based|backed|born|founded|rival|headquartered|led)$", p, re.I)] + [-1])
    if 0 <= cut < len(parts) - 1:
        parts = parts[cut + 1:]
    name = " ".join(parts)
    if len(name) < 2 or name.lower() in ("startup", "start-up", "the startup", "la startup", "company", "firm"):
        return None
    return name


# ---------------------------------------------------------------- analyse globale
_RAISE_WORDS = re.compile(r"\b(l[eè]ve|lev[ée]e|raises?|raised|raising|secures?|secured|funding|funded|tour de table|financement|investit|backs|backed|"
                          r"closes|lands|bags|nabs|recauda|levanta|ronda|inversión|sammelt|finanzierung|finanzierungsrunde|raccoglie|round|"
                          r"rodada|aporte|investimento|pendanaan|invests?|investment)\b|資金調達|투자 유치|투자유치", re.I)


def analyse(title, summary="", hint_country=None):
    text = f"{title}. {summary}"
    sectors = [k for k, rx in SECTOR_RX.items() if rx and rx.search(text)]
    themes = [k for k, rx in THEME_RX.items() if rx and rx.search(text)]
    stage = next((k for k, rx in STAGE_RX if rx.search(text)), None)
    amount = parse_amount(title) or parse_amount(summary)
    investors = sorted({name for name, rx in INVESTOR_RX if rx.search(text)})
    company = extract_company(title)
    hit = detect_country(title) or detect_country(summary)
    country = hit[0] if hit else None
    if not country and amount and amount["currency"] in CURRENCY_HINT and amount["currency"] != "GBP":
        country = CURRENCY_HINT[amount["currency"]]
    if not country:
        country = hint_country
    raise_words = _RAISE_WORDS.search(text)
    kind = "fund" if stage == "Fonds VC" else ("exit" if stage in ("M&A", "IPO") else "round")
    deal = bool(amount and (raise_words or company)) or bool(stage and stage not in ("M&A", "IPO", "Fonds VC") and raise_words and company)
    if kind == "exit":
        deal = bool(company and (amount or stage == "IPO"))
    if stage is None and deal:
        stage = "Non précisé"
    return {
        "company": company, "amount": amount, "stage": stage, "sectors": sectors, "themes": themes,
        "investors": investors, "country": country, "deal": deal, "kind": kind,
    }
