#!/usr/bin/env python3
"""Prerender a static page per item at /item/<slug>/index.html.

Why this exists: pocketge.com is static files on GitHub Pages, which serves by
PATH. `/?q=Emerald` and `/?q=Mahogany%20logs` are the same file, so a query
string can never select a prerendered document -- every ?q= URL shipped
byte-identical HTML and only differed once JavaScript had run. Path URLs are
the only shape that can carry per-item HTML on this host.

What each generated page contains before a line of JS runs: the item's title,
description, canonical, OG/Twitter tags, JSON-LD, an itemised <h1>, a summary
paragraph with live-at-build-time prices, its members/F2P status, its move
against the 24-hour average, its buy limit, its high-alch value and the real
alch margin after a nature rune, links to related items — and, from
detail_html(), roughly 280 words of prose about that item specifically: its
examine text, what its buy limit costs to fill, which of the three GE tax cases
it falls in, its alch break-even price, how liquid it is, and a short FAQ.

That last part is why the pages are worth having. Measured before it existed, a
page carried 59 unique words against ~1,594 words of app shell repeated on all
1,719 of them; seven sampled pages shared 741 words and differed by 11-23.
Search Console's verdict on that was 1,849 URLs "Crawled - currently not
indexed" and climbing. Google had fetched the pages and decided they were the
same document.

What it deliberately does NOT contain: the 30-day range and the after-tax
margin sentence. The range needs a timeseries request per item (~1,700 of them
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
from datetime import date, datetime
from pathlib import Path

SITE = "https://pocketge.com"
API = "https://prices.runescape.wiki/api/v1/osrs"
UA = "pocketge.com prerender (contact: hi@pocketge.com)"
ITEMS_DIR = Path("./items-json")
OUT_DIR = Path("./item")
TEMPLATE = Path("./index.html")
PAGES_JS = Path("./item-pages.js")


# ── item list ─────────────────────────────────────────────────────────────
def ge_items(mapping=None):
    """GE-tradeable items, one per name.

    The live wiki mapping is the source when we have it, and items-json is the
    fallback. That order matters: items-json is an osrsbox archive that stops
    around 2021, and 476 of its records are name-and-buy-limit skeletons with
    id=None scraped from the wiki's buying-limits table. The filter below drops
    every one of them, so items released since — Sunfire splinters, Demon tear,
    Aether rune, Huasca, Ancient brew, the antler bolts — could never be
    prerendered no matter how heavily they traded. Sunfire splinters is in the
    app's own default watchlist and still had no page.

    The mapping is the same list app.js searches, so building from it means the
    prerendered set can never again lag the app's idea of what exists."""
    if mapping:
        seen = {}
        for it in mapping:
            if not it.get("name") or it.get("id") is None:
                continue
            seen.setdefault(it["name"].lower(), {**it, "limit": it.get("limit") or 0})
        return list(seen.values())

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


# ── categories pinned in regardless of volume ─────────────────────────────
# Ranking by daily volume is a good default and a bad rule for a flipper's
# shopping list. Poisoned arrow and bolt variants, low-dose potions and the
# quieter teleport tablets all trade below the cutoff (~18k/day at 800 pages)
# yet are exactly the things people search for by name. These are pinned in at
# whatever volume they happen to do, so the set stops depending on where the
# cutoff lands this month.
_POTION = re.compile(r"potion|mix|brew|serum|antidote|anti-?venom|anti-?poison"
                     r"|restore|elixir", re.I)
_F2P_RUNES = {"air rune", "water rune", "earth rune", "fire rune",
              "mind rune", "body rune"}
_FOOD = {"shark", "monkfish", "karambwan", "cooked karambwan", "anglerfish",
         "manta ray", "sea turtle", "lobster", "swordfish", "tuna", "trout",
         "salmon", "bass", "dark crab", "cake", "jug of wine", "pineapple pizza",
         "summer pie", "wild pie", "admiral pie", "mushroom pie",
         "cooked chicken", "bread", "potato with cheese", "tuna potato"}
