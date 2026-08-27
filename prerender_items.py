#!/usr/bin/env python3
"""Prerender a static page per item at /item/<slug>/index.html.

Why this exists: pocketge.com is static files on GitHub Pages, which serves by
PATH. `/?q=Emerald` and `/?q=Mahogany%20logs` are the same file, so a query
string can never select a prerendered document -- every ?q= URL shipped
byte-identical HTML and only differed once JavaScript had run. Path URLs are
the only shape that can carry per-item HTML on this host.

What each generated page contains before a line of JS runs: the item's title,
description, canonical, OG/Twitter tags, JSON-LD, an itemised <h1>, a summary
paragraph with live-at-build-time prices, and real links to related items.

What it deliberately does NOT contain: the 30-day range and the after-tax
margin sentence. The range needs a timeseries request per item (800 of them
against a free community API for something the client fills in a second later)
and the margin comes from the target-price engine in app.js, which is not
worth reimplementing in Python where it could silently disagree. Both appear
as soon as the app hydrates -- renderItemSeo rewrites the block wholesale.

Run from the repo root, after update_items.py:

    python3 prerender_items.py            # top 800 by daily volume
    python3 prerender_items.py --limit 50 # smaller set
    python3 prerender_items.py --snapshot prices.json   # reuse a fetched snapshot
"""
import argparse
import json
import re
import shutil
import sys
import urllib.request
from datetime import date
from pathlib import Path

SITE = "https://pocketge.com"
API = "https://prices.runescape.wiki/api/v1/osrs"
UA = "pocketge.com prerender (contact: hi@pocketge.com)"
ITEMS_DIR = Path("./items-json")
OUT_DIR = Path("./item")
TEMPLATE = Path("./index.html")
PAGES_JS = Path("./item-pages.js")


# ── item list ─────────────────────────────────────────────────────────────
def ge_items():
    """GE-tradeable items, one per name — the same filter generate_sitemap.py
    applies, so the two files can never disagree about what exists."""
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
        if key not in seen:
            # items-json calls it buy_limit; the API's mapping (and therefore
            # every .limit read in app.js) calls it limit. Normalise here or
            # every generated page claims the item has no buy limit — which is
            # what the first run did, including for Emerald at 13,000.
            it["limit"] = it.get("limit") or it.get("buy_limit") or 0
            seen[key] = it
    return list(seen.values())


