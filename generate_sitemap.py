#!/usr/bin/env python3
"""Regenerate sitemap.xml with every GE-tradeable item.

Reads ./items-json (kept fresh by update_items.py), keeps only items that are
actually tradeable on the Grand Exchange, folds duplicate names, and writes a
single sitemap (well under the 50,000-URL / 50 MB limits) listing the items
that have a prerendered /item/<slug>/ page — the URLs whose served HTML is
actually about that item, and which declare themselves canonical.

Items without a page are deliberately absent: their /?q=<Name> URL is served
index.html verbatim, so a sitemap entry would advertise the homepage under
2,944 different addresses. They stay reachable through the app and through
related-item links; they are just not claimed as pages.

Run from the repo root after update_items.py:  python3 generate_sitemap.py
"""
import argparse
import json
import re
from datetime import date
from pathlib import Path

SITE = "https://pocketge.com"
ITEMS_DIR = Path("./items-json")
OUT = Path("./sitemap.xml")

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


# How often each standalone page changes, and how much it matters. Anything
# not named here still gets listed, at the default below -- the list decides
# WEIGHT, never membership.
PAGE_WEIGHTS = {
    "high-vol-margins.html": ("daily", "0.8"),
    "low-vol-margins.html": ("daily", "0.8"),
    "biggest-losers-24h.html": ("daily", "0.8"),
    "high-alch-calculator.html": ("daily", "0.8"),
    "flipping-guide.html": ("monthly", "0.8"),
    "cannonball-profit-calculator.html": ("daily", "0.7"),
    "reliable-14d-margins.html": ("weekly", "0.7"),
    "at-5d-highs.html": ("weekly", "0.7"),
    "at-5d-lows.html": ("weekly", "0.7"),
    "runelite-plugin.html": ("monthly", "0.7"),
    "burnt-food-collectors.html": ("monthly", "0.6"),
}
# index.html is the "/" row, added separately. og-image.source.html is the
# artwork the link-preview PNG is screenshotted from -- no canonical, nothing
# links to it, not a page.
NOT_PAGES = {"index.html", "og-image.source.html"}


def static_pages(today):
    """Every standalone page on disk, rather than a list somebody remembers to
    update. The list was hand-kept and had silently dropped
    runelite-plugin.html -- a real page, with its own canonical, that Google
    was therefore never told about. Deriving from the filesystem means adding
    a page is enough to get it indexed."""
    out = []
    for f in sorted(Path(".").glob("*.html")):
        if f.name in NOT_PAGES:
            continue
        freq, prio = PAGE_WEIGHTS.get(f.name, ("weekly", "0.6"))
        out.append(f"{SITE}/{f.name}|{today}|{freq}|{prio}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot", help="price snapshot JSON; its mapping, when "
                                       "present, replaces the stale items-json list")
    args = ap.parse_args()
    live = mapping_items(args.snapshot) if args.snapshot else set()
    items = ge_items()
    today = date.today().isoformat()
    rows = [f"{SITE}/|{today}|daily|1.0"] + static_pages(today)
    names = live or {it["name"] for it in items}
    all_names = sorted(names | set(EXTRA_NAMES), key=str.lower)
    # ONLY items with a prerendered page. The ?q= form was the item URL scheme
    # before /item/<slug>/ pages existed, and it cannot work as one: GitHub
    # Pages resolves by path, so every /?q=<Name> is served index.html
    # byte-for-byte -- 2,944 URLs whose raw HTML is the same document, each
    # declaring <link rel="canonical" href="https://pocketge.com/">. Only the
    # app's own JS rewrites that canonical per item, and the indexing pass that
    # decides "duplicate or not" reads the raw HTML.
    #
    # So listing them contradicted the pages themselves: the sitemap said "2,944
    # distinct pages worth indexing", the HTML said "all of these are the
    # homepage". Search Console resolved that the way it always does -- 1,849
    # Crawled - currently not indexed, and rising, against 1,719 real item pages
    # competing for the same crawl budget.
    #
    # The canonical -> "/" is CORRECT for these legacy URLs; the sitemap entry
    # was the wrong half. Dropping it costs no reachable content: /?q= still
    # works, is still what related-item links use for an item with no page of
    # its own, and is still what the app puts in the address bar.
    prerendered = prerendered_names()
    for name in all_names:
        if name.lower() in prerendered:
            rows.append(f"{SITE}/item/{slugify(name)}/|{today}|daily|0.7")

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
    listed = sum(1 for n in all_names if n.lower() in prerendered)
    print(f"Wrote {OUT} — {len(rows)} URLs: {listed} item pages listed, "
          f"{len(all_names) - listed} items skipped for having no prerendered page "
          f"(reachable at /?q=, not claimed as pages). "
          f"{len(all_names)} items from the {src}, "
          f"{len(set(EXTRA_NAMES) - names)} from the hand-kept extras.")


if __name__ == "__main__":
    main()