_HERBS = ["guam", "marrentill", "tarromin", "harralander", "ranarr", "toadflax",
          "irit", "avantoe", "kwuarm", "snapdragon", "cadantine", "lantadyme",
          "dwarf weed", "torstol", "huasca"]
# High-value PvM gear. The --top-value rule below already selects on price and
# would catch most of this on its own, but a godsword or a Bandos piece can sit
# an order of magnitude under a Twisted bow and fall outside whatever N is set
# to. These are named so the guarantee does not depend on where that cutoff
# lands. Family terms, not exact names, so each one covers the pieces, the
# ornament-kit variants and the "... armour set" / "... robes set" GE items.
_LUXURY = re.compile(
    r"scythe of vitur|twisted bow|torva|inquisitor|soulreaper|oathplate"
    r"|elysian|3rd age|bandos|armadyl|godsword|voidwaker|ancestral|virtus"
    r"|masori|tumeken|sanguinesti|justiciar|primordial|pegasian|eternal boots"
    r"|avernic|zaryte|dragon claws|harmonised|volatile orb|eldritch"
    r"|dinh's|ferocious gloves|venator bow|amulet of rancour|nightmare staff"
    r"|osmumten|ancient godsword|infernal|dragon warhammer|spirit shield",
    re.I)


def is_pinned(name):
    n = name.lower()
    return bool(
        # runes: the F2P four are high-volume anyway, this is for the rest
        (n.endswith(" rune") and n not in _F2P_RUNES and "essence" not in n)
        or "sunfire splinter" in n or "zulrah" in n or "demon tear" in n
        or "revenant ether" in n or "cannonball" in n
        or _LUXURY.search(name)
        # Bonds trade too thinly to clear the volume cutoff and are one of the
        # most searched prices in the game -- the case pinning is for. The word
        # boundary keeps it to the two bond items and nothing else.
        or re.search(r"\bbonds?\b", n)
        # Match "teleport" as a word anywhere, not as a suffix. The live
        # mapping names the actual tablets "Varrock teleport (tablet)", so an
        # endswith() test pinned the obscure scroll-style ones -- Ardeaglais,
        # Lumberyard, Nardah -- and missed all ten of the tablets people
        # actually flip. Those were in the set only because volume happened to
        # carry them, which is the exact dependency pinning exists to remove.
        or re.search(r"\bteleports?\b", n)
        or re.search(r"\bbolts?\b", n) or re.search(r"\barrows?\b", n)
        # darts and dart tips together: the tip is the buy side of the same
        # trade, so a page for one without the other is half a flip
        or re.search(r"\bdarts?\b", n) or "dart tip" in n
        or ("bones" in n or "ashes" in n)
        # ores and the bars they smelt into: same trade, both sides
        or re.search(r"\bores?\b", n) or re.search(r"\bbars?\b", n)
        # Any potion word, with or without a dose suffix. Requiring "(n)"
        # excluded the whole unfinished-potion stage -- Ranarr potion (unf) and
        # its fourteen siblings -- which is a herblore staple and half of that
        # trade. Checked against the live names: this catches nothing that is
        # not a potion.
        or _POTION.search(name)
        # raw and cooked together, same reasoning as darts and dart tips
        or n in _FOOD or (n.startswith("raw ") and n[4:] in _FOOD)
        or any(n in (h, "grimy " + h, h + " leaf", "grimy " + h + " leaf",
                     h + " weed", "grimy " + h + " weed") for h in _HERBS)
        or (n.endswith(" seed") and n.split()[0] in {h.split()[0] for h in _HERBS})
    )


def slugify(name):
    # "+" has to survive as a word. Stripping it as punctuation collapsed
    # "Adamant bolts (p)", "(p+)" and "(p++)" onto one slug -- 116 such
    # collisions across 318 names -- and the caller skips a taken slug, so two
    # of every three poisoned variants were silently dropped and the surviving
    # page sat at a URL naming a different item. The plain variant keeps the
    # bare slug it already has, so no published URL stops resolving.
    # "(-)" marks the weaker Nightmare Zone variant and is the same trap:
    # "Antipoison (-)(1)" and "Antipoison(1)" are different items.
    s = name.lower().replace("(-)", " minus ").replace("+", " plus ")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


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
            # One bulk call for every item, not one per item. Deliberately NOT
            # /timeseries: that is a request per item -- 1,691 a run against a
            # volunteer-run API -- for a 30-day range the app already fetches
            # on demand for real visitors.
            "day": fetch(f"{API}/24h")["data"],
            # the item universe, so the set can never lag what the app can see
            "mapping": fetch(f"{API}/mapping"),
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


