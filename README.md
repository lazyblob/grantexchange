# PocketGE — Live OSRS Grand Exchange Flipping Tool

[![Live site](https://img.shields.io/badge/Live%20site-pocketge.com-2962FF?style=for-the-badge)](https://pocketge.com)
[![Mobile-first](https://img.shields.io/badge/Mobile-first-FFB300?style=for-the-badge)](https://pocketge.com)
[![Free • No signup](https://img.shields.io/badge/Free-no%20signup-1FB85C?style=for-the-badge)](https://pocketge.com)

**→ [Open PocketGE in your browser](https://pocketge.com)**

A free, mobile-first **Old School RuneScape Grand Exchange** tracker and **OSRS flipping tool** built for merchers who actually act on the data. Live insta-buy and insta-sell prices, target buy/sell anchored to recent fill probability, the 2% GE sales tax baked into every margin, a 5-day breakout scanner, a Bank-of-Gielinor portfolio tracker, and browser push notifications when your favorites break out.

No account. No login. No ads. Runs entirely in your browser; everything you save stays in your own device's storage.

---

## Why PocketGE is different from other OSRS GE trackers

Every other GE tool shows you the raw live margin or a simple historical average. PocketGE adds an **execution layer**:

- **EV-based target prices** — Target Buy / Target Sell aren't a percentile guess. They maximize *expected captured margin* = `P(offer fills) × (margin after 2% GE tax)`. P(fill) is built from a recency- and volume-weighted distribution of the actual recent tape. Too-low bids have fat margins but fill near-zero; too-high bids fill instantly but earn nothing. The product peaks at the realistic sweet spot.
- **2% Grand Exchange sales tax built in** (capped at 5,000,000 gp per item) so the displayed profit is what you actually keep, not a pre-tax illusion.
- **5-day breakout scanner** — sidebar lists items currently testing their true 5-day high or low, built from rolling 1-hour volume-weighted candles. Bounded candidate pool so it never floods the OSRS Wiki API.
- **Volume-split margin lists** — High Vol Margins (100,000+ daily volume staples: gems, ores, bars, arrows, runes) vs. Low Vol Margins (slower-moving items with wider spreads), so you don't tie up capital in a slow item expecting a fast flip.
- **Bank of Gielinor portfolio tracker** with per-stack ±% PnL alerts.
- **Notification Center** with master toggle, test-fire button, and inline per-stack threshold editing — shows you exactly what alerts are armed.
- **Mobile-first PWA** — installable to your phone's home screen, service worker so it loads instantly, designed for tapping at a GE clerk rather than dragging a mouse.

---

## Try it

[**pocketge.com**](https://pocketge.com)

Or jump to a specific item:

| Gems | Ores & Bars | PvM Drops | Rares |
|---|---|---|---|
| [Diamond](https://pocketge.com/?q=Diamond) | [Coal](https://pocketge.com/?q=Coal) | [Twisted bow](https://pocketge.com/?q=Twisted%20bow) | [Gilded scimitar](https://pocketge.com/?q=Gilded%20scimitar) |
| [Ruby](https://pocketge.com/?q=Ruby) | [Adamantite bar](https://pocketge.com/?q=Adamantite%20bar) | [Scythe of vitur](https://pocketge.com/?q=Scythe%20of%20vitur) | [3rd age longsword](https://pocketge.com/?q=3rd%20age%20longsword) |
| [Emerald](https://pocketge.com/?q=Emerald) | [Iron ore](https://pocketge.com/?q=Iron%20ore) | [Bandos chestplate](https://pocketge.com/?q=Bandos%20chestplate) | [Red party hat](https://pocketge.com/?q=Party%20hat%20(red)) |
| [Sapphire](https://pocketge.com/?q=Sapphire) | [Runite bar](https://pocketge.com/?q=Runite%20bar) | [Abyssal whip](https://pocketge.com/?q=Abyssal%20whip) | [Old school bond](https://pocketge.com/?q=Old%20school%20bond) |

---

## Tech

Plain HTML / CSS / vanilla JavaScript, no framework and no bundler. Charts render to a `<canvas>`. State persists in the browser's localStorage. PWA manifest + service worker. Hosted on GitHub Pages.

`index.html` is the app shell; `app.css` and `app.js` hold the rest. They used to be inline in a single 838KB file — they were split out so a prerendered page per item does not have to carry a copy of the whole app, and so the app is downloaded once and cached across navigations.

### Regenerating the static bits

GitHub Pages serves by path, so `/?q=Emerald` and `/?q=Mahogany%20logs` are the same file and cannot differ in their raw HTML. Items with real search demand get a prerendered document at `/item/<slug>/` instead, which carries its own title, description, canonical, H1, summary and related links before any JavaScript runs. `?q=` URLs keep working and canonicalise to the path page when one exists.

Run from the repo root, in order, and commit the output:

```sh
python3 update_items.py        # refresh items-json from the wiki
python3 prerender_items.py     # top 800 by daily volume -> item/<slug>/index.html + item-pages.js
python3 generate_sitemap.py    # path URLs for prerendered items, ?q= for the rest
```

`prerender_items.py` fetches live prices; `--snapshot prices.json` reuses a saved copy, and `--limit N` changes how many items get a page. Re-running rewrites every generated page, so prices in them are a snapshot — the app updates them live on load.

Data sources:
- [OSRS Wiki real-time prices API](https://prices.runescape.wiki/) — live insta-buy / insta-sell, 5-minute / 1-hour / 6-hour / daily candles.
- [Weird Gloop exchange history](https://api.weirdgloop.org/) — long-range historical context for the 1Y / 5Y views.

---

## Disclaimer

PocketGE is an independent fan-made tool. It is **not affiliated with, endorsed by, or sponsored by Jagex Ltd**. RuneScape, Old School RuneScape, and the Grand Exchange are trademarks of Jagex Ltd. PocketGE only reads public price data — it never asks for your RuneScape credentials and never sends your data anywhere.

---

## License

MIT — do whatever you want, just don't claim it broke your account.
