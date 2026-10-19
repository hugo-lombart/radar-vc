#!/usr/bin/env python3
"""
Radar VC — rattrapage de l'historique (jusqu'à 5 ans en arrière).

Interroge Google News mois par mois avec des recherches dans plusieurs langues
et ajoute les levées trouvées à data/deals.json (sans doublons).

Lancé à la main depuis l'onglet Actions > « Remplir l'historique ».
Chaque recherche renvoie au plus ~100 articles par mois : l'historique est donc
un échantillon des levées les plus médiatisées, pas une liste exhaustive.

Usage local : python scripts/backfill.py --years 5
"""

import argparse
import datetime as dt
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch  # noqa: E402

LOG = fetch.DATA / "backfill_log.json"

# (requête, hl, gl, ceid, pays par défaut)
QUERIES = [
    ('"raises" "Series A"', "en-US", "US", "US:en", None),
    ('"raises" "Series B"', "en-US", "US", "US:en", None),
    ('"raises" "Series C" OR "Series D" OR "Series E"', "en-US", "US", "US:en", None),
    ('"raises" "seed round" OR "seed funding"', "en-US", "US", "US:en", None),
    ('"pre-seed" raises', "en-US", "US", "US:en", None),
    ('startup raises million funding', "en-US", "US", "US:en", None),
    ('startup raises funding round', "en-GB", "GB", "GB:en", "GB"),
    ('startup raises funding crore', "en-IN", "IN", "IN:en", "IN"),
    ('African startup raises', "en-US", "US", "US:en", None),
    ('startup raises UAE OR Saudi OR Egypt', "en-US", "US", "US:en", None),
    ('Israeli startup raises', "en-US", "US", "US:en", "IL"),
    ('startup raises Singapore OR Indonesia OR Vietnam', "en-SG", "SG", "SG:en", None),
    ('startup raises funding', "en-AU", "AU", "AU:en", "AU"),
    ('startup raises funding', "en-CA", "CA", "CA:en", "CA"),
    ('"lève" millions startup', "fr", "FR", "FR:fr", "FR"),
    ('Startup Finanzierungsrunde Millionen', "de", "DE", "DE:de", "DE"),
    ('startup ronda de financiación millones', "es", "ES", "ES:es", "ES"),
    ('startup round milioni di euro', "it", "IT", "IT:it", "IT"),
    ('startup rodada de investimento milhões', "pt-BR", "BR", "BR:pt-419", "BR"),
    ('startup ronda de inversión millones', "es-419", "MX", "MX:es-419", "MX"),
    ('スタートアップ 資金調達 億円', "ja", "JP", "JP:ja", "JP"),
    ('스타트업 투자 유치 억원', "ko", "KR", "KR:ko", "KR"),
]


def month_windows(years):
    today = dt.date.today().replace(day=1)
    for i in range(1, years * 12 + 1):
        y, m = divmod(today.year * 12 + today.month - 1 - i, 12)
        start = dt.date(y, m + 1, 1)
        y2, m2 = divmod(y * 12 + m + 1, 12)
        yield start, dt.date(y2, m2 + 1, 1)


def git_commit(msg):
    cmds = [["git", "add", "data/deals.json", "data/backfill_log.json"],
            ["git", "commit", "-m", msg], ["git", "pull", "--rebase", "-X", "theirs"], ["git", "push"]]
    for c in cmds:
        subprocess.run(c, check=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, default=5)
    ap.add_argument("--pause", type=float, default=1.5, help="secondes entre deux requêtes")
    ap.add_argument("--git", action="store_true", help="commit + push tous les 6 mois traités")
    args = ap.parse_args()

    fetch.DATA.mkdir(parents=True, exist_ok=True)
    store = fetch.DealStore(fetch.load_json(fetch.OUT_DEALS, {}).get("deals", []))
    done = set(fetch.load_json(LOG, {}).get("done", []))
    before = len(store.deals)

    for n, (start, end) in enumerate(month_windows(args.years), 1):
        month = start.strftime("%Y-%m")
        added = 0
        for qi, (q, hl, gl, ceid, hint) in enumerate(QUERIES):
            key = f"{month}|{qi}"
            if key in done:
                continue
            url = fetch.google_news_url(q, hl, gl, ceid, window=f"after:{start.isoformat()} before:{end.isoformat()}")
            for attempt in range(3):
                try:
                    entries = fetch.fetch_feed(url)
                    break
                except Exception as e:
                    if "vide" in str(e):
                        entries = []
                        break
                    fetch.log(f"{month} q{qi}: {e} (nouvel essai dans {20 * (attempt + 1)} s)")
                    time.sleep(20 * (attempt + 1))
            else:
                continue  # on réessaiera au prochain lancement
            for art, info in fetch.parse_entries(entries, f"GN historique", hint, True, limit=100):
                if art["deal"] and art["date"][:7] >= month:
                    before_n = len(store.deals)
                    store.add(fetch.deal_record(art, info, art["source"]))
                    added += len(store.deals) - before_n
            done.add(key)
            time.sleep(args.pause)
        fetch.log(f"{month} : +{added} levées (total {len(store.deals)})")
        fetch.save_deals(store)
        LOG.write_text(json.dumps({"done": sorted(done)}), encoding="utf-8")
        if args.git and n % 6 == 0:
            git_commit(f"Historique : jusqu'à {month}")

    fetch.save_deals(store)
    fetch.write_countries()
    LOG.write_text(json.dumps({"done": sorted(done)}), encoding="utf-8")
    fetch.log(f"Terminé : {len(store.deals) - before} levées ajoutées, {len(store.deals)} au total")
    if args.git:
        git_commit("Historique : rattrapage terminé")


if __name__ == "__main__":
    main()