def summary_html(it, buy, sell, vol, avg24=0, nature=0):
    """The short form renderItemSeo builds, minus the two clauses that need
    client-side computation (30-day range, after-tax margin). Kept in step
    with it by hand — if that template changes, this is the other half.
    No spread figure: printing both prices says it, and not claiming one
    retires the zero and negative cases this sentence used to special-case."""
    name = esc(it["name"])
    are = "are" if is_plural(it["name"]) else "is"
    out = f'<b>{name}</b> {are} <b>{gp(buy)} gp</b> on the OSRS GE'
    # Only quote the sell side when it is BELOW the buy side. Above it means
    # the two prints are from different moments, not that there is money in
    # it, and printing the pair anyway invites the subtraction: pinning the
    # thin categories put 177 such pages in the set, up to
    # "1 gp ... (insta-sell 10,000 gp)". Dropping the spread FIGURE in #357 was
    # not enough — two numbers side by side state a spread whether or not the
    # sentence names one.
    if sell and sell <= buy:
        out += f' (insta-sell {gp(sell)} gp)'
    out += '.'
    if sell and sell > buy:
        out += ' Both sides last traded at different times — no live spread to quote.'
    # Facts that were already in hand and being discarded. Every clause below
    # is a NEW fact, not a restatement: the brief that shortened this block was
    # about repetition, and a page carrying forty unique words is its own
    # problem. These cost no extra API call -- members and highalch ride along
    # in the mapping, and the nature rune's price is already in the snapshot.
    tail = [f'~{abbrev(vol)}/day'] if vol else []
    tail.append('members' if it.get("members") else 'F2P')
    out += ' ' + ' · '.join(tail) + '.'
    if avg24 and buy:
        pct = (buy - avg24) / avg24 * 100
        if abs(pct) >= 1:
            out += f' {"Up" if pct > 0 else "Down"} {abs(pct):.0f}% on its 24-hour average.'
    return out


def qa_html(it, buy=0, nature=0):
    """Reference facts about the item, as opposed to the price sentence above.
    The buy limit was the only one the paragraph did not already carry; high
    alch is the second, and it belongs here rather than in the paragraph
    because keeping that to one scannable line was the point of #357."""
    out = ('<p><b>Buy limit:</b> ' +
           (f'{it["limit"]:,} every 4 hours.</p>' if it.get("limit")
            else 'none on this item.</p>'))
    # People search "<item> high alch" by name, and the nature rune's own live
    # price is already in the snapshot -- so the real margin is free to state
    # rather than left as an exercise for the reader.
    alch = int(it.get("highalch") or 0)
    if alch > 0:
        out += f'<p><b>High alch:</b> {gp(alch)} gp'
        # The margin only when it is worth acting on. Stating the loss for
        # everything produced "Twisted bow ... alching loses 1,398,288,996 gp"
        # -- true, and the same broken-template reading that "a 0 gp spread"
        # had. Nobody alches a 1.4B bow; the alch VALUE is the searched fact
        # there, and the margin is noise.
        net = (alch - buy - nature) if (buy and nature) else 0
        out += f' — alching profits {gp(net)} gp after a nature rune.</p>' if net > 0 else '.</p>'
    return out


# ── the long form ─────────────────────────────────────────────────────────
# Measured before this existed: an item page carried 59 unique words against
# ~1,594 words of app shell that is identical on all 1,719 of them. Seven pages
# sampled shared 741 words and differed by 11-23. That ratio is what
# "Crawled - currently not indexed" means -- Google fetched the page, found it
# was substantially the same document as the last one, and kept neither.
#
# Everything below is derived from data already in the snapshot, and is written
# to BRANCH on the item rather than to substitute numbers into one sentence: a
# tax-exempt item, a sub-50gp item and a 250M item get three different
# paragraphs, an item nobody alches gets no alch section at all. Templating is
# unavoidable at 1,700 pages; sameness is not.

