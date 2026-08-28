#!/usr/bin/env python3
"""Regenerate sitemap.xml with every GE-tradeable item.

Reads ./items-json (kept fresh by update_items.py), keeps only items that are
actually tradeable on the Grand Exchange, folds duplicate names, and writes a
single sitemap (well under the 50,000-URL / 50 MB limits) whose item URLs use
exactly the /?q=<Name> encoding the app itself produces via
encodeURIComponent — so the URL Google crawls is byte-identical to the
canonical the page declares about itself.

Run from the repo root after update_items.py:  python3 generate_sitemap.py
"""
import argparse
import json
import re
from datetime import date
from pathlib import Path
from urllib.parse import quote

SITE = "https://pocketge.com"
ITEMS_DIR = Path("./items-json")
OUT = Path("./sitemap.xml")

# encodeURIComponent leaves - _ . ! ~ * ' ( ) unescaped; match it exactly so
# sitemap URL == the canonical the SPA sets (history.replaceState uses it).
ENC_SAFE = "-_.!~*'()"


def ge_items():
    seen = {}
    for f in ITEMS_DIR.glob("*.json"):
        try:
            it = json.loads(f.read_text())
        except Exception:
            continue
        if not it.get("tradeable_on_ge"):
            continue
        if it.get("noted") or it.get("placeholder") or it.get("stacked") or it.get("duplicate"):
            continue
        key = it["name"].lower()
        # A few names exist under several ids (charge variants etc.) — one URL
        # per name, since the app resolves ?q= by name.
        if key not in seen or it["id"] < seen[key]["id"]:
            seen[key] = it
    return sorted(seen.values(), key=lambda it: it["name"].lower())



def slugify(name):
    """Must match slugify() in prerender_items.py and itemSlug() in app.js.
    "+" becomes a word so the (p)/(p+)/(p++) families stay distinct."""
    return re.sub(r"[^a-z0-9]+", "-",
                  name.lower().replace("(-)", " minus ").replace("+", " plus ")).strip("-")


def prerendered_names():
    """Which items prerender_items.py actually wrote a page for. Read from its
    output rather than recomputed, so a sitemap entry can never promise a page
    that was not generated."""
    try:
        txt = Path("./item-pages.js").read_text()
        return {n.lower() for n in json.loads(re.search(r"=\s*(\[.*\])\s*;", txt, re.S).group(1))}
    except Exception:
        return set()

# Items released AFTER the items-json snapshot (it's an osrsbox archive that
# stops around 2021). The live app resolves ?q= names against the live wiki
# mapping, so these URLs work in production — they just need sitemap entries
# until update_items.py gets a fresh dump. Keep names EXACTLY as in-game.
EXTRA_NAMES = [
    # 2026 — The Blood Moon Rises (Maggot King)
    "Crimson kisten", "Necklace of rupture", "Etched elder venator fang",
    "Etched alpha venator tooth", "Venator tooth",
    # 2025 — Doom of Mokhaiotl / Yama / Royal Titans
    "Avernic treads", "Eye of ayak", "Confliction gauntlets", "Mokhaiotl cloth",
    "Oathplate helm", "Oathplate chest", "Oathplate legs", "Soulflame horn",
    "Twinflame staff", "Giantsoul amulet", "Deadeye prayer scroll",
    "Mystic vigour prayer scroll",
    # 2024 — Araxxor / Colosseum / Tormented demons / Hueycoatl
    "Amulet of rancour", "Noxious halberd", "Araxyte fang",
    "Tonalztics of ralos", "Sunfire fanatic helm", "Sunfire fanatic cuirass",
    "Sunfire fanatic chausses", "Emberlight", "Scorching bow", "Purging staff",
    "Burning claws", "Tormented synapse", "Hueycoatl hide", "Dragon hunter wand",
    "Sunfire splinters",
]


def mapping_items(path):
    """Item names from a saved live-mapping snapshot, when one was passed.

    items-json is an osrsbox archive that stops around 2021, which is why
    EXTRA_NAMES below exists at all — a hand-kept list of items released since,
    added one at a time as somebody noticed. The live mapping is the same list
    the app searches, so when the snapshot carries it there is nothing left for
    that list to catch up on."""
    try:
        snap = json.loads(Path(path).read_text())
    except Exception:
        return set()
    return {it["name"] for it in snap.get("mapping") or [] if it.get("name")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot", help="price snapshot JSON; its mapping, when "
                                       "present, replaces the stale items-json list")
    args = ap.parse_args()
    live = mapping_items(args.snapshot) if args.snapshot else set()
    items = ge_items()
    today = date.today().isoformat()
    rows = [
        f"{SITE}/|{today}|daily|1.0",
        f"{SITE}/flipping-guide.html|{today}|monthly|0.8",
        f"{SITE}/high-vol-margins.html|{today}|daily|0.8",
        f"{SITE}/low-vol-margins.html|{today}|daily|0.8",
        f"{SITE}/reliable-14d-margins.html|{today}|weekly|0.7",
        f"{SITE}/biggest-losers-24h.html|{today}|daily|0.8",
        f"{SITE}/at-5d-highs.html|{today}|weekly|0.7",
        f"{SITE}/at-5d-lows.html|{today}|weekly|0.7",
        f"{SITE}/burnt-food-collectors.html|{today}|monthly|0.6",
        f"{SITE}/high-alch-calculator.html|{today}|daily|0.8",
        f"{SITE}/cannonball-profit-calculator.html|{today}|daily|0.7",
    ]
    names = live or {it["name"] for it in items}
    all_names = sorted(names | set(EXTRA_NAMES), key=str.lower)
    # Items with a prerendered page get their PATH url — that is the one they
    # declare as canonical, and listing ?q= for them would point Google at a
    # URL whose raw HTML is the generic shell. Everything else keeps ?q=,
    # which is still exactly what those pages canonicalise to.
    prerendered = prerendered_names()
    for name in all_names:
        if name.lower() in prerendered:
            rows.append(f"{SITE}/item/{slugify(name)}/|{today}|daily|0.7")
        else:
            rows.append(f"{SITE}/?q={quote(name, safe=ENC_SAFE)}|{today}|daily|0.7")

    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for row in rows:
        loc, lastmod, freq, prio = row.split("|")
        loc = loc.replace("&", "&amp;")
        out.append(f"  <url><loc>{loc}</loc><lastmod>{lastmod}</lastmod>"
                   f"<changefreq>{freq}</changefreq><priority>{prio}</priority></url>")
    out.append("</urlset>")
    OUT.write_text("\n".join(out) + "\n")
    src = "live mapping" if live else "items-json (stale)"
    print(f"Wrote {OUT} — {len(rows)} URLs ({len(all_names)} items from the {src}, "
          f"{len(set(EXTRA_NAMES) - names)} still coming from the hand-kept extras).")


if __name__ == "__main__":
    main()