def slugify(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s


# ── price snapshot ────────────────────────────────────────────────────────
def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def price_snapshot(path=None):
    """Last-known prices baked into the HTML. A snapshot file can be passed in
    so the fetch is separable from the render — useful in CI, and the only way
    to run this where the API is unreachable."""
    if path:
        return json.loads(Path(path).read_text())
    snap = {"latest": fetch(f"{API}/latest")["data"],
            "volumes": fetch(f"{API}/volumes")["data"],
            "fetched": date.today().isoformat()}
    return snap


# ── copy ──────────────────────────────────────────────────────────────────
def is_plural(name):
    """Mirrors isPluralName() in app.js: head noun is the last word, or the
    FIRST when the name contains " of " ("Ring of coins" is one ring). -ss and
    -us stay singular so "Molten glass" and "Cactus" read right."""
    parts = name.split()
    if not parts:
        return False
    head = parts[0] if " of " in name.lower() else parts[-1]
    w = head.lower()
    return w.endswith("s") and not (w.endswith("ss") or w.endswith("us"))


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def gp(n):
    return f"{int(n):,}"


def abbrev(n):
    n = int(n)
    if n >= 1_000_000_000:
        return f"{n/1_000_000_000:.2f}B"
    if n >= 1_000_000:
        return f"{n/1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return str(n)


def summary_html(it, buy, sell, vol):
    """The short form renderItemSeo builds, minus the two clauses that need
    client-side computation (30-day range, after-tax margin). Kept in step
    with it by hand — if that template changes, this is the other half.
    No spread figure: printing both prices says it, and not claiming one
    retires the zero and negative cases this sentence used to special-case."""
    name = esc(it["name"])
    are = "are" if is_plural(it["name"]) else "is"
    out = f'<b>{name}</b> {are} <b>{gp(buy)} gp</b> on the OSRS GE'
    if sell:
        out += f' (insta-sell {gp(sell)} gp)'
    out += '.'
    if vol:
        out += f' ~{abbrev(vol)}/day.'
    return out


def qa_html(it):
    """One line. The price question repeated what the sentence above just
    said; the buy limit is the only fact the paragraph does not already
    carry, since it names the limit only as "per 4h limit"."""
    return ('<p><b>Buy limit:</b> ' +
            (f'{it["limit"]:,} every 4 hours.</p>' if it.get("limit")
             else 'none on this item.</p>'))


def related_html(it, by_name, vol_of, pages):
    """Same matcher as relatedItems() in app.js: longest word first, falling
    back through the rest so compound names reach their family. Only links to
    items that actually have a page — a link to a 404 is worse than no link."""
    STOP = {"of", "the", "and", "grimy", "raw", "cooked", "uncut", "super", "half"}
    words = sorted([w for w in re.split(r"[^a-z0-9]+", it["name"].lower())
                    if len(w) >= 4 and w not in STOP], key=len, reverse=True)
    for key in words:
        hits = [x for n, x in by_name.items()
                if key in n and x["id"] != it["id"] and slugify(x["name"]) in pages]
        if hits:
            hits.sort(key=lambda x: vol_of.get(str(x["id"]), 0), reverse=True)
            links = [f'<a href="/item/{slugify(x["name"])}/">{esc(x["name"])}</a>'
                     for x in hits[:4]]
            return 'Related: ' + '<span class="is-sep">·</span>'.join(links)
    return ""


# ── page assembly ─────────────────────────────────────────────────────────
def build_page(tpl, it, slug, buy, sell, vol, related):
    name = esc(it["name"])
    url = f"{SITE}/item/{slug}/"
    title = f"{name} Price OSRS — {gp(buy)} gp · Live GE Chart & Flip Margin | PocketGE"
    # "Mahogany logs IS 155 gp" was going out as the SERP snippet while the
    # summary right below it said "are" — the plural rule was applied to the
    # on-page copy and not to the description.
    desc = (f'{name} {"are" if is_plural(it["name"]) else "is"} {gp(buy)} gp on the OSRS Grand Exchange'
            + (f' (insta-buy {gp(buy)}, insta-sell {gp(sell)})' if sell else '')
            + '. Live chart & flip margin after 2% tax'
            + (f' · {abbrev(vol)} traded/day' if vol else '')
            + (f' · {abbrev(it["limit"])} buy limit' if it.get("limit") else '') + '.')
    s = tpl
    s = re.sub(r"<title>.*?</title>", f"<title>{title}</title>", s, count=1, flags=re.S)
    for attr, key, val in (("name", "description", desc), ("property", "og:title", title),
                           ("property", "og:description", desc), ("property", "og:url", url),
                           ("name", "twitter:title", title), ("name", "twitter:description", desc)):
        s = re.sub(rf'(<meta {attr}="{re.escape(key)}" content=")[^"]*(")',
                   lambda m: m.group(1) + val + m.group(2), s, count=1)
    s = re.sub(r'(<link rel="canonical" href=")[^"]*(")',
               lambda m: m.group(1) + url + m.group(2), s, count=1)
    s = re.sub(r'(<h1 class="sr-only" id="seoH1">).*?(</h1>)',
               lambda m: m.group(1) + f"{name} price in OSRS — live Grand Exchange data" + m.group(2),
               s, count=1, flags=re.S)
    # the SEO block, filled and visible
    s = s.replace('<section class="item-seo" id="itemSeo" hidden>\n'
                  '  <p class="is-sum" id="isSummary"></p>\n'
                  '  <div class="is-qa" id="isQa"></div>\n'
                  '  <p class="is-rel" id="isRelated" hidden></p>\n'
                  '</section>',
                  '<section class="item-seo" id="itemSeo">\n'
                  f'  <p class="is-sum" id="isSummary">{summary_html(it, buy, sell, vol)}</p>\n'
                  f'  <div class="is-qa" id="isQa">{qa_html(it)}</div>\n'
                  + (f'  <p class="is-rel" id="isRelated">{related}</p>\n' if related
                     else '  <p class="is-rel" id="isRelated" hidden></p>\n')
                  + '</section>', 1)
    # per-item icon alt, and the bootstrap the app reads instead of ?q=
    s = s.replace('alt="Live OSRS Grand Exchange price tracker — selected item icon"',
                  f'alt="{name} — OSRS Grand Exchange item icon"', 1)
    boot = ('<script>window.__PGE_ITEM__=' +
            json.dumps({"id": it["id"], "name": it["name"], "slug": slug},
                       separators=(",", ":")) + ';</script>\n')
    jsonld = ('<script type="application/ld+json" id="itemJsonLd">' + json.dumps([
        {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "PocketGE", "item": SITE + "/"},
            {"@type": "ListItem", "position": 2, "name": it["name"], "item": url}]},
        {"@context": "https://schema.org", "@type": "ItemPage", "name": title,
         "description": desc, "url": url, "dateModified": date.today().isoformat()},
    ], separators=(",", ":")) + "</script>\n")
    s = s.replace("</head>", boot + jsonld + "</head>", 1)
    # The about + FAQ prose is identical on every page and 43KB of each one:
    # 35MB across the set, and for search, 797 documents whose bulk is the
    # same text as each other and as the homepage. The homepage keeps it; the
    # item pages keep only what is about their item. (The drawer's
    # "meet the dev" link falls back to /#meet-the-dev — see app.js.)
    cut = s.find('<section class="about-section"')
    end = s.rfind("</body>")
    if cut > 0 and end > cut:
        s = s[:cut] + s[end:]
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=800,
                    help="how many items to prerender, ranked by daily volume")
    ap.add_argument("--snapshot", help="path to a saved price snapshot JSON")
    ap.add_argument("--save-snapshot", help="write the fetched snapshot here")
    args = ap.parse_args()

    tpl = TEMPLATE.read_text()
    items = ge_items()
    print(f"{len(items):,} GE-tradeable items")

    try:
        snap = price_snapshot(args.snapshot)
    except Exception as e:
        sys.exit(f"could not get prices ({e}). Pass --snapshot with a saved copy.")
    if args.save_snapshot:
        Path(args.save_snapshot).write_text(json.dumps(snap))
    latest, volumes = snap["latest"], snap["volumes"]

    # rank by daily volume — where the search demand actually is
    priced = [it for it in items if str(it["id"]) in latest
              and (latest[str(it["id"])] or {}).get("high")]
    priced.sort(key=lambda it: volumes.get(str(it["id"]), 0), reverse=True)
    chosen = priced[:args.limit]

    # slugs first: related links may only point at pages that will exist
    pages, by_name = {}, {}
    for it in chosen:
        slug = slugify(it["name"])
        if not slug or slug in pages:
            continue          # a collision would overwrite a page; skip, don't guess
        pages[slug] = it["name"]
        by_name[it["name"].lower()] = it

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)   # stale pages must not outlive the set
    n = 0
    for slug, name in pages.items():
        it = by_name[name.lower()]
        L = latest[str(it["id"])]
        buy, sell = L.get("high") or 0, L.get("low") or 0
        vol = volumes.get(str(it["id"]), 0)
        if not buy:
            continue
        rel = related_html(it, by_name, volumes, pages)
        d = OUT_DIR / slug
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(build_page(tpl, it, slug, buy, sell, vol, rel))
        n += 1

    # the set the app reads, so it canonicalises and links to pages that exist
    PAGES_JS.write_text("/* generated by prerender_items.py — do not edit */\n"
                        "window.__PGE_PAGES__=" +
                        json.dumps(sorted(pages.values()), separators=(",", ":")) + ";\n")
    total = sum(f.stat().st_size for f in OUT_DIR.rglob("*.html"))
    print(f"wrote {n:,} pages under {OUT_DIR}/  ({total/1e6:.1f} MB)")
    print(f"wrote {PAGES_JS} ({PAGES_JS.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