# The Grand Exchange does not tax these. The 2% is otherwise universal, so
# printing "you will pay 2%" on one of them would be a wrong fact on exactly
# the page someone checks before buying in bulk.
TAX_EXEMPT = {
    "old school bond", "chisel", "gardening trowel", "glassblowing pipe",
    "hammer", "needle", "pestle and mortar", "rake", "saw", "secateurs",
    "seed dibber", "shears", "spade", "watering can",
}
TAX_RATE = 0.02
TAX_CAP = 5_000_000          # a flat 5M above a 250M sale price
TAX_FREE_UNDER = 50          # 2% of 49 rounds down to nothing


def ge_tax(price):
    """What the seller loses to the Grand Exchange on one item at this price.
    Rounded down, which is the whole reason sub-50gp sales are untaxed."""
    return min(TAX_CAP, int(price * TAX_RATE))


def _liquidity(vol):
    """How a daily volume reads to someone deciding whether to commit gold.
    Bands rather than the raw number alone: 714,300 and 172 want different
    advice, not the same sentence with a different figure in it."""
    if vol >= 1_000_000:
        return ("one of the busiest items on the Grand Exchange",
                "orders at a fair price fill in minutes")
    if vol >= 100_000:
        return ("heavily traded",
                "orders at a fair price usually fill quickly")
    if vol >= 10_000:
        return ("steadily traded",
                "an order priced at the spread normally fills the same hour")
    if vol >= 1_000:
        return ("moderately traded",
                "an order may take a while to fill, so price it toward the middle")
    if vol >= 100:
        return ("thinly traded",
                "an order can sit for hours, and a large one can move the price")
    return ("very thinly traded",
            "there may be no buyer for hours at a time, and one sale can set the price")


def _sentences(parts):
    """Join clauses as SENTENCES. Built with ". ".join() first, which produced
    "...every 4 hours. filling that once costs..." on every page that had a buy
    limit -- a lowercase letter after a full stop, 1,719 times."""
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        out.append(p[0].upper() + p[1:] if p[0].islower() else p)
    return " ".join(x if x.endswith((".", "!", "?", "”", "&rdquo;")) else x + "."
                    for x in out)


def detail_html(it, buy, sell, vol, nature, when):
    """The per-item prose. Stable facts first (examine, limit, alch value,
    members, base value), because those do not go stale between runs; the
    price-dependent lines name the date they were taken, so a reader looking at
    a figure the live terminal above them disagrees with can see why."""
    name = esc(it["name"])
    plural = is_plural(it["name"])
    are, s_have = ("are", "have") if plural else ("is", "has")
    it_them = "them" if plural else "it"
    lower = it["name"].lower()
    limit = int(it.get("limit") or 0)
    alch = int(it.get("highalch") or 0)
    base = int(it.get("value") or 0)
    out = []

    # ── what it is ────────────────────────────────────────────────────────
    # The examine text is the one piece of genuinely human-written, genuinely
    # per-item prose anywhere in the data, and it was going unused.
    bits = []
    ex = str(it.get("examine") or "").strip()
    if ex:
        # Its own period, not an added one: "examined as “This looks valuable.”."
        bits.append(f'In game {"they are" if plural else "it is"} examined as '
                    f'&ldquo;{esc(ex.rstrip("."))}.&rdquo;')
    bits.append(f'{name} {are} '
                + ("members-only, so a membership is needed to trade or use "
                   + it_them if it.get("members")
                   else "available to free-to-play accounts"))
    if base > 0:
        bits.append(f'the base game value is {gp(base)} gp, which is what shops '
                    f'price from rather than what players pay')
    out.append(f'<h2>About {name}</h2><p>{_sentences(bits)}</p>')

    # ── buy limit ─────────────────────────────────────────────────────────
    if limit > 0:
        # Characterised, not just stated: an 8-per-4-hours limit and a
        # 13,000-per-4-hours limit are different facts about how the item can
        # be traded, and saying so is what stops this being one sentence with
        # the number swapped out 1,719 times.
        if limit >= 10_000:
            shape = ("that is a generous limit, so the market rather than the "
                     "limit is usually what caps a position here")
        elif limit >= 1_000:
            shape = "that is enough to build a real position inside a day"
        elif limit >= 100:
            shape = "that is a tight limit, so building size takes several cycles"
        else:
            shape = ("that is a very tight limit, so a position is built over days "
                     "rather than hours")
        cap = [f'the Grand Exchange lets one account buy <b>{limit:,}</b> every '
               f'4 hours', shape]
        if buy:
            cap.append(f'filling it once costs about {gp(limit * buy)} gp at the '
                       f'{gp(buy)} gp price recorded on {when}')
        cap.append("the limit is per account and resets on a rolling 4-hour timer")
        out.append(f'<h2>{name} buy limit</h2><p>{_sentences(cap)}</p>')
    else:
        out.append(f'<h2>{name} buy limit</h2><p>{name} {s_have} no Grand Exchange '
                   f'buy limit, so the only cap on a position is the gold behind '
                   f'{it_them}.</p>')

    # ── tax ───────────────────────────────────────────────────────────────
    if lower in TAX_EXEMPT:
        tax_p = (f'{name} {are} one of the few items the Grand Exchange does not '
                 f'tax at all, so a sale returns the full price and the whole '
                 f'spread is yours.')
    elif buy and buy < TAX_FREE_UNDER:
        tax_p = (f'The 2% sale tax is rounded down, and at {gp(buy)} gp it rounds '
                 f'to nothing — sales under {TAX_FREE_UNDER} gp are untaxed, so a '
                 f'flip here keeps its whole margin.')
    elif buy and ge_tax(buy) >= TAX_CAP:
        tax_p = (f'2% of {gp(buy)} gp would be {gp(int(buy * TAX_RATE))} gp, but the '
                 f'Grand Exchange caps its tax at {gp(TAX_CAP)} gp per item — so a '
                 f'sale near this price pays a flat {gp(TAX_CAP)} gp, and the '
                 f'effective rate falls the higher the price goes.')
    elif buy:
        tax_p = (f'Selling at {gp(buy)} gp costs {gp(ge_tax(buy))} gp in tax — 2%, '
                 f'rounded down, taken from the seller. A flip has to clear that '
                 f'before it makes anything, and it is the number most margin '
                 f'calculators leave out.')
    else:
        tax_p = ('The Grand Exchange takes 2% of the sale price from the seller, '
                 'rounded down, capped at 5,000,000 gp per item.')
    out.append(f'<h2>GE tax on {name}</h2><p>{tax_p}</p>')

    # ── high alch ─────────────────────────────────────────────────────────
    # The break-even price is the durable, useful number: it moves with the
    # nature rune rather than with the item, and it answers the question people
    # search ("is alching this worth it?") instead of restating a constant.
    #
    # Every branch here is a case the first version got wrong: an item whose
    # alch value is below a nature rune produced "only pays while Bucket of sand
    # is under -95 gp", and a Twisted bow produced "loses 1,401,000,096 gp a
    # cast" -- true, and the same broken-template reading that a 0 gp spread had.
    if alch > 0:
        breakeven = alch - nature if nature else 0
        head = (f'High alchemy turns {name if plural else "one " + name} into '
                f'<b>{gp(alch)} gp</b>')
        if not nature:
            a = [head]
        elif alch <= nature:
            a = [head, f'that is less than the {gp(nature)} gp nature rune the '
                       f'cast costs, so alching {name} always loses money']
        elif buy and buy < breakeven:
            a = [head, f'with a nature rune at {gp(nature)} gp it profits '
                       f'<b>{gp(alch - buy - nature)} gp</b> a cast at the '
                       f'{gp(buy)} gp price recorded on {when}']
        elif buy and buy < alch * 3:
            a = [head, f'with a nature rune at {gp(nature)} gp that only pays below '
                       f'<b>{gp(breakeven)} gp</b>, and {name} {are} {gp(buy)} gp '
                       f'— so alching {it_them} loses {gp(buy + nature - alch)} gp '
                       f'a cast right now']
        else:
            # Far above the alch value. Nobody alches a 1.4B bow; the alch VALUE
            # is the searched fact there and the margin is noise.
            a = [head, f'{name} {are} worth far more than that on the Grand '
                       f'Exchange, so the figure matters for the alch calculator '
                       f'rather than as anything to do']
        # The nature rune's own page, otherwise: "with a nature rune at 96 gp,
        # Nature rune only pays below 12 gp".
        if lower == "nature rune":
            a = [head, 'this is the rune every other alch is cast with, so its '
                       'price sets the break-even on every alchable item in the game']
        out.append(f'<h2>High alching {name}</h2><p>{_sentences(a)}</p>')

    # ── liquidity ─────────────────────────────────────────────────────────
    if vol:
        band, advice = _liquidity(vol)
        # "About 172 change hands a day" has no subject. "sees N trades" reads
        # for a singular and a plural name alike, without pluralising the name.
        liq = [f'{name} {"see" if plural else "sees"} about <b>{abbrev(vol)}</b> '
               f'trades a day, which makes {it_them} {band} — {advice}']
        if limit > 0:
            share = vol / limit
            liq.append(f'that is roughly {share:,.0f} times the {limit:,} buy limit'
                       if share >= 2 else
                       f'that is less than twice the {limit:,} buy limit, so a '
                       f'handful of buyers can take a whole day of supply')
        out.append(f'<h2>How much {name} {"trade" if plural else "trades"}</h2>'
                   f'<p>{_sentences(liq)}</p>')

    # ── FAQ ───────────────────────────────────────────────────────────────
    # Plain prose, not FAQPage structured data. Google restricted FAQ rich
    # results to government and health sites in 2023, so the markup would buy
    # nothing -- and marking up invisible content is exactly what had 1,694
    # pages shipping a fourteen-question FAQPage for a FAQ they did not contain.
    faq = []
    if buy:
        faq.append((f'How much {are} {name} in OSRS?',
                    f'{name} {are} {gp(buy)} gp on the Grand Exchange as of {when}'
                    + (f', with an insta-sell of {gp(sell)} gp' if sell and sell <= buy else '')
                    + '. The chart above is live.'))
    faq.append((f'What is the buy limit for {name}?',
                f'{limit:,} every 4 hours.' if limit else
                f'{name} {s_have} no buy limit.'))
    if alch > 0 and nature:
        if alch <= nature:
            ans = (f'No — the alch value is {gp(alch)} gp and the nature rune alone '
                   f'costs {gp(nature)} gp.')
        elif buy and buy < alch - nature:
            ans = (f'Yes — {gp(alch)} gp alch value against a {gp(buy)} gp price and '
                   f'a {gp(nature)} gp nature rune, so {gp(alch - buy - nature)} gp '
                   f'a cast.')
        else:
            ans = (f'Not at the moment — the alch value is {gp(alch)} gp and a nature '
                   f'rune costs {gp(nature)} gp, so it only pays below '
                   f'{gp(alch - nature)} gp.')
        faq.append((f'Can you high alch {name} for profit?', ans))
    faq.append((f'Do you need members for {name}?',
                f'Yes, {name} {are} members-only.' if it.get("members")
                else 'No, free-to-play accounts can buy and sell ' + it_them + '.'))
    out.append(f'<h3>{name} FAQ</h3>'
               + ''.join(f'<p><b>{q}</b> {a}</p>' for q, a in faq))
    return ''.join(out)


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
def build_page(tpl, it, slug, buy, sell, vol, related, avg24=0, nature=0, when=""):
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
    # The SEO block, filled and visible. Matched as a whole section rather than
    # as one exact multi-line literal: the literal had to be kept byte-identical
    # to the markup, so adding a line to the block in index.html (the guide
    # link) would silently match nothing and ship 800 pages with an empty
    # summary. This raises instead, and the guide link is carried through from
    # the template so its copy lives in one place.
    guide = re.search(r'( *<p class="is-guide">.*?</p>\n)', s, re.S)
    block = re.search(r' *<section class="item-seo" id="itemSeo" hidden>.*?</section>', s, re.S)
    if not block:
        raise SystemExit("index.html has no item-seo block to fill — markup changed?")
    s = (s[:block.start()]
         + '<section class="item-seo" id="itemSeo">\n'
         + f'  <p class="is-sum" id="isSummary">{summary_html(it, buy, sell, vol, avg24, nature)}</p>\n'
         + f'  <div class="is-qa" id="isQa">{qa_html(it, buy, nature)}</div>\n'
         # data-item-id so the app can drop this when the visitor searches a
         # DIFFERENT item from an item page: the summary and Q&A above are
         # re-rendered live, but this block is prerendered for one item only,
         # and leaving it would print Emerald's buy limit under a Twisted bow.
         # See renderItemSeo() in app.js.
         + f'  <div class="is-detail" id="isDetail" data-item-id="{it["id"]}">'
         + f'{detail_html(it, buy, sell, vol, nature, when)}</div>\n'
         + (f'  <p class="is-rel" id="isRelated">{related}</p>\n' if related
            else '  <p class="is-rel" id="isRelated" hidden></p>\n')
         + (guide.group(1) if guide else '')
         + '</section>'
         + s[block.end():])
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
    # ...but the FAQ's STRUCTURED DATA sits in <head> and survived that cut, so
    # every item page was shipping an 8.9KB FAQPage block declaring fourteen
    # Questions that the page does not contain -- the prose describing them was
    # removed three lines up. Google's rule is explicit: do not mark up content
    # that is not visible to the reader. Wrong on 1,694 pages, and ~15MB of the
    # set. The homepage, which does show the FAQ, keeps it.
    s = drop_faq_jsonld(s)
    return s


def drop_faq_jsonld(s):
    """Remove the FAQPage block only, leaving the other JSON-LD alone.

    Matched by parsing each ld+json block rather than by one regex over the
    whole document: the blocks sit next to each other, so a greedy pattern
    would take the WebApplication and WebSite entities with it, and a lazy one
    stops at the first </script> whichever block that belongs to."""
    out, idx = [], 0
    for m in re.finditer(r'\s*<script type="application/ld\+json"[^>]*>(.*?)</script>', s, re.S):
        if '"FAQPage"' in m.group(1):
            out.append(s[idx:m.start()])
            idx = m.end()
    out.append(s[idx:])
    return "".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=800,
                    help="how many items to prerender, ranked by daily volume")
    ap.add_argument("--top-value", type=int, default=400,
                    help="also prerender this many of the most expensive items, "
                         "which volume ranking never reaches")
    ap.add_argument("--snapshot", help="path to a saved price snapshot JSON")
    ap.add_argument("--save-snapshot", help="write the fetched snapshot here")
    args = ap.parse_args()

    tpl = TEMPLATE.read_text()

    try:
        snap = price_snapshot(args.snapshot)
    except Exception as e:
        sys.exit(f"could not get prices ({e}). Pass --snapshot with a saved copy.")
    if args.save_snapshot:
        Path(args.save_snapshot).write_text(json.dumps(snap))
    latest, volumes = snap["latest"], snap["volumes"]
    day = snap.get("day") or {}
    # Nature rune's own live insta-buy, so the alch line quotes a real cost
    # instead of a constant that goes stale. 561 is the nature rune.
    nature_price = int((latest.get("561") or {}).get("high") or 0)
    # Written into the prose wherever a price is quoted, so a reader looking at
    # a figure that no longer matches the live terminal above it can see why.
    try:
        when = datetime.strptime(snap.get("fetched") or "", "%Y-%m-%d").strftime("%-d %B %Y")
    except Exception:
        when = date.today().strftime("%-d %B %Y")

    items = ge_items(snap.get("mapping"))
    src = "live wiki mapping" if snap.get("mapping") else "items-json (STALE — no mapping in snapshot)"
    print(f"{len(items):,} GE-tradeable items, from the {src}")

    # rank by daily volume — where the search demand actually is
    priced = [it for it in items if str(it["id"]) in latest
              and (latest[str(it["id"])] or {}).get("high")]
    priced.sort(key=lambda it: volumes.get(str(it["id"]), 0), reverse=True)
    chosen = priced[:args.limit]

    # Then the most expensive items, ranked by price rather than by turnover.
    # Volume ranking cannot reach them: a Twisted bow trades a handful of times
    # a day, so the whole high-value tier -- scythes, torva, ancestral, virtus,
    # godswords, 3rd age -- scored zero pages under volume alone. That tier is
    # also where the highest-intent searches are, since nobody looks up a
    # 1.5B price idly. Selecting on price keeps this true for items that do not
    # exist yet, which a list of names cannot.
    px = lambda it: (latest[str(it["id"])] or {}).get("high") or 0
    by_value = sorted(priced, key=px, reverse=True)[:args.top_value]

    # then the pinned categories, wherever they landed in either ranking.
    # Appended rather than merged into the sort so --limit keeps meaning
    # "how deep into the volume ranking to go" and the extras stay visible.
    seen_ids = {it["id"] for it in chosen}
    value_pins = [it for it in by_value if it["id"] not in seen_ids]
    seen_ids |= {it["id"] for it in value_pins}
    pins = [it for it in priced if it["id"] not in seen_ids and is_pinned(it["name"])]
    seen_ids |= {it["id"] for it in pins}

    # Finally, anything that ALREADY has a published page and is still a real,
    # priced item keeps it.
    #
    # Without this the set is recomputed from scratch every run, so an item
    # drifting a few places down the volume ranking loses its URL. The last
    # run did exactly that to 95 items -- Wool, Cod, Compost, Shortbow, Rune
    # dagger -- while the set as a whole GREW from 797 to 1,688. They had not
    # stopped existing or stopped trading; the population they were ranked
    # against changed. Repeat that monthly and Google spends the year watching
    # a thousand URLs appear and vanish, which is worse for the site than any
    # of them being marginal.
    #
    # An item can still lose its page by leaving the mapping or losing its
    # price, which are the only two cases where there is nothing to render.
    previous = set()
    if PAGES_JS.exists():
        try:
            previous = {n.lower() for n in json.loads(
                re.search(r"=\s*(\[.*\])\s*;", PAGES_JS.read_text(), re.S).group(1))}
        except Exception:
            previous = set()
    kept = [it for it in priced
            if it["id"] not in seen_ids and it["name"].lower() in previous]

    chosen = chosen + value_pins + pins + kept
    cut = volumes.get(str(priced[args.limit - 1]["id"]), 0) if len(priced) >= args.limit else 0
    vcut = px(by_value[-1]) if by_value else 0
    print(f"top {min(args.limit, len(priced)):,} by volume (cutoff ~{cut:,.0f}/day) "
          f"+ {len(value_pins):,} by value (down to {vcut:,.0f} gp) "
          f"+ {len(pins):,} pinned + {len(kept):,} kept from the last run "
          f"= {len(chosen):,}")
    if previous:
        lost = len(previous) - len({n.lower() for n in previous}
                                   & {it["name"].lower() for it in chosen})
        print(f"  {lost:,} previously published item(s) could not be kept "
              f"(gone from the mapping, or no live price)")

    # slugs first: related links may only point at pages that will exist
    pages, by_name, dropped = {}, {}, []
    for it in chosen:
        slug = slugify(it["name"])
        if not slug or slug in pages:
            # A collision still has to be skipped -- two items cannot share a
            # URL -- but it is reported now. Silently dropping them is how 318
            # names ended up sharing 116 slugs without anyone noticing, and how
            # /item/adamant-arrow-p/ came to serve "Adamant arrow(p++)".
            dropped.append(f'{it["name"]} -> {slug or "(empty)"}')
            continue
        pages[slug] = it["name"]
        by_name[it["name"].lower()] = it
    if dropped:
        print(f"  {len(dropped)} skipped for slug collisions: {', '.join(dropped[:6])}"
              + (" ..." if len(dropped) > 6 else ""))

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
        avg24 = int((day.get(str(it["id"])) or {}).get("avgHighPrice") or 0)
        (d / "index.html").write_text(
            build_page(tpl, it, slug, buy, sell, vol, rel, avg24, nature_price, when))
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
