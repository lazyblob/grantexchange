const $ = s => document.querySelector(s);
const PRICES_API = "https://prices.runescape.wiki/api/v1/osrs";
const WEIRD_GLOOP_API = "https://api.weirdgloop.org/exchange/history/osrs";

/* tunable knobs */
const LOW_VOL_THRESHOLD = 100000;
const SCAN_VOL_POOL = 60;
const SCAN_PRICE_POOL = 40;
const SCAN_CONCURRENCY = 4;

/* ── Recommended-flip ("Find me a flip") ─────────────────────────────────────
   Surfaces one concrete, engine-certified flip and lets the user cycle to the
   next. API-safe: the pool is ranked from bulk data already in memory (0 calls);
   the full trade engine is run only on a tiny shortlist we actually intend to
   show, and every shown pick must pass runTradeEngine(...).viable === true. */
const REC_SHORTLIST   = 5;        // items we fetch /timeseries for & engine-confirm per scan
const REC_MIN_VOL     = 30000;    // liquidity floor (units/day); engine re-gates
const REC_MIN_VOL_RELAX = 8000;   // relaxed floor for the one widen-retry pass
const REC_MAX_MARGIN_PCT = 0.25;  // >25% net /latest spread => stale/manip => skip
const REC_MAX_AGE     = 2 * 3600; // both live legs must have printed within 2h
const REC_NO_LIMIT_QTY = 1000;    // stand-in per-cycle qty for items with no buy limit
const REC_FILL_SHARE  = 0.10;     // assume you capture ~10% of flow in a 4h window
const REC_SEEN_TTL    = 3 * 3600e3;
const REC_SEEN_RESET_N = 40;
const REC_SEEN_KEY    = 'ge_recSeen';
const REC_SCAN_COOLDOWN = 25000;  // ms: throttle repeated empty/Try-again scans

let recBuffer = [];    // confirmed-viable recs, ranked (session, in-memory; each carries .series)
let recIdx = -1;
let recBusy = false;
let recLastId = null;  // never the same item twice in a row
let recScanGen = 0;    // bumped on universe toggle/reset to invalidate in-flight scans
let recLastScanAt = 0;
let recLastWasEmpty = false;
/* Default landing pool — instead of always loading Uncut diamond, pick a
   random F2P, GE-tradeable, high-volume staple each visit. Makes the first-
   paint feel "live" and gives organic visitors variety. Every entry is
   well-known and has dense daily volume so the chart paints a busy real-
   market view (not a sparse low-volume tape).
     1601 Diamond   1617 Uncut diamond   1603 Ruby   1619 Uncut ruby
     1605 Emerald   1607 Sapphire        1891 Cake
     453  Coal      440  Iron ore        2349 Iron bar  2353 Steel bar
     2359 Mithril bar  2361 Adamantite bar  2363 Runite bar
     892  Rune arrow   2   Cannonball   7936 Pure essence
     561  Nature rune  563 Law rune    560 Death rune
     1515 Yew logs     1513 Magic logs */
const LANDING_POOL = ['1601','1617','1603','1619','1605','1607','1891','453','440','2349','2353','2359','2361','2363','892','2','7936','561','563','560','1515','1513'];
function pickLandingId() {
  return LANDING_POOL[Math.floor(Math.random() * LANDING_POOL.length)];
}
const LANDING_ID = '1617'; // fallback if random pick fails to resolve in mapping
/* Now that the landing interstitial is gone, the first thing a new visitor
   sees IS an item chart — so which item it is stopped being cosmetic. A
   blind random pick from the pool lands on a flat tape about as often as
   not, and "nothing is happening here" is a poor first frame for a tool
   whose whole pitch is watching the market.
   So: rank the pool by how much it has actually moved in the last 24h and
   open on one of the movers. Movement, not margin — the margin is what the
   Recommended Flip panel is for, and it computes asynchronously after the
   first paint, so keying the opening chart to it would either delay the
   paint or swap the item out from under the visitor a second later. The
   24h numbers are already in hand by the time this runs (boot awaits
   loadLatest / load24h before choosing), so this costs nothing.
   Top FIVE then random among them, not the single biggest mover: a repeat
   visitor should not get the same chart every time, and the difference
   between the 1st and 5th mover is not something anyone can perceive. */
const LANDING_TOP_N = 5;
function pickLandingItem(isEligible) {
  try {
    if (!Array.isArray(mapping) || !mapping.length || !latest || !past24h) return null;
    const scored = [];
    for (const id of LANDING_POOL) {
      const m = mapping.find(x => String(x.id) === id);
      if (!m || !isEligible(m)) continue;
      const L = latest.data && latest.data[id];
      const H = past24h.data && past24h.data[id];
      if (!L || !H) continue;
      const now = (Number(L.high) + Number(L.low)) / 2;
      const then = (Number(H.avgHighPrice) + Number(H.avgLowPrice)) / 2;
      if (!(now > 0) || !(then > 0)) continue;
      /* Volume floor: on a thin item a couple of odd offers swing the
         percentage wildly, and opening on that reads as a broken chart
         rather than an active one. The pool is all high-volume staples, so
         this only rejects an item whose feed is having a bad moment. */
      const vol = (H.highPriceVolume || 0) + (H.lowPriceVolume || 0);
      if (vol < 1000) continue;
      scored.push({ m, move: Math.abs((now - then) / then) });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.move - a.move);
    const top = scored.slice(0, LANDING_TOP_N);
    return top[Math.floor(Math.random() * top.length)].m;
  } catch (e) { return null; }
}

let mapping = [], latest = null, past24h = null, volumes = null, selected = null;
/* Captured HERE, at parse time, before boot writes the flag — the value has
   to mean "had been here before this page load", not "has been here by now".
   applyTitleBadge uses it to keep the "(2)" breakout badge out of the title
   on a first render, which is what stops a crawler indexing
   "(2) Ruby Price OSRS...". Read live from localStorage it would flip to
   true mid-session and defeat that. */
const isReturningVisitor = (() => {
  try { return localStorage.getItem('ge_visited') === '1'; } catch (e) { return false; }
})();
let currentSeries = null, view = "1d", zoom = 1.0, offset = 0;
/* The timeframe the USER last clicked. `view` can get bumped wider per-item
   when the preferred view is too sparse to draw (see setItem); switching to
   a liquid item snaps back to this. */
let preferredView = "1d";
/* TradingView-style manual y-axis scale. 1 = auto-fit. Dragging the price
   axis multiplies the visible range around its midpoint: >1 widens the
   range (chart flattens), <1 narrows it (swings amplify). Reset on item /
   timeframe change and by double-tapping the axis. */
let yScale = 1;
/* Vertical pan, as a FRACTION of the visible price range rather than a gp
   amount — so it stays proportionate when the range changes underneath it,
   which it does constantly: zooming the x-axis re-fits the y-axis to fewer
   points, and that re-fit is exactly what pushes a target line off-screen.
   Reset alongside yScale. */
let yOffset = 0;
/* Per-item % change for each timeframe. Each timeframe BUTTON prints its
   own figure, so the header no longer repeats the active one next to the
   price — same number twice, a few hundred pixels apart. Still computed
   here because the mini trend charts colour themselves from it. */
let viewChanges = {};
/* #tickerChange survives for one job only: the over-max path parks an
   "Estimated Value" note there, because those items have an aggregated
   price rather than a live one and that needs saying. Every normal item
   render clears it, so that note can't outlive the item it describes. */
function clearHeaderChange() {
  const el = document.getElementById('tickerChange');
  if (!el) return;
  el.className = 'change neutral';
  el.innerHTML = '';
}
/* Y-axis always sits on the right edge — TradingView convention. On desktop
   it also lands right next to the favorites sidebar, so scanning the price
   scale and the watchlist stays under one mouse position. On portrait
   phones it's the thumb side. */
function yAxisOnRight() {
  return true;
}
/* The 30-day insight sits below the chart on desktop (a full-width band), but
   in portrait-mobile it belongs BELOW the Potential Profit / Analyst Rating
   module so those decision numbers are the first thing under the chart. The
   two blocks live in different containers (insight in .main-column, the module
   in .watchlist-container), so a plain CSS `order` can't swap them — relocate
   the node by media query instead. renderItemInsight targets it by id, so
   moving it never breaks the live updates. */
/* One query now, not two. Landscape mobile used to need its own branch (park
   the card below the whole app, because the app is pinned to 100dvh and the
   block form had nowhere to go inside it); the inline form fits that row at
   844px the same way it fits at 1440, so landscape and desktop are the same
   case and the second query is gone. */
const _insightPortraitMQ = window.matchMedia('(max-width: 640px)');
/* Back after briefly being deleted. The one-line meter does fit the row at
   844px in a headless viewport, which is what that deletion was measured on —
   but on a real landscape phone the main column is narrower still, and
   Fill/VP/Refresh + meter + Spread/Vol together pushed the figures under the
   sidebar. So landscape keeps a branch: same one-line form, its own line. */
const _insightLandscapeMQ = window.matchMedia('(max-height: 600px) and (orientation: landscape) and (pointer: coarse)');
function placeItemInsight() {
  const insight = document.getElementById('itemInsight');
  const sideModule = document.getElementById('sideModule');
  const quickFacts = document.getElementById('quickFacts');
  if (!insight || !sideModule || !quickFacts) return;
  /* One switch for the presentation, separate from the three for position:
     portrait gets the stacked card in the sidebar, everything else the
     one-liner — whether that line is in the row or under it. */
  insight.classList.toggle('is-inline', !_insightPortraitMQ.matches);
  if (_insightPortraitMQ.matches) {
    // portrait: drop it just under the Potential Profit / Analyst module
    if (insight.previousElementSibling !== sideModule) sideModule.after(insight);
  } else {
    /* Everywhere else — desktop AND landscape mobile — the meter goes INSIDE
       the quick-facts row, which runs hundreds of px of empty between
       Refresh and the Spread/Vol figures (measured 808px at 1440, 268px at
       844 landscape). The inline form is one line and adds nothing to the
       row's height, so this costs the chart nothing and removes a ~70px band
       from the page.
       An earlier version of this function deliberately anchored AFTER the
       row for exactly the opposite reason — dropping the block form in here
       squashed the strip and stranded Refresh mid-line. What changed is the
       block form: `.qf-row .item-insight` lays it out as a single line that
       flexes, rather than a centred card that demanded its own width.
       Landscape mobile used to park it above the about-section, below the
       whole app, because the app is pinned to 100dvh and there was no room
       inside it. There is now. */
    const qfRow = document.getElementById('quickFactsRow');
    if (!qfRow) { if (quickFacts.nextElementSibling !== insight) quickFacts.after(insight); }
    else if (_insightLandscapeMQ.matches) {
      // its own line, immediately under the row
      if (qfRow.nextElementSibling !== insight) qfRow.after(insight);
    } else if (insight.parentElement !== qfRow) qfRow.appendChild(insight);
  }
}
placeItemInsight();
// .about-section is parsed after this script, so re-run once the DOM is ready
// (the landscape branch anchors to it).
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', placeItemInsight);
[_insightPortraitMQ, _insightLandscapeMQ].forEach(mq => {
  if (mq.addEventListener) mq.addEventListener('change', placeItemInsight);
  else if (mq.addListener) mq.addListener(placeItemInsight);
});

/* Touch device — used by the chart draw to give the volume pane a smaller
   share of a phone's plot. Hoisted rather than called per draw, and it is a
   live MediaQueryList so plugging in a mouse re-evaluates on the next frame
   without a listener. */
const _coarseMQ = window.matchMedia('(pointer: coarse)');

/* Share belongs with the chart, not with the Analyst Rating. What it
   publishes is the ITEM — name, chart, 30-day range, targets, margin after
   tax — and parking it in the gauge's header said it published the rating,
   which is why that button needed a hover tooltip explaining it did not.
   Two homes, chosen by width:
     >=1024px  the ticker header, after the timeframe pills, in the band
               that ran empty between 5Y and the sidebar
     narrower  the quick-facts row, next to Refresh and Fill/VP, where the
               rest of the chart's controls already are
   Still the real node and never a clone, so the existing click handler and
   shareCard()'s $('#btnShare') lookup keep working untouched.
   Both hosts are static: nothing rebuilds #tickerHeader or #quickFactsRow
   by innerHTML. That is not incidental — living in #sideModule is what
   required three separate blocks elsewhere to rescue this node before a
   rebuild destroyed it outright, and moving out of that subtree retires all
   three. */
const _shareWideMQ = window.matchMedia('(min-width: 1024px)');
/* Does the ticker header have room for Share alongside everything else?
   MEASURED, not thresholded. A fixed width was the obvious approach and is
   wrong here for the same reason the .fav-btn label rule below already
   documents: the title group's floor is content-driven, so the header that
   fits a 650gp "Ruby" does not fit a 59,930,778 "Gilded scimitar", and the
   number would have to assume the worst case at every width.
   Worse, the breaking points are not even monotonic — measured by sweeping
   the sidebar splitter, the header is fine at 686px, clips 5Y at 666, is
   fine again at 626 (the max-width:620 query drops the Save label and buys
   back ~60px), clips again at 586, and finally wraps the glyph onto a line
   of its own at 486. No single threshold describes that.
   The toolbar's scrollWidth, not its rendered width: it is `flex: 0 1 auto`
   with its own overflow, so rendered it is whatever it was squeezed to, and
   the question is whether its CONTENT fits. Using scrollWidth also makes
   this answer independent of where Share currently is, which is what stops
   moving it out (freeing room) from immediately moving it back in. */
function _rowFitsShare(excludeToolbar) {
  const hdr = document.getElementById('tickerHeader');
  const tb = document.getElementById('timeToolbar');
  const shareBtn = document.getElementById('btnShare');
  if (!hdr || !tb || !shareBtn) return true;
  const gap = parseFloat(getComputedStyle(hdr).columnGap) || 0;
  let need = 0, n = 0;
  for (const el of hdr.children) {
    if (el === shareBtn || getComputedStyle(el).display === 'none') continue;
    if (el === tb) { if (excludeToolbar) continue; need += tb.scrollWidth + (n ? gap : 0); n++; continue; }
    need += el.getBoundingClientRect().width + (n ? gap : 0);
    n++;
  }
  need += shareBtn.getBoundingClientRect().width + gap;
  return need <= hdr.getBoundingClientRect().width;
}
/* Has the toolbar taken a row of its own? Asked geometrically — is it below
   the item name — rather than by comparing its width to the header's. The
   width comparison was the first attempt and silently never fired: the
   toolbar's `flex: 1 1 100%` is 100% of the CONTENT box, while clientWidth
   includes the header's 4px of side padding, so it measured 8px short at
   every width and the name-row placement never happened.
   True regardless of where Share currently sits, so reading it cannot feed
   back on the placement it decides. */
function _toolbarOwnsARow() {
  const hdr = document.getElementById('tickerHeader');
  const tb = document.getElementById('timeToolbar');
  if (!hdr || !tb) return false;
  const shareBtn = document.getElementById('btnShare');
  let firstTop = null;
  for (const el of hdr.children) {
    if (el === tb || el === shareBtn || getComputedStyle(el).display === 'none') continue;
    const b = el.getBoundingClientRect().bottom;
    if (firstTop === null || b > firstTop) firstTop = b;
  }
  return firstTop !== null && tb.getBoundingClientRect().top >= firstTop - 2;
}
function placeShareButton() {
  const shareBtn = document.getElementById('btnShare');
  if (!shareBtn) return;
  /* Positioned against a SIBLING, not appended to a host. Two reasons, both
     of which bit: the ticker header is already Share's markup parent, so a
     "have we got the right parent yet" guard early-returns and leaves it
     sitting where the source put it, in front of the toolbar rather than
     after it. And the quick-facts row gets the 30-Day Range meter appended
     into it later by placeItemInsight, so "last child" is not a fixed
     target there either. Naming the element to sit behind is exact in both. */
  const hdr = document.getElementById('tickerHeader');
  let anchorId, inline = false;
  if (!_shareWideMQ.matches) anchorId = 'btnRefreshPrices';
  else if (_toolbarOwnsARow()) {
    /* The header is narrow enough that the timeframe pills have taken a row
       to themselves — which means the NAME row is now half empty. Measured
       in the reported case: a ~500px header with the sidebar dragged wide,
       "Gilded scimitar" and its star using 290 of it. Sending Share to the
       search bar there squeezed it against the column edge while 210px sat
       unused one line down. So it goes on the name row instead, and only
       falls through to the search bar if it will not fit even there. */
    inline = _rowFitsShare(true);
    anchorId = inline ? 'timeToolbar' : 'searchGroup';
  }
  /* Beside the search box, one row up. When the header is short but the pills
     are still sharing the name row, there is no spare line to use — Share was
     either clipping 5Y behind the toolbar's fade or being pushed onto a line
     of its own. The top row is the nearest place with room, and Share is a
     whole-page action rather than a chart control, so it does not look out of
     place next to the search. */
  else anchorId = _rowFitsShare(false) ? 'timeToolbar' : 'searchGroup';
  /* order:1 on the toolbar, so Share (order 0, last of the order-0 items in
     source) sorts onto the name row ahead of it. The DOM anchor stays
     `after the toolbar` either way — `order` decides which ROW it lands on,
     and its own auto margin then parks it at the right end of that row. */
  if (hdr) hdr.classList.toggle('hdr-share-inline', inline);
  const anchor = document.getElementById(anchorId);
  if (!anchor || anchor.nextElementSibling === shareBtn) return;
  anchor.after(shareBtn);
}
/* The header's width is driven by the sidebar splitter as much as by the
   window, and its content floor moves with the item's name and price, so
   re-decide whenever it changes size. Moving Share does not change the
   header's width — the column sets that — so observing it cannot feed back
   on itself, and _headerFitsShare() is placement-independent besides. */
if ('ResizeObserver' in window) {
  const _hdrEl = document.getElementById('tickerHeader');
  if (_hdrEl) new ResizeObserver(() => placeShareButton()).observe(_hdrEl);
}
placeShareButton();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', placeShareButton);
_shareWideMQ.addEventListener('change', placeShareButton);
let hoverIdx = null;
let hoverY = null; // raw cursor Y (CSS px, canvas-relative) for the crosshair's horizontal line + price label
let selectedAbsIdx = null;
/* P2P by default, F2P only if the visitor has actually chosen it.
   This used to read `=== 'true'`, which made an unset preference F2P — and
   an unset preference is exactly a first-time visitor. That hid every
   members item on the one visit where the app has to show what it does:
   most of the game's liquid market is members-only, so a new arrival got a
   deliberately narrowed view of the GE without being told it was narrowed.
   The stored value is still authoritative in both directions, so anyone who
   has ever tapped F2P keeps it — only `null` (never chosen) changes meaning. */
let membersOn = (() => {
  try {
    const v = localStorage.getItem('ge_members');
    return v === null ? true : v === 'true';
  } catch (e) { return true; }
})();
let fullHistorical = null;
/* Starter watchlist for first-time users. Three items was too thin to show
   what the list DOES — you cannot see sorting, the column toggles, the 5D
   badges or the row accents on a list you can take in at a glance, and a
   near-empty panel reads as a feature that has not loaded rather than one
   waiting to be filled. Eleven gives every one of those something to act on
   immediately, and gives a new user something to prune, which is the
   fastest way to learn that the list is theirs to edit.

   The COMPOSITION is the point, not the count. This list started as fifteen
   entries of which eleven were gems and jewellery — uncut and cut versions
   of the same four stones, plus three necklaces and two rings — which made
   a market tracker open looking like a jewellery box, and taught a new user
   nothing that the first two rows had not already shown. Every one of those
   is gone. What is here is the stuff that actually turns over: darts and
   splinters that get burned by the thousand, runes, bones, a herb, logs,
   one bar, and the scimitar the site is named after.

   Chosen for LIQUIDITY, not value — everything here fills in minutes, so
   the numbers move while you watch and the 5D badges actually fire.
   ONLY applied when no saved list exists — see favoriteLists below, which
   returns early on any stored ge_favoriteLists (including a deliberately
   emptied one) and falls back to the legacy ge_favorites before ever
   reaching these. A returning user's list is never touched. */
const FAVORITES_DEFAULTS = [
  /* Members items FIRST. The watchlist filters them out entirely in F2P, so
     ordering them at the top costs an F2P user nothing — their list simply
     starts at Nature rune — while a P2P user opens on six consumables they
     actually recognise instead of scrolling past gem jewellery to find one.
     IDs verified against items-json/, not recalled. Adamant dart is 810:
     there is a second "Adamant dart" at 14523 which is the BANK PLACEHOLDER
     (placeholder: true, tradeable_on_ge: false) and would have seeded a row
     that can never have a price. */
  '28924', // Sunfire splinters — limit 30,000, burned by the thousand
  '810',   // Adamant dart      — limit 11,000
  '565',   // Blood rune
  '12934', // Zulrah's scales
  '536',   // Dragon bones
  '207',   // Grimy ranarr weed
  /* F2P. The eleven gems and pieces of jewellery this list used to open with
     were the whole complaint, so the rule here is one market per row rather
     than several cuts of the same stone: a rune, a log, a bar, one gem, and
     the mascot.
     Ruby is that one gem, asked for by name and worth the slot on its own —
     it is the cut stone with the steadiest turnover, so it demonstrates what
     a gem row looks like without dragging the sapphire/emerald/diamond
     variants and their uncut halves back in behind it. */
  '561',   // Nature rune
  '1515',  // Yew logs
  '2359',  // Mithril bar
  '1603',  // Ruby — the one gem
  '12389', // Gilded scimitar — the site mascot
];
/* Multiple named favorites lists (TradingView-watchlist style) instead of
   one flat list. `favorites` (read/written pervasively below — sorting,
   the star button, reorder, the bridge sync, …) always mirrors whichever
   list is ACTIVE; switching lists just reassigns it and re-renders, so
   none of that existing code needed to change. persistFavoriteLists()
   writes it back into the active list object before saving. */
let favoriteLists = (() => {
  try {
    const raw = localStorage.getItem('ge_favoriteLists');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (e) {}
  // First run, or upgrading from the old single-list format: migrate
  // whatever flat list already existed (or seed the defaults) into one
  // named list so nobody's saved favorites vanish.
  let items;
  try {
    const rawOld = localStorage.getItem('ge_favorites');
    items = rawOld != null ? JSON.parse(rawOld) : FAVORITES_DEFAULTS.slice();
  } catch (e) { items = FAVORITES_DEFAULTS.slice(); }
  if (!Array.isArray(items)) items = FAVORITES_DEFAULTS.slice();
  return [{ id: 'default', name: 'Favorites', items }];
})();
let activeFavListId = (() => {
  try {
    const v = localStorage.getItem('ge_activeFavoriteList');
    if (v && favoriteLists.some(l => l.id === v)) return v;
  } catch (e) {}
  return favoriteLists[0].id;
})();
function activeFavList() { return favoriteLists.find(l => l.id === activeFavListId) || favoriteLists[0]; }
let _flsOutsideClickHandler = null; // see renderWatchlist's list-switcher wiring
/* Inline create/rename state for the list-switcher dropdown — an on-theme
   text input swapped in for the row (or a new row) instead of a native
   prompt() dialog. Only one can be active at a time. */
let flsCreatingNew = false;
let flsEditingListId = null;
let favorites = activeFavList().items;
function persistFavoriteLists() {
  const l = activeFavList();
  if (l) l.items = favorites;
  try {
    localStorage.setItem('ge_favoriteLists', JSON.stringify(favoriteLists));
    localStorage.setItem('ge_activeFavoriteList', activeFavListId);
  } catch (e) {}
}
function switchFavoriteList(listId) {
  if (listId === activeFavListId || !favoriteLists.some(l => l.id === listId)) return;
  activeFavListId = listId;
  favorites = activeFavList().items;
  persistFavoriteLists();
  renderWatchlist();
}
function createFavoriteListLocal(name) {
  const l = { id: 'fl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, items: [] };
  favoriteLists.push(l);
  activeFavListId = l.id;
  favorites = l.items;
  persistFavoriteLists();
  renderWatchlist();
}
function renameFavoriteListLocal(listId, name) {
  const l = favoriteLists.find(x => x.id === listId);
  if (!l) return;
  l.name = name;
  persistFavoriteLists();
  renderWatchlist();
}
function deleteFavoriteListLocal(listId) {
  if (favoriteLists.length <= 1) return; // always keep at least one list
  favoriteLists = favoriteLists.filter(l => l.id !== listId);
  if (activeFavListId === listId) {
    activeFavListId = favoriteLists[0].id;
    favorites = favoriteLists[0].items;
  }
  persistFavoriteLists();
  renderWatchlist();
}

/* Drag-to-reorder favorites (TradingView-style) — grab anywhere on the row,
   drag up or down, a thin line shows where it'll land, drop to commit.
   Custom pointer tracking rather than native HTML5 drag-and-drop: native
   DnD's ghost-image/drop-effect styling is finicky to theme. Only wired
   when favSort === 'manual' — a computed sort order has no meaningful
   "position" to drag into.
   The whole row is the drag surface (not just the handle icon) — a mouse
   grab that misses a small handle by a couple pixels used to fall through
   to native text selection instead of doing anything. A 6px movement
   threshold is what tells a plain click (open the item) apart from an
   actual drag (reorder) now that the whole row triggers both; suppressClick
   on the dragged row skips the click-to-navigate that would otherwise still
   fire on mouseup right after a drag. preventDefault on mousedown itself
   (not just once dragging starts) is what actually stops text selection —
   waiting until the threshold is crossed is too late, the selection anchor
   is already set by then. */
let favDragId = null;
function wireFavoritesDrag(container) {
  const clearIndicators = () => container.querySelectorAll('.drop-above, .drop-below')
    .forEach(r => r.classList.remove('drop-above', 'drop-below'));
  /* Shared by mouse and touch: given a pointer position, mark the row it's
     over as the drop target, above or below depending on which half. */
  const markDropTarget = (x, y) => {
    const overRow = document.elementFromPoint(x, y)?.closest('.wl-item[data-fav-row="1"]');
    clearIndicators();
    if (!overRow || overRow.getAttribute('data-fav-id') === favDragId) return;
    const rect = overRow.getBoundingClientRect();
    overRow.classList.add((y - rect.top) < rect.height / 2 ? 'drop-above' : 'drop-below');
  };
  /* Commit whatever the indicator is pointing at. */
  const commitDrop = (row) => {
    const target = container.querySelector('.drop-above, .drop-below');
    if (target && favDragId) {
      moveFavoriteBeforeAfter(favDragId, target.getAttribute('data-fav-id'), target.classList.contains('drop-above'));
    }
    row.dataset.suppressClick = '1';
    setTimeout(() => { delete row.dataset.suppressClick; }, 0);
    clearIndicators();
    favDragId = null;
  };
  container.querySelectorAll('.wl-item[data-fav-row="1"]').forEach(row => {
    row.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('.wl-fav-remove')) return;
      ev.preventDefault();
      const startX = ev.clientX, startY = ev.clientY;
      let dragging = false;
      const onMove = (mev) => {
        if (!dragging) {
          if (Math.abs(mev.clientX - startX) < 6 && Math.abs(mev.clientY - startY) < 6) return;
          dragging = true;
          favDragId = row.getAttribute('data-fav-id');
          row.classList.add('dragging');
        }
        markDropTarget(mev.clientX, mev.clientY);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        row.classList.remove('dragging');
        if (dragging) commitDrop(row);
        else { clearIndicators(); favDragId = null; }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    /* Touch: press and hold to pick a row up, then drag it. A plain
       touch-drag can't work here because the row has no free gesture left —
       horizontal movement is swipe-to-remove and vertical movement is page
       scroll. Holding still is the one input that means neither, which is
       also why every mobile list that reorders does it this way.
       The hold has to survive without the browser starting a scroll, so the
       timer is cancelled the moment the finger moves more than a few px;
       once it fires the finger is stationary, so preventDefault on the
       following touchmove reliably stops the page scrolling under it. */
    const HOLD_MS = 380, SLOP = 8;
    let holdTimer = null, touchDragging = false, tx = 0, ty = 0;
    const cancelHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };

    row.addEventListener('touchstart', (ev) => {
      if (ev.touches.length !== 1 || ev.target.closest('.wl-fav-remove')) return;
      const t = ev.touches[0];
      tx = t.clientX; ty = t.clientY; touchDragging = false;
      cancelHold();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        touchDragging = true;
        favDragId = row.getAttribute('data-fav-id');
        row.classList.add('dragging');
        /* A pickup you can feel — without it a long-press has no moment where
           the row visibly becomes draggable. */
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
      }, HOLD_MS);
    }, { passive: true });

    row.addEventListener('touchmove', (ev) => {
      const t = ev.touches[0];
      if (!t) return;
      if (holdTimer) {
        if (Math.abs(t.clientX - tx) > SLOP || Math.abs(t.clientY - ty) > SLOP) cancelHold();
        return;
      }
      if (!touchDragging) return;
      ev.preventDefault();
      markDropTarget(t.clientX, t.clientY);
    }, { passive: false });

    const endTouch = () => {
      cancelHold();
      if (!touchDragging) return;
      touchDragging = false;
      row.classList.remove('dragging');
      commitDrop(row);
    };
    row.addEventListener('touchend', endTouch);
    row.addEventListener('touchcancel', endTouch);
  });
}
/* Rewrites `favorites` to match what's currently on screen, so a manual
   reorder can start from a sorted view without the list visibly jumping.
   Favorites hidden by the active F2P/P2P filter aren't in the DOM at all —
   they're appended in their existing relative order rather than dropped,
   which is the whole reason this doesn't just assign the DOM order. */
function adoptDisplayedOrderAsManual() {
  const favSet = new Set(favorites);
  const shown = Array.from(document.querySelectorAll('.wl-item[data-fav-row="1"]'))
    .map(el => el.getAttribute('data-fav-id'))
    .filter(id => id && favSet.has(id));
  if (!shown.length) return;
  const shownSet = new Set(shown);
  favorites = shown.concat(favorites.filter(id => !shownSet.has(id)));
}

function moveFavoriteBeforeAfter(dragId, targetId, before) {
  /* Dragging while a computed sort is active used to silently no-op: the
     array reordered, then renderWatchlist re-sorted and threw it away, so
     the row snapped back. A manual position and a computed sort can't
     coexist, and the drag is the clearer statement of intent — so adopt the
     order already on screen (nothing moves) and switch to manual, which
     makes the drop stick and leaves re-applying a sort one header click
     away. */
  /* Both membership checks run BEFORE adopting, so a drag that can't be
     applied (either id gone mid-drag) never leaves favSort flipped behind
     it. Safe to hoist: adoption only reorders `favorites`, it never adds or
     removes, so these verdicts are identical either side of it. */
  if (favorites.indexOf(dragId) < 0 || favorites.indexOf(targetId) < 0) return;
  if (favSort !== 'manual') {
    adoptDisplayedOrderAsManual();
    favSort = 'manual';
    try { localStorage.setItem('ge_favSort', favSort); } catch (e) {}
  }
  favorites.splice(favorites.indexOf(dragId), 1);
  /* dragId is already removed, and targetId can never equal it (the drop
     indicator is suppressed on the dragged row itself), so this index is
     the post-removal one the splice below wants. */
  let targetIdx = favorites.indexOf(targetId);
  if (!before) targetIdx += 1;
  favorites.splice(targetIdx, 0, dragId);
  persistFavoriteLists();
  rlPostOrder(); // keep the in-game list in the same order as this one
  renderWatchlist();
}

let recentItems = JSON.parse(localStorage.getItem('ge_recentItems') || '[]');
let activePriceBox = 'sell';
let recommendedBuy = null, recommendedSell = null;
/* Manual gp-nudge on the TARGET BUY/SELL boxes (the − / + buttons) — when set,
   the periodic live-price refresh stops overwriting that side so a "we're a
   few gp off" tweak survives the next auto-refresh. Cleared on item switch
   and timeframe change (a fresh target from a different context shouldn't
   inherit an old manual offset). */
let buyOverridden = false, sellOverridden = false;
/* Always exactly 1 gp — a "we're a few gp off" nudge means gp-precise,
   not a percentage of the item's price. Shift and Ctrl/Cmd multiply this by
   10 and 100 at the click site (priceStepMultiplier), so the base unit stays
   one gp no matter how far you're travelling. */
function priceStepFor(price) { return 1; }
let liveBuyRaw = null, liveSellRaw = null;
/* When those two prints actually TRADED — node.lowTime / node.highTime from
   the API, which is a different clock from lastLiveFetchAt (when we polled).
   The target boxes used to age their captions off the fetch, so they read
   "just now" about a print that was three minutes old, and disagreed with the
   quick-facts strip directly below them showing the same two numbers. */
let liveBuyTime = null, liveSellTime = null;
let lastLiveFetchAt = null; // unix seconds — stamped on every successful loadLatest(), drives the "Live: … · Xm ago" label
let isCalcOpen = false;
let currentItemSrc = null;
let currentItemLowVol = false;
let overMaxFull = null;
let dayHiLoCache = {};
let steadyFlipsCache = []; // [{ id, item, meanMargin, days, vol }]
let scanStatus = { fived: 'idle', steady: 'idle' };

let notifEnabled = localStorage.getItem('ge_notif') === '1';
let notifAlertState = JSON.parse(localStorage.getItem('ge_notifAlertState') || '{}');
const NOTIF_COOLDOWN_MS = 10 * 60 * 1000;

/* Inline Lucide-style icon set — replaces system emojis in the app chrome
   so the UI renders identically on every OS (Windows/iOS/Android emojis all
   look like different apps). stroke=currentColor: icons inherit text color. */
const UI_ICONS = {
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  gem: '<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  trendUp: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  trendDown: '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  bellOff: '<path d="M8.7 3A6 6 0 0 1 18 8c0 4.5 1.2 7 2.3 8.5"/><path d="M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><line x1="2" x2="22" y1="2" y2="22"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  crown: '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.735H5.81a1 1 0 0 1-.957-.735L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
  loader: '<line x1="12" x2="12" y1="2" y2="6"/><line x1="12" x2="12" y1="18" y2="22"/><line x1="4.93" x2="7.76" y1="4.93" y2="7.76"/><line x1="16.24" x2="19.07" y1="16.24" y2="19.07"/><line x1="2" x2="6" y1="12" y2="12"/><line x1="18" x2="22" y1="12" y2="12"/><line x1="4.93" x2="7.76" y1="19.07" y2="16.24"/><line x1="16.24" x2="19.07" y1="7.76" y2="4.93"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/>'
};
function uiIcon(name, cls) {
  return `<svg class="ui-ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI_ICONS[name] || ''}</svg>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let groupOpenStates = {
  "Favorites": true,
  "High Vol Margins": false,
  "Low Vol Margins": false,
  "Reliable 14D Margins": false,
  "Biggest Losers (24H)": false,
  "At 5D Highs": false,
  "At 5D Lows": false,
  "FindOpportunities": false // the wrapper around the six scanner sections above
};
/* Favorites sort — 'manual' respects the user's drag order (and is the only
   mode where the drag handle appears); the others sort the displayed list
   without mutating the saved order. Persisted. */
let favSort = (() => {
  try {
    const v = localStorage.getItem('ge_favSort') || 'manual';
    /* 'type' was only reachable from the columns menu, which no longer
       carries sort controls — without this, anyone stored on it would see an
       order with nothing on screen explaining or undoing it. */
    if (v === 'type') { localStorage.setItem('ge_favSort', 'manual'); return 'manual'; }
    return v;
  } catch (e) { return 'manual'; }
})();
/* Column visibility — TradingView-style. Every list row builds the same meta
   triplet (change · ea · vol) so the sidebar is consistent.
   Defaults and storage are PER LAYOUT. In coarse landscape the sidebar is
   234px wide, under the 264px container query that already drops the Vol
   column — so Vol sat ticked in the menu while nothing rendered, and ticking
   it did nothing. Landscape now starts at price + 24h change, which is what
   actually fits; portrait and desktop keep all three and keep the original
   storage key, so existing choices survive. */
const TIGHT_COLS_MQ = '(max-height: 600px) and (orientation: landscape) and (pointer: coarse)';
const isTightCols = () => window.matchMedia(TIGHT_COLS_MQ).matches;
const colPrefsKey = () => isTightCols() ? 'ge_colPrefs_land' : 'ge_colPrefs';
const colPrefsDefaults = () => isTightCols()
  ? { change: true, margin: false, volume: false }
  : { change: true, margin: true, volume: true };
function loadColPrefs() {
  const d = colPrefsDefaults();
  try {
    const raw = localStorage.getItem(colPrefsKey());
    if (!raw) return { ...d };
    const st = JSON.parse(raw);
    /* ?? not !== false: a stored `false` must win, but a MISSING key has to
       fall through to this layout's default rather than to a blanket true. */
    return { change: st.change ?? d.change, margin: st.margin ?? d.margin, volume: st.volume ?? d.volume };
  } catch (e) { return { ...d }; }
}
let columnPrefs = loadColPrefs();
function saveColPrefs() { try { localStorage.setItem(colPrefsKey(), JSON.stringify(columnPrefs)); } catch (e) {} }
/* Rotating the phone crosses the breakpoint, so re-read that layout's own
   choice instead of carrying the other one across. */
(function watchColLayout() {
  const mq = window.matchMedia(TIGHT_COLS_MQ);
  const onChange = () => {
    columnPrefs = loadColPrefs();
    if (typeof renderColHeader === 'function') renderColHeader();
    if (typeof renderWatchlist === 'function') renderWatchlist();
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
})();

const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");
const tip = document.getElementById("tip");
let chartData = {};
let isDrawing = false;

const overMaxData = {
  "20014": { name: "3rd age pickaxe", wtb: 14200000000, wts: 14800000000 },
  "12424": { name: "3rd age bow", wtb: 2800000000, wts: 3100000000 },
  "23336": { name: "3rd age druidic robe top", wtb: 5100000000, wts: 5400000000 },
  "23339": { name: "3rd age druidic robe bottoms", wtb: 4700000000, wts: 5000000000 },
  "23345": { name: "3rd age druidic cloak", wtb: 2800000000, wts: 3100000000 },
  "20011": { name: "3rd age axe", wtb: 2300000000, wts: 2600000000 }
};

function queueDraw() {
  if (!isDrawing && currentSeries) {
    isDrawing = true;
    requestAnimationFrame(() => {
      /* resizeCanvas() is debounced (scheduleResize), so there's a window
         right after a container resize where the canvas's actual box has
         already changed but the bitmap + chartCssW/H haven't caught up
         yet. Drawing with the stale cached size in that window still
         matches the (also stale) bitmap, so the coordinates are internally
         consistent — but the browser then stretches that whole bitmap to
         fit the box's NEW size, which is exactly the "vertically squashed"
         bug. Catch it here, synchronously, right before every draw: if the
         canvas's live box disagrees with what the bitmap was last sized
         for, resync first so a draw can never land in that gap. */
      const liveRect = canvas.getBoundingClientRect();
      if (liveRect.height > 10 && (Math.abs(liveRect.height - chartCssH) > 1 || Math.abs(liveRect.width - chartCssW) > 1)) {
        resizeCanvas(); // updates chartCssW/H + the bitmap; its own queueDraw() no-ops since isDrawing is still true here
      }
      drawChart(currentSeries);
      /* Driven off the draw rather than off each gesture: wheel, box zoom,
         both axis drags, pan, pinch, period switch and item switch all end
         in a draw, so keying the chip here means no entry point can forget
         to update it. */
      syncChartReset();
      isDrawing = false;
    });
  }
}

function updateFavicon(url) {
  ['favicon1','favicon2','favicon3','favicon4'].forEach(id => { const el = document.getElementById(id); if (el) el.href = url; });
}

function parseOSRSNumber(str) {
  if (!str) return 0;
  let val = String(str).toLowerCase().replace(/,/g, '');
  let multi = 1;
  if (val.endsWith('k')) { multi = 1000; val = val.slice(0, -1); }
  else if (val.endsWith('m')) { multi = 1000000; val = val.slice(0, -1); }
  else if (val.endsWith('b')) { multi = 1000000000; val = val.slice(0, -1); }
  const num = parseFloat(val);
  return isNaN(num) ? 0 : Math.floor(num * multi);
}

const fmtGp = n => n == null ? "—" : Number(n).toLocaleString();
/* Human "…ago" from a unix-seconds timestamp (OSRS /latest highTime/lowTime). */
function fmtAge(t){ if(!t||t<=0) return '—'; const s=Math.max(0,Math.floor(Date.now()/1000)-t);
  if(s<45)return'just now'; if(s<90)return'1m ago'; if(s<3600)return Math.round(s/60)+'m ago';
  if(s<5400)return'1h ago'; if(s<86400)return Math.round(s/3600)+'h ago'; return Math.round(s/86400)+'d ago'; }
function ageClass(t){ if(!t||t<=0)return'qf-stale'; const s=Math.floor(Date.now()/1000)-t;
  if(s<360)return'qf-fresh'; if(s<3600)return'qf-ok'; return'qf-stale'; }
const fmtNum = n => n == null ? "—" : Number(n).toLocaleString();
const abbreviateNumber = (num) => {
  if (num == null) return "—";
  const neg = num < 0; num = Math.abs(num);
  let out;
  if (num >= 1e9) out = (num / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
  else if (num >= 1e6) out = (num / 1e6).toFixed(2).replace(/\.00$/, '') + 'M';
  else if (num >= 1e3) out = (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  else out = num.toLocaleString();
  return (neg ? '-' : '') + out;
};

/* Y-axis tick formatter. Below 10K it shows full integers ("1,267" not "1.3K")
   so close prices don't collapse onto the same label.

   Above that, the decimal count is derived from the TICK STEP rather than
   fixed. Two decimals was hardcoded for M and B, which is fine at most prices
   and useless at the top of the market: a Scythe of vitur charts across
   1.18B-1.20B, where two decimals of billions is a 10M resolution and the
   step between gridlines is ~2.5M, so the axis rendered

     1.2B  1.2B  1.2B  1.19B  1.19B  1.19B  1.19B  1.18B

   — eight gridlines, three distinct labels, and no way to read the scale.
   Deriving decimals from the step guarantees adjacent ticks differ: at a
   2.5M step in billions that is three decimals (1.181B, 1.184B, 1.186B).

   Trailing zeros are kept when a step is supplied, so every label on the axis
   has the same shape and the column stays aligned; the no-step call (the
   crosshair readout) keeps the old trimmed form. */
const fmtYAxis = (v, step) => {
  if (v == null) return "—";
  const neg = v < 0; const a = Math.abs(v);
  const unit = a >= 1e9 ? 1e9 : a >= 1e6 ? 1e6 : a >= 1e4 ? 1e3 : 1;
  const suffix = unit === 1e9 ? 'B' : unit === 1e6 ? 'M' : unit === 1e3 ? 'K' : '';
  if (unit === 1) return (neg ? '-' : '') + Math.round(a).toLocaleString();
  let dec;
  if (step > 0) {
    /* Decimals must represent the STEP EXACTLY, not merely make neighbours
       differ. An earlier version used ceil(-log10(step/unit)), which is the
       count that separates them — for a 250M step in billions that is one
       decimal, so a gridline at exactly 1.25B printed "1.3B". The labels were
       all distinct and all wrong, which is worse than duplicates: a duplicate
       looks broken, a rounded one looks authoritative.
       So: the fewest decimals at which step/unit lands on a whole number.
       0.25 -> 2 (1.25B), 0.002 -> 3 (1.174B), 0.0025 -> 4 (1.1825B), 250 -> 0
       (250M). Capped at 5, which still covers a 250K step at billion scale. */
    const su = step / unit;
    dec = 0;
    while (dec < 5 && Math.abs(su * Math.pow(10, dec) - Math.round(su * Math.pow(10, dec))) > 1e-9) dec++;
  } else {
    dec = (a / unit) < 100 ? 2 : 0;
  }
  let out = (a / unit).toFixed(dec);
  if (!(step > 0) && out.indexOf('.') >= 0) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return (neg ? '-' : '') + out + suffix;
};

/* ── Activity bar controller ─────────────────────────────────────────────
   Driven from jget, the single choke point every price fetch goes through, so
   the bar tracks real network activity rather than being sprinkled on the
   handlers someone remembered. Wiring it to setItem instead would have missed
   the refresh button, the timeframe fetches and the scanners, and would have
   lied on a memo hit where nothing is actually in flight.

   Ref counted, because overlapping fetches are the normal case here — an item
   load fires latest + 24h + volumes + timeseries at once, and a bar that
   cleared on the first one to land would flicker four times.

   SHOW_DELAY: a fetch that resolves in 80ms from cache should show nothing at
   all. A bar that appears and vanishes within two frames reads as a glitch,
   not as feedback.
   MIN_VISIBLE: once shown it stays for at least one beat, so a load finishing
   just after the delay doesn't produce that same flash from the other side. */
const _lb = { n: 0, shownAt: 0, showTimer: 0, hideTimer: 0 };
const LB_SHOW_DELAY = 180, LB_MIN_VISIBLE = 480;
function _lbEl() { return document.getElementById('loadBar'); }
function _lbPaint(on) {
  const el = _lbEl();
  if (el) el.classList.toggle('is-active', on);
}
function lbStart() {
  _lb.n++;
  if (_lb.hideTimer) { clearTimeout(_lb.hideTimer); _lb.hideTimer = 0; }
  if (_lb.n === 1 && !_lb.shownAt && !_lb.showTimer) {
    _lb.showTimer = setTimeout(() => {
      _lb.showTimer = 0;
      if (_lb.n > 0) { _lb.shownAt = Date.now(); _lbPaint(true); }
    }, LB_SHOW_DELAY);
  }
}
function lbStop() {
  _lb.n = Math.max(0, _lb.n - 1);
  if (_lb.n > 0) return;
  if (_lb.showTimer) { clearTimeout(_lb.showTimer); _lb.showTimer = 0; }   // never got shown — leave it alone
  if (!_lb.shownAt) return;
  const left = Math.max(0, LB_MIN_VISIBLE - (Date.now() - _lb.shownAt));
  _lb.hideTimer = setTimeout(() => {
    _lb.hideTimer = 0;
    if (_lb.n === 0) { _lb.shownAt = 0; _lbPaint(false); }
  }, left);
}

async function jget(url) {
  lbStart();
  try {
    const r = await fetch(url, { cache: "default" });
    if (!r.ok) throw new Error(url + " HTTP " + r.status);
    return await r.json();
  } finally {
    /* finally, not after the return: a failed fetch must clear the bar too, or
       one dead request leaves it running forever. */
    lbStop();
  }
}
const loadMapping = () => jget(PRICES_API + "/mapping");
const loadLatest = () => jget(PRICES_API + "/latest");
const load24h = () => jget(PRICES_API + "/24h");
const loadVolumes = () => jget(PRICES_API + "/volumes");
const loadTS = (step, id) => jget(PRICES_API + `/timeseries?timestep=${step}&id=${id}`);
/* 60s TTL memo so a scan->tap or a rapid re-scan doesn't refetch the same tape.
   Stores the PROMISE (concurrent callers dedupe); evicts on rejection. */
const _tsCache = new Map();
const _tsCacheMax = 120;
function loadTSCached(step, id, ttl = 60000) {
  const key = step + '|' + id;
  const now = Date.now();
  const hit = _tsCache.get(key);
  if (hit && now - hit.t < ttl) return hit.p;
  /* Prune expired entries (and, if still over cap, the oldest) so the memo
     can't grow unbounded across a long multi-item session. */
  if (_tsCache.size >= _tsCacheMax) {
    for (const [k, v] of _tsCache) if (now - v.t >= ttl) _tsCache.delete(k);
    while (_tsCache.size >= _tsCacheMax) { const k = _tsCache.keys().next().value; if (k === undefined) break; _tsCache.delete(k); }
  }
  const p = loadTS(step, id);
  p.catch(() => { if (_tsCache.get(key)?.p === p) _tsCache.delete(key); });
  _tsCache.set(key, { t: now, p });
  return p;
}
const loadHistorical = (id) => jget(WEIRD_GLOOP_API + `/all?id=${id}`);

function itemIconUrl(id) { return `https://static.runelite.net/cache/item/icon/${id}.png`; }

/* Grand Exchange 2% sales tax, done EXACTLY. 2% == 1/50, so floor(price/50)
   is integer-exact at every 50-gp step and hits the 5,000,000-gp cap precisely
   at 250,000,000 gp — floor(price*0.02) drifts on non-representable 0.02.
   Items under 50 gp pay no tax, and a short list of items (the classic
   tradeable tools) is fully exempt. A missing/unknown id can only ever
   OVER-charge (safe: it over-flags a flip as thin, it never hides a real
   after-tax loss). The bond is handled separately below — it is exempt from
   this tax but not from a fee. */
/* Old school bond is the one item where "exempt from the 2% tax" is not the
   same as "free to flip". It IS tax-exempt — but only because it carries its
   own, much larger fee: buying a bond on the Grand Exchange leaves you
   holding an UNTRADEABLE bond, and making it tradeable again costs 10% of
   its GE value. That 10% is unavoidable on any GE-to-GE flip, so for flip
   maths it is the fee, and it dwarfs the 2% it replaces. Modelled here
   rather than special-cased in the finder: with a real 10% cost, netKept()
   turns negative on a ~1% bond spread and the flip finder stops offering
   bonds on its own, which is the correct outcome rather than an exception. */
const BOND_ID = 13190;
const BOND_UNLOCK_FEE = 0.10;
const TAX_EXEMPT_IDS = new Set([
  1755,  // Chisel
  5325,  // Gardening trowel
  11364, // Glassblowing pipe
  2347,  // Hammer
  1733,  // Needle
  233,   // Pestle and mortar
  5341,  // Rake
  8794,  // Saw
  5329,  // Secateurs
  5343,  // Seed dibber
  1735,  // Shears
  952,   // Spade
  5331   // Watering can
]);
function isTaxExempt(id) { return id != null && TAX_EXEMPT_IDS.has(Number(id)); }
/* Everything the seller loses on the way out, per item — the 2% GE tax for
   most things, the bond's 10% re-list fee for bonds, nothing for the exempt
   list. Takes the item id, not a precomputed boolean, because "what does
   selling cost" is no longer a yes/no question. */
function feeLabelFor(id) {
  return (id != null && Number(id) === BOND_ID) ? "the bond's 10% re-list fee" : 'the 2% tax';
}
/* Same fact without the article, for tables and score rows where the label
   is a fragment rather than part of a sentence. The rate stays in — bonds
   pay 10%, not 2%, so "after tax" alone would be wrong for them. */
function feeLabelShort(id) {
  return (id != null && Number(id) === BOND_ID) ? '10% bond fee' : '2% tax';
}
function sellFeeOf(s, id) {
  if (!(s > 0)) return 0;
  if (id != null && Number(id) === BOND_ID) return Math.floor(s * BOND_UNLOCK_FEE);
  if (isTaxExempt(id) || s < 50) return 0;
  return Math.min(5000000, Math.floor(s / 50));
}
/* gp KEPT per item if both legs fill at their targets. */
function netKept(b, s, id) { return s - sellFeeOf(s, id) - b; }
function calculateTax(price, id) { return sellFeeOf(price, id); }
function emptySeries() { return { labels: [], low: [], high: [], lowVol: [], highVol: [] }; }

/* Daily traded volume for an item — prefers the bulk /volumes endpoint,
   falls back to summing the 24h high/low print volumes. Drives both the
   high/low-vol categorisation and the sidebar liquidity figure. */
function dailyVolume(id) {
  let v = volumes?.data?.[String(id)];
  if (v == null) {
    const p = past24h?.data?.[String(id)];
    v = p ? (p.highPriceVolume || 0) + (p.lowPriceVolume || 0) : 0;
  }
  return v || 0;
}
function isLowVolume(id) {
  return dailyVolume(id) < LOW_VOL_THRESHOLD;
}

/* Profit Calculator */
function updateCalculator() {
  const qtyInput = $('#calcQty');
  const headline = $('#calcProfitValue');
  if (!qtyInput || !headline) return;
  const qty = parseOSRSNumber(qtyInput.value);
  const buy = parseOSRSNumber($('#calcBuy').value);
  const sell = parseOSRSNumber($('#calcSell').value);
  if (qty <= 0 || buy <= 0 || sell <= 0) {
    headline.textContent = "—"; headline.style.color = "var(--text-muted)";
    const bd = $('#calcBreakdown');
    if (bd) bd.innerHTML = `<div class="row"><span>Enter qty, buy &amp; sell to calculate.</span></div>`;
    return;
  }
  const taxPerItem = calculateTax(sell, selected && selected.id);
  const profitPerItem = sell - buy - taxPerItem;
  const totalProfit = profitPerItem * qty;
  const totalTax = taxPerItem * qty;
  /* What the trade costs to enter. The GE takes the full offer value out of
     your coins the moment you place a buy, so it's simply buy x qty — tax is
     taken from the seller on the way out and never adds to the stake. This
     leads the breakdown rather than sitting in it: it's the precondition, not
     a term in the subtraction, and a reader scanning the numbers column
     shouldn't have to work out whether it was added or taken away. */
  const capital = buy * qty;
  /* First-impression guard: a red "-22K" at the very top reads as "this app
     is losing me money" to someone who doesn't know it means the spread is
     too tight to beat the 2% tax right now. When there's no profit, show a
     calm muted "No margin" instead of an alarming red negative. The expanded
     breakdown below still shows the real signed numbers for anyone who digs in. */
  if (totalProfit > 0) {
    headline.textContent = `+${abbreviateNumber(totalProfit)}`;
    /* The data-tier green, not the bright signal green: this is a number
       being stated, not an alert. */
    headline.style.color = 'var(--rs-green-deep)';
  } else {
    headline.textContent = 'No margin';
    headline.style.color = 'var(--text-muted)';
  }
  const color = totalProfit > 0 ? 'var(--rs-green-deep)' : (totalProfit < 0 ? 'var(--negative)' : 'var(--text-main)');
  const sign = totalProfit > 0 ? '+' : '';
  const bd = $('#calcBreakdown');
  if (bd) {
    bd.innerHTML = `
      <div class="row bd-stake"><span>Capital needed <span class="bd-q">&times;${qty.toLocaleString()}</span></span><span>${fmtGp(capital)}<span class="bd-u">gp</span></span></div>
      <div class="row"><span>Margin / item</span><span>${profitPerItem > 0 ? '+' : ''}${fmtGp(profitPerItem)}<span class="bd-u">gp</span></span></div>
      <div class="row"><span>GE tax / item <span class="bd-q">2%, cap 5M</span></span><span>-${fmtGp(taxPerItem)}<span class="bd-u">gp</span></span></div>
      <div class="row"><span>Total tax <span class="bd-q">&times;${qty.toLocaleString()}</span></span><span>-${fmtGp(totalTax)}<span class="bd-u">gp</span></span></div>
      <div class="row bd-net"><span>Net profit</span><span style="color:${color};">${sign}${fmtGp(totalProfit)}<span class="bd-u">gp</span></span></div>`;
  }
}

function restoreCalculator(itemLimit, recBuy, recSell) {
  /* Some OSRS items (potions, food, seeds, raw materials, etc.) have no GE
     buy limit at all — the mapping returns null/undefined for `.limit`. We
     used to fall back to 1, which made the calculator default to a single-
     unit flip and hide the actual flipping potential. Now we treat "no
     limit" explicitly: default the qty input to 1,000 as a reasonable
     starting batch (user can edit), and label the sub-text honestly. */
  const hasLimit = itemLimit != null && itemLimit > 0;
  const defaultQty = hasLimit ? itemLimit : 1000;
  /* One quiet line, same shape either way: quantity, then where that
     quantity came from. It used to carry a "· tap to expand" hint that
     changed to "· tap to collapse" on every toggle — three jobs in one
     line, and the two that weren't the number were the longer half of it.
     The hint is redundant: the row already has a caret, a hover state, a
     press state and aria-expanded, so the affordance is stated four ways
     without spending the only supporting line on it. Dropping it also
     makes the line STATIC, which is why toggleCalc no longer rewrites it. */
  const subText = `${defaultQty.toLocaleString()} units · ${hasLimit ? '4h limit' : 'no GE limit'}`;
  const qtyLabel = hasLimit ? 'Qty (4H)' : 'Qty (any)';
  $("#sideModule").innerHTML = `
    <div class="calc-headline" id="calcToggle" role="button" tabindex="0" aria-expanded="${isCalcOpen}">
      <div class="calc-headline-left">
        <span class="calc-headline-label">Potential Profit</span>
        <span class="calc-headline-sub">${subText}</span>
      </div>
      <div class="calc-headline-right">
        <span class="res-profit" id="calcProfitValue">—</span>
        <span id="calcToggleIcon" class="calc-caret${isCalcOpen ? '' : ' closed'}">${uiIcon('chev')}</span>
      </div>
    </div>
    <div id="calcInputs" class="calc-body" style="display:${isCalcOpen ? 'block' : 'none'};">
      <div class="calc-grid">
        <div class="calc-input"><label>${qtyLabel}</label><input type="text" id="calcQty" value="${defaultQty.toLocaleString()}" placeholder="Enter qty"></div>
        <div class="calc-input"><label>Buy (ea)</label><input type="text" id="calcBuy" value="${recBuy || 0}" placeholder="0"></div>
        <div class="calc-input"><label>Sell (ea)</label><input type="text" id="calcSell" value="${recSell || 0}" placeholder="0"></div>
      </div>
      <div class="calc-breakdown" id="calcBreakdown"></div>
    </div>
    <div id="ratingGauge" class="rg-wrap rg-side" hidden></div>`;
  /* The WHOLE header toggles (label, profit value, and caret are all one big
     tap target) — keyboard accessible too. */
  const toggleCalc = () => {
    isCalcOpen = !isCalcOpen;
    $('#calcInputs').style.display = isCalcOpen ? 'block' : 'none';
    $('#calcToggleIcon').classList.toggle('closed', !isCalcOpen);
    const hl = $('#calcToggle');
    /* aria-expanded is now the ONLY thing that changes here — the sub line
       states the buy limit, which does not depend on whether the panel is
       open, so it is written once by restoreCalculator and left alone. */
    if (hl) hl.setAttribute('aria-expanded', isCalcOpen);
    track('potential_profit_toggle', { state: isCalcOpen ? 'open' : 'closed' });
  };
  $('#calcToggle').onclick = toggleCalc;
  $('#calcToggle').onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleCalc(); } };
  /* Defensive: also bind the caret span directly so clicks on the arrow
     fire the toggle even if bubbling fails for any reason. stopPropagation
     prevents the parent handler from running a second time. */
  const caretEl = $('#calcToggleIcon');
  if (caretEl) caretEl.addEventListener('click', (ev) => { ev.stopPropagation(); toggleCalc(); });
  $('#calcQty').addEventListener('input', updateCalculator);
  $('#calcBuy').addEventListener('input', updateCalculator);
  $('#calcSell').addEventListener('input', updateCalculator);
  updateCalculator();
  /* The Analyst Rating lives inside this module (TradingView-style right-rail
     rating). Rebuilding the module wipes the mount, so repaint it here; the
     insight refreshers repaint it again on every price render. */
  renderRatingGauge(selected, $('#ratingGauge'));
}

$('#buyPrice').onclick = () => { activePriceBox = 'buy'; updateSelection(); queueDraw(); };
$('#sellPrice').onclick = () => { activePriceBox = 'sell'; updateSelection(); queueDraw(); };
function updateSelection() {
  $('#buyPrice').classList.toggle('selected', activePriceBox === 'buy');
  $('#sellPrice').classList.toggle('selected', activePriceBox === 'sell');
  /* The flip card's Buy @ / Sell @ drive the same target line, so they follow
     the strip too — but only while the card is advertising the item actually
     on the chart, since otherwise its prices belong to something else. */
  const card = document.querySelector('.flip-card[data-id]');
  const onChart = !!(card && selected && String(selected.id) === card.getAttribute('data-id'));
  document.querySelectorAll('.fc-price[data-side]').forEach(el =>
    el.classList.toggle('selected', onChart && el.dataset.side === activePriceBox));
}

/* ════════════════════════════════════════════════════════════════════════
   INTERACTION TRACKING
   ════════════════════════════════════════════════════════════════════════
   One helper for every "did anyone actually use this" question. GA4 is
   already configured up in <head> (with the /?ga=off opt-out), and setItem
   fires the virtual page_view — this is only the deliberate-action layer on
   top of it.

   Rules this follows, because analytics that lie are worse than none:
   - USER ACTIONS ONLY. Nothing fires on render, on load, or on a price
     tick. Every call site below sits inside a click/keyboard handler.
   - EVERY event carries the item and timeframe. "Someone expanded Analyst
     Rating" is barely a fact; "someone expanded it on a 5Y Twisted bow" is
     one. The params come from the same globals the UI reads, so they can't
     disagree with what was on screen.
   - STATE, NOT TWO EVENT NAMES. A toggle sends one event with state:
     'open'|'closed' rather than _expand/_collapse pairs, so the open rate
     is a ratio inside one event rather than a join across two.
   - gtag may be a queue, a no-op, or absent. `typeof gtag === 'function'`
     is true even before the library loads (it's defined in <head> and
     pushes to dataLayer), and false if the script was blocked — so this is
     never a hard dependency, and it is wrapped anyway. Analytics must never
     be able to break a button.

   Deliberately NOT tracked: chart hover/tooltip, scroll depth, and anything
   that fires per frame. */
function track(name, params) {
  try {
    if (typeof gtag !== 'function') return;
    gtag('event', name, Object.assign({
      item_id: selected ? String(selected.id) : undefined,
      item_name: selected ? selected.name : undefined,
      timeframe: typeof view === 'string' ? view : undefined,
    }, params || {}));
  } catch (e) {}
}
/* The -/+ steppers are the one control here that fires in bursts: walking a
   target 40gp is 40 clicks, and 40 events would both drown the report and
   tell you less than one. Coalesced per side — the burst reports once, when
   it stops, with the number of presses, the net direction and the price
   landed on. That is the question worth asking ("do people nudge, and how
   far?"), and it is one event instead of forty. */
const _stepBurst = {};
function trackTargetAdjust(side, dir) {
  const b = _stepBurst[side] || (_stepBurst[side] = { n: 0, net: 0, t: null });
  b.n++; b.net += dir;
  clearTimeout(b.t);
  b.t = setTimeout(() => {
    track('target_adjust', {
      side: side,                                     // buy | sell
      presses: b.n,
      direction: b.net > 0 ? 'up' : b.net < 0 ? 'down' : 'net_zero',
      value: side === 'buy' ? recommendedBuy : recommendedSell,
    });
    b.n = 0; b.net = 0;
  }, 900);
}

$('#btnFav').onclick = () => {
  if (!selected) return;
  const idStr = String(selected.id);
  const wasFavorited = favorites.includes(idStr);
  if (wasFavorited) favorites = favorites.filter(id => id !== idStr);
  else favorites.push(idStr);
  persistFavoriteLists();
  rlPostFavorite(idStr, selected.name, wasFavorited);
  updateFavoriteBtn();
  renderWatchlist();
  track('favorite_toggle', { state: wasFavorited ? 'removed' : 'added',
                             list_size: favorites.length });
};

function updateFavoriteBtn() {
  if (!selected) return;
  $('#btnFav').classList.toggle('active', favorites.includes(String(selected.id)));
}

/* ════════════════════════════════════════════════════════════════════════
   SHARE CARD — a clean, data-full PNG for the current item, drawn client-
   side on a hidden canvas (no server round trip, no screenshot artifacts).
   Built for the exact use case a redditor/streamer actually has: paste one
   clean image into a post instead of a raw app screenshot. Reads already-
   computed live state (liveSellRaw, recommendedBuy/Sell, viewChanges) and
   the just-rendered rating gauge's own label, rather than recomputing
   anything itself, so the card can never disagree with what's on screen.
   ════════════════════════════════════════════════════════════════════════ */
function loadImageCORS(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
/* Reads the already-rendered Analyst Rating gauge straight off the DOM
   (label text/color, sub text, needle position, which of the 5 segments is
   live) instead of recomputing computeGrade() — same "can't disagree with
   what's on screen" rule the rest of this card follows. */
function shareCardGaugeInfo() {
  const meter = document.querySelector('#ratingGauge .rg-meter');
  const label = document.querySelector('#ratingGauge .rg-label');
  const needle = document.querySelector('#ratingGauge .rg-needle');
  /* Deliberately NOT requiring label text: the middle band renders no
     verdict word, and bailing here would drop the whole gauge — bar, needle
     and all — off the card for exactly the items whose position is the only
     thing worth showing. */
  if (!meter || !label || !needle) return null;
  const sub = document.querySelector('#ratingGauge .rg-sub');
  const segs = Array.from(document.querySelectorAll('#ratingGauge .rg-seg'));
  return {
    text: label.textContent.trim(),
    color: getComputedStyle(label).color || '#D9D3C7',
    sub: sub ? sub.textContent.trim() : '',
    needleLeft: parseFloat(needle.style.left) || 50,
    liveIdx: segs.findIndex(s => s.classList.contains('is-live')),
  };
}
/* Same rule for the 30-day range meter — reads #insMarker/#insLo/#insHi
   (already computed by renderItemInsight) rather than recomputing
   thirtyDayStats() itself. Returns null when the on-page meter is hidden
   (e.g. an over-max item with no live 30-day series). */
function shareCard30dInfo() {
  const box = document.getElementById('itemInsight');
  const marker = document.getElementById('insMarker');
  const lo = document.getElementById('insLo');
  const hi = document.getElementById('insHi');
  const priceEl = document.getElementById('insPrice');
  if (!box || box.style.display === 'none' || !marker || !lo || !hi) return null;
  const pos = parseFloat(marker.style.left);
  if (!isFinite(pos)) return null;
  return { pos, lo: lo.textContent.trim(), hi: hi.textContent.trim(), price: priceEl ? priceEl.textContent.trim() : '' };
}
/** Greedy word-wrap for canvas fillText, which has no native wrapping.
 *  Returns the y just below the last line drawn, so callers can lay out
 *  whatever comes next without hardcoding a line count. */
/* Longest prefix of `text` that wraps to at most `maxLines` at the canvas's
   current font, cut on a word boundary and ellipsised if anything was lost. */
function clampToLines(g, text, maxWidth, maxLines) {
  const words = text.split(' ');
  let line = '', lines = 1, out = [];
  for (const word of words) {
    const test = line + word + ' ';
    if (g.measureText(test).width > maxWidth && line !== '') {
      /* Hitting the cap: keep the line we've just filled — dropping it was
         losing half the allowance and clamping two lines down to one. */
      if (lines === maxLines) return out.concat(line.trim()).join(' ').replace(/[,.;:]\s*$/, '') + '…';
      lines++; out.push(line.trim()); line = word + ' ';
    } else line = test;
  }
  out.push(line.trim());
  return out.join(' ');
}
function wrapCanvasText(g, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  let curY = y;
  for (const word of words) {
    const testLine = line + word + ' ';
    if (g.measureText(testLine).width > maxWidth && line !== '') {
      g.fillText(line.trim(), x, curY);
      line = word + ' ';
      curY += lineHeight;
    } else {
      line = testLine;
    }
  }
  g.fillText(line.trim(), x, curY);
  return curY + lineHeight;
}
function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  if (typeof g.roundRect === 'function') {
    g.roundRect(x, y, w, h, r);
  } else {
    // Fallback for older engines without native roundRect — a plain
    // rectangle is a fine degrade, still fully readable.
    g.rect(x, y, w, h);
  }
}
async function buildShareCardCanvas() {
  const W = 1200, H = 990;   // one chart + a 2-line summary needs less room than two charts + four lines
  /* The backing store is rendered at a FIXED 2x and not at the viewer's
     devicePixelRatio. Every draw call below still works in W/H coordinates
     either way — the difference is what lands in the file. Keyed to dpr, the
     same button produced a 1200px PNG on an ordinary monitor and a 2400px
     one on a Retina display: the export's sharpness depended on who pressed
     it, and the common case (dpr 1) shipped a card whose small print went
     mushy the moment Reddit or Discord scaled it. 2x is deterministic,
     stays comfortably inside every upload limit, and downsamples cleanly
     into the dialog's own preview. */
  const EXPORT_SCALE = 2;
  const cv = document.createElement('canvas');
  cv.width = W * EXPORT_SCALE; cv.height = H * EXPORT_SCALE;
  const g = cv.getContext('2d');
  g.scale(EXPORT_SCALE, EXPORT_SCALE);

  // 5-day high/low — often THE reason someone is sharing this in the
  // first place ("look, it's at a 5-day low right now"), so it needs to
  // be unmissable rather than just another stat further down the card.
  // Same color language as the on-page hl-badge: bright RS-green for a
  // 5D high (sell zone), bright RS-gold for a 5D low (buy zone).
  const shareNode = latest && latest.data ? latest.data[String(selected.id)] : null;
  const shareP24 = past24h && past24h.data ? past24h.data[String(selected.id)] : null;
  const hlState = dayState(shareNode, shareP24, selected.id);
  const isHigh5d = hlState === 'high5d', isLow5d = hlState === 'low5d';
  const hlColor = isHigh5d ? '#00FF7A' : isLow5d ? '#FFB300' : null;

  // Background — the site's own obsidian/gold palette, not a generic dark card.
  const bgGrad = g.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#151210');
  bgGrad.addColorStop(1, '#0C0B09');
  g.fillStyle = bgGrad;
  g.fillRect(0, 0, W, H);
  if (hlColor) {
    // Glowing colored frame instead of the plain neutral border — the
    // whole card reads as "notable" before you even read a number.
    g.save();
    g.shadowColor = hlColor;
    g.shadowBlur = 24;
    g.strokeStyle = hlColor;
    g.lineWidth = 4;
    g.strokeRect(2, 2, W - 4, H - 4);
    g.restore();
  } else {
    g.strokeStyle = '#3C352B';
    g.lineWidth = 2;
    g.strokeRect(1, 1, W - 2, H - 2);
  }

  // Brand row — the same Gilded scimitar mark used everywhere else on the
  // site (favicon, header logo), not just the wordmark on its own.
  let brandTextX = 48;
  try {
    const logo = await loadImageCORS('https://oldschool.runescape.wiki/images/Gilded_scimitar.png');
    g.imageSmoothingEnabled = false;
    g.drawImage(logo, 48, 40, 34, 34);
    brandTextX = 48 + 34 + 10;
  } catch (e) { /* logo load failed (CORS/network) — card still works without it */ }
  g.fillStyle = '#E5C158';
  g.font = '700 30px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
  g.fillText('Pocket', brandTextX, 64);
  const pocketW = g.measureText('Pocket').width;
  g.fillStyle = '#D9D3C7';
  g.fillText('GE', brandTextX + pocketW, 64);
  g.fillStyle = '#8A8274';
  g.font = '400 15px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
  g.fillText('The OSRS trading terminal', brandTextX, 88);

  if (hlColor) {
    const badgeText = isHigh5d ? '▲ 5-DAY HIGH' : '▼ 5-DAY LOW';
    g.font = '800 22px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
    const bw = g.measureText(badgeText).width + 32;
    const bx = W - 48 - bw, by = 38;
    roundRectPath(g, bx, by, bw, 40, 8);
    g.save();
    g.shadowColor = hlColor;
    g.shadowBlur = 16;
    g.fillStyle = hlColor;
    g.fill();
    g.restore();
    g.fillStyle = isHigh5d ? '#001a0e' : '#1a1100';
    g.textAlign = 'center';
    g.fillText(badgeText, bx + bw / 2, by + 27);
    g.textAlign = 'left';
  }

  // Item icon + name.
  try {
    const icon = await loadImageCORS(itemIconUrl(selected.id));
    g.imageSmoothingEnabled = false;
    const iconSize = 96;
    g.drawImage(icon, 48, 130, iconSize, iconSize);
  } catch (e) { /* icon load failed (CORS/network) — card still works without it */ }
  g.fillStyle = '#FFFFFF';
  g.font = '700 44px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
  g.fillText(selected.name, 168, 172);

  // F2P/P2P eligibility badge — a reader unfamiliar with the item shouldn't
  // have to already know whether it needs membership. Same green=F2P,
  // gold=P2P language as the site's own mode pill.
  {
    const nameW = g.measureText(selected.name).width;
    const badgeText = selected.members ? 'P2P' : 'F2P';
    const badgeColor = selected.members ? '#FFB300' : '#10B981';
    g.font = '800 14px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
    const bw = g.measureText(badgeText).width + 16;
    const bx = 168 + nameW + 12, by = 150;
    roundRectPath(g, bx, by, bw, 24, 5);
    g.fillStyle = badgeColor + '26'; // ~15% alpha fill
    g.fill();
    g.strokeStyle = badgeColor;
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = badgeColor;
    g.textAlign = 'center';
    g.fillText(badgeText, bx + bw / 2, by + 17);
    g.textAlign = 'left';
  }

  // Live price, big — carries the ACTION, so it takes the 5D signal's color:
  // gold at a 5-day low (buy opportunity), green at a 5-day high (sell
  // opportunity). Deliberately not pinned to the sell-teal that Target Sell
  // uses just because liveSellRaw happens to be an insta-sell figure —
  // that's an internal data-model distinction, and this card exists to make
  // the call obvious to someone scrolling past it on Reddit. The subtitle
  // below inherits the same fill on purpose.
  // Neutral is the muted body cream, NOT the brand gold it used to be:
  // these cards are read in isolation, so a viewer has no second card to
  // compare against and brand gold sat close enough to the 5D-low gold to
  // imply a buy call that isn't being made. Cream reads as plain data, and
  // keeps the hierarchy the pure-white item name above establishes.
  g.fillStyle = hlColor || '#D9D3C7';
  g.font = '700 64px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
  g.fillText(fmtGp(liveSellRaw) + ' gp', 168, 240);
  /* "Potential buy zone" used to print here, under the price. It said the
     same thing as the ▼ 5-DAY LOW badge at the top right, in more words, and
     a second phrasing of a fact already stated is exactly the kind of thing
     that makes a card take two seconds to read instead of one. The badge
     keeps the signal; the sentence goes. */

  /* The 1D/5D change chip and the VOL chip used to sit here.
     Both were repeats. The chart's own header prints the selected period's
     net change a few hundred pixels below, and liquidity now speaks up
     through Market Read precisely when it matters instead of always. Two
     fewer numbers competing for the first glance, and ~50px back. */

  /* ONE target line on the CHART — the side actually selected on the page —
     even though both target numbers are printed as text above it. A reader
     needs both prices to judge the edge, but two dashed levels on a small
     preview is the "competing markers" problem: neither reads. The selected
     box is the sharer's actual call, so it is the one that gets drawn. */
  const shareIsBuy = activePriceBox === 'buy';
  const shareTgt = shareIsBuy ? recommendedBuy : recommendedSell;
  const shareTgtColor = shareIsBuy ? '#E5B842' : '#26A9AB';

  /* Shrink-to-fit, then ellipsise. Used for the Market Read line, which is a
     fixed sentence but a variable width once the font is applied. */
  const fitLine = (text, x, y, maxW, startSize, minSize, weight, color) => {
    let size = startSize;
    const setF = s2 => { g.font = weight + ' ' + s2 + 'px -apple-system, BlinkMacSystemFont, Roboto, sans-serif'; };
    setF(size);
    while (size > minSize && g.measureText(text).width > maxW) { size -= 1; setF(size); }
    let out = text;
    if (g.measureText(out).width > maxW) {
      while (out.length > 4 && g.measureText(out + '…').width > maxW) out = out.slice(0, -1);
      out += '…';
    }
    g.fillStyle = color;
    g.fillText(out, x, y);
    return size;
  };
  /* Mixed-weight run on one baseline: figures loud, connective text quiet, so
     a downscaled preview still resolves the numbers. */
  const runAt = (yy) => {
    let rx = 48;
    return (txt, color, weight, size) => {
      g.font = weight + ' ' + size + 'px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
      g.fillStyle = color;
      g.fillText(txt, rx, yy);
      rx += g.measureText(txt).width;
    };
  };

  /* ── 2. Analyst Rating ────────────────────────────────────────────────
     Promoted above the targets. The hierarchy this card is built to is
     "what is it / what's the call / what are the levels": the rating is the
     call, so it outranks the numbers that execute it. It used to sit below
     them, which made the card open with a spreadsheet. */
  let flowY = 300;
  const gaugeInfo = shareCardGaugeInfo();
  if (gaugeInfo) {
    g.fillStyle = '#8A8274';
    g.font = '600 15px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
    g.fillText('ANALYST RATING', 48, flowY);
    /* No verdict word in the middle band (see renderRatingGauge), so the bar
       closes up under the eyebrow rather than leaving a hole. */
    if (gaugeInfo.text) {
      g.fillStyle = gaugeInfo.color;
      g.font = '700 34px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
      g.fillText(gaugeInfo.text, 48, flowY + 38);
    }
    const barX = 48, barY = flowY + (gaugeInfo.text ? 58 : 26), barW = W - 96, barH = 14, gap = 3;
    const segW = (barW - gap * 4) / 5;
    /* Left-to-right = STRONG BUY -> BUY -> NEUTRAL -> SELL -> STRONG SELL,
       i.e. gold on the BUY end, teal on the SELL end, matching both the
       BUY/SELL labels drawn underneath and the on-page gauge. Easy to get
       backwards: the page's own .rg-seg colors are declared in the opposite
       (strong-sell-first) order and only end up gold-on-the-left because
       renderRatingGauge emits them reversed, as [4,3,2,1,0]. This loop
       draws index 0 leftmost, so it needs the already-reversed order —
       gaugeInfo.liveIdx is likewise a DOM position, not a rating enum, so
       it lines up with this array as written. */
    const SEG = ['rgba(229, 184, 66,0.34)', 'rgba(229, 184, 66,0.17)', 'rgba(120,123,134,0.16)', 'rgba(38, 169, 171,0.17)', 'rgba(38, 169, 171,0.34)'];
    const SEG_LIVE = ['rgba(229, 184, 66,0.9)', 'rgba(229, 184, 66,0.65)', 'rgba(160,163,174,0.55)', 'rgba(38, 169, 171,0.65)', 'rgba(38, 169, 171,0.9)'];
    for (let i = 0; i < 5; i++) {
      const sx = barX + i * (segW + gap);
      roundRectPath(g, sx, barY, segW, barH, 4);
      g.fillStyle = (i === gaugeInfo.liveIdx) ? SEG_LIVE[i] : SEG[i];
      g.fill();
      if (i === gaugeInfo.liveIdx) {
        g.lineWidth = 1;
        g.strokeStyle = 'rgba(255,255,255,0.4)';
        roundRectPath(g, sx, barY, segW, barH, 4);
        g.stroke();
      }
    }
    const needleX = barX + (gaugeInfo.needleLeft / 100) * barW;
    g.fillStyle = gaugeInfo.color;
    roundRectPath(g, needleX - 2, barY - 6, 4, barH + 12, 2);
    g.fill();
    g.font = '700 12px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
    g.fillStyle = '#8A8274';
    g.textAlign = 'left';
    g.fillText('BUY', barX, barY + barH + 24);
    g.textAlign = 'right';
    g.fillText('SELL', barX + barW, barY + barH + 24);
    g.textAlign = 'left';
    flowY = barY + barH + 24;
  }

  /* ── 3. The two levels, on one line ───────────────────────────────────
     Both numbers, because the edge underneath is a buy-to-sell figure and a
     single price leaves it unexplained. They were three 30px columns
     (target / capital needed / potential profit) plus a four-part explainer
     sentence — four competing figures where the reader wanted two. */
  const tgtY = flowY + 62;
  const tgtPrefix = view === '1d' ? 'TARGET ' : 'SWING ';
  /* ONLY the side selected on the page. Both prices were printed here for a
     spell, on the reasoning that the edge line underneath is a buy-to-sell
     figure and one price leaves it unexplained. In practice that makes the
     card state a plan and its opposite at once: "sell Virtus at 62,879,996" is
     a call, "buy at 61,005,554 / sell at 62,879,996" is a spreadsheet, and the
     reader has to work out which half was the point. The selected box is the
     sharer's actual call, it is the line drawn on the chart below, and it is
     the one that travels. The profit line keeps its own labels, so it still
     reads without the second price beside it. */
  if (shareTgt > 0) {
    const put = runAt(tgtY);
    put(tgtPrefix + (shareIsBuy ? 'BUY  ' : 'SELL  '), '#8A8274', '700', 17);
    put(fmtGp(shareTgt), shareTgtColor, '800', 34);
  }

  /* ── 4. What the edge is worth, in one line ───────────────────────────
     Capital Needed is gone. It was a fourth big figure answering a question
     nobody asks of a card in a feed — you check what a trade costs when you
     are about to place it, on the page, where the calculator lives. */
  let edgeY = tgtY;
  if (recommendedBuy > 0 && recommendedSell > 0) {
    edgeY = tgtY + 42;
    const marginPerItem = recommendedSell - recommendedBuy - calculateTax(recommendedSell, selected.id);
    const edgeColor = marginPerItem >= 0 ? '#10B981' : '#EF5350';
    const put = runAt(edgeY);
    put((marginPerItem >= 0 ? '+' : '') + fmtGp(marginPerItem) + ' gp/ea', edgeColor, '800', 22);
    put(' after tax', '#8A8274', '600', 22);
    if (selected.limit > 0) {
      const potentialProfit = marginPerItem * selected.limit;
      put('   ·   ', '#8A8274', '600', 22);
      put((potentialProfit >= 0 ? '+' : '') + abbreviateNumber(potentialProfit), edgeColor, '800', 22);
      put(' / 4h limit', '#8A8274', '600', 22);
    }
  }

  /* ── 5. Market Read, only when a rule fires ───────────────────────────
     Same deterministic engine as the rating card — no model, no network
     call. Absent entirely when nothing fires, and the chart below moves up
     into the space rather than leaving a labelled gap. */
  let shareRead = null;
  try {
    const _gB = computeGrade(selected, 'buy'), _gS = computeGrade(selected, 'sell');
    const _dom = (_gB && _gS) ? ((_gB.grade >= _gS.grade) ? _gB : _gS) : null;
    shareRead = computeMarketRead(_dom ? _dom.parts : null);
  } catch (e) { shareRead = null; }
  let readY = edgeY;
  if (shareRead) {
    readY = edgeY + 46;
    g.fillStyle = '#8A8274';
    g.font = '600 15px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
    g.fillText('MARKET READ', 48, readY);
    fitLine(shareRead.text, 48, readY + 28, W - 96, 21, 15, '600', '#D9D3C7');
    readY += 28;
  }

  // 1-year price trend — a compact version of the on-page chart's own white
  // Trend line, built from the same 1Y series data regardless of whatever
  // timeframe the real chart is currently showing, so the share card is
  // always a consistent 1Y snapshot rather than whatever the viewer
  // happened to have open.
  if (currentItemSrc) {
    // One chart-drawing routine, called twice side by side (30-day, then
    // 1-year) at half width each, rather than duplicating the whole block —
    // same reasoning as everywhere else on this card: independent of
    // whatever timeframe the real chart currently has open, so the card is
    // always the same consistent pair of snapshots. Line/fill color follows
    // that PERIOD's own net direction (green = up, red = down, same
    // +/-green/red the 1D/5D chips above already use) instead of a flat
    // neutral white — the whole point is reading the shape at a glance
    // without stopping to check numbers first.
    const drawMiniTrend = (periodKey, label, shortLabel, x, w, chartY, chartH) => {
      const series = filterSeries(seriesForView(periodKey, currentItemSrc, currentItemLowVol), getPeriod(periodKey));
      const pts = [];
      for (let i = 0; i < series.labels.length; i++) {
        const lo = series.low[i], hi = series.high[i];
        if (lo == null && hi == null) continue;
        const mid = (lo != null && hi != null) ? (lo + hi) / 2 : (lo != null ? lo : hi);
        if (mid > 0) pts.push({ t: series.labels[i], v: mid });
      }
      if (pts.length < 2) return;

      const netPct = ((pts[pts.length - 1].v - pts[0].v) / pts[0].v) * 100;
      const trendColor = netPct > 0.5 ? '#10B981' : netPct < -0.5 ? '#EF5350' : '#8A8274';
      const trendRgb = netPct > 0.5 ? '38,184,92' : netPct < -0.5 ? '239,83,80' : '138,130,116';

      g.fillStyle = '#8A8274';
      g.font = '600 15px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
      g.fillText(label, x, chartY - 20);
      g.font = '700 15px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
      g.fillStyle = trendColor;
      g.textAlign = 'right';
      g.fillText((netPct >= 0 ? '+' : '') + netPct.toFixed(1) + '%', x + w, chartY - 20);
      g.textAlign = 'left';

      const minV = Math.min(...pts.map(p => p.v)), maxV = Math.max(...pts.map(p => p.v));
      const minT = pts[0].t, maxT = pts[pts.length - 1].t;
      /* The target has to fit inside the plotted range or its line lands
         outside the chart box and is simply not drawn — the same silent
         failure the on-page chart had. Scale bounds therefore include the
         target; the min/max CAPTIONS below stay on the data, because those
         two numbers label the price range the item actually traded in and
         a target is not a trade. Bounded the same way as the live chart so
         a far-off level cannot flatten the shape into a line. */
      let sMin = minV, sMax = maxV;
      if (shareTgt > 0 && isFinite(shareTgt)) {
        const slack = targetFitSlack(minV, maxV);
        if (shareTgt >= minV - slack && shareTgt <= maxV + slack) {
          sMin = Math.min(sMin, shareTgt); sMax = Math.max(sMax, shareTgt);
          /* When the target IS the new extreme it lands exactly on the top or
             bottom edge of the chart box, where a dashed level is
             indistinguishable from a frame. Give it a little room on that
             side only, so the line reads as sitting in the chart rather than
             bounding it. A Swing Buy is below every print by construction,
             so this is the normal case for a buy, not an edge case. */
          const span = (sMax - sMin) || 1;
          if (shareTgt <= sMin) sMin -= span * 0.08;
          if (shareTgt >= sMax) sMax += span * 0.08;
        }
      }
      const xOf = t => x + (maxT > minT ? (t - minT) / (maxT - minT) : 0) * w;
      const yOf = v => chartY + chartH - (sMax > sMin ? (v - sMin) / (sMax - sMin) : 0.5) * chartH;

      g.beginPath();
      g.moveTo(xOf(pts[0].t), chartY + chartH);
      pts.forEach(p => g.lineTo(xOf(p.t), yOf(p.v)));
      g.lineTo(xOf(pts[pts.length - 1].t), chartY + chartH);
      g.closePath();
      const areaGrad = g.createLinearGradient(0, chartY, 0, chartY + chartH);
      areaGrad.addColorStop(0, `rgba(${trendRgb},0.28)`);
      areaGrad.addColorStop(1, `rgba(${trendRgb},0.02)`);
      g.fillStyle = areaGrad;
      g.fill();

      g.beginPath();
      pts.forEach((p, i) => {
        const px = xOf(p.t), py = yOf(p.v);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      });
      g.strokeStyle = trendColor;
      g.lineWidth = 2.5;
      g.lineJoin = 'round';
      g.stroke();

      /* The target line, drawn ON the shared chart. This is what makes the
         card an argument rather than a screenshot: "sell at 446" means
         something the moment you can see 446 sitting on the day's high.
         Dashed and in the buy/sell colour so it reads as a level rather
         than as more price data, with the price on a plate at the left so
         it survives a feed downscaling the image. */
      if (shareTgt > 0 && shareTgt >= sMin && shareTgt <= sMax) {
        const ty = yOf(shareTgt);
        g.save();
        g.setLineDash([7, 6]);
        g.strokeStyle = shareTgtColor;
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, ty); g.lineTo(x + w, ty); g.stroke();
        g.setLineDash([]);
        const tText = (shareIsBuy ? 'BUY ' : 'SELL ') + fmtGp(shareTgt);
        g.font = '800 17px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
        const tw = g.measureText(tText).width + 20, th = 26;
        /* Flip above/below the line so the plate never hangs off the top or
           bottom edge of the chart box. */
        let tby = ty - th - 5;
        if (tby < chartY) tby = ty + 5;
        if (tby + th > chartY + chartH) tby = ty - th - 5;
        roundRectPath(g, x + 8, tby, tw, th, 5);
        g.fillStyle = 'rgba(10,9,8,0.88)'; g.fill();
        g.fillStyle = shareTgtColor;
        g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText(tText, x + 18, tby + th / 2 + 1);
        g.textBaseline = 'alphabetic';
        g.restore();
      }

      g.font = '700 15px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
      /* Values only — the 10px "30D LOW"/"30D HIGH" captions under them were
         the smallest type on the card and rendered at under 3px once a feed
         downscaled it, i.e. never read by anyone. The section label above the
         chart already names the window, so the two numbers at its ends are
         unambiguous without them. Bumped to 20px for the same reason. */
      g.fillStyle = '#D9D3C7';
      g.font = '700 20px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
      g.textAlign = 'left';
      /* Rounded: these bounds come from the MID of each bucket's low/high, so
         they are routinely fractional — the card was printing
         "2,555,427.5 gp", half a coin, as a price. */
      g.fillText(fmtGp(Math.round(minV)) + ' gp', x, chartY + chartH + 28);
      g.textAlign = 'right';
      g.fillText(fmtGp(Math.round(maxV)) + ' gp', x + w, chartY + chartH + 28);
      g.textAlign = 'left';
    };

    /* One chart, full width, at the timeframe the sharer is actually looking
       at. It was hardcoded to 30 days on the reasoning that a fixed window
       makes cards comparable — but nobody compares two cards, and a fixed
       window means someone who spotted a move on the 1D chart shares a
       month-long picture in which that move is a wiggle. The card should
       show the thing that made them press the button. */
    const TF_LABEL = { '1d': '24-HOUR', '5d': '5-DAY', '1m': '30-DAY',
                       '6m': '6-MONTH', '1y': '1-YEAR', '5y': '5-YEAR' };
    const tfKey = TF_LABEL[view] ? view : '1m';
    /* Follows the flow rather than sitting at a fixed y: Market Read is
       optional, so a hardcoded chartY either leaves a labelled gap when no
       rule fires or collides when one does. The chart takes whatever is left
       between the last text line and the footer rule at H-78, keeping room
       for its own header (20px above) and its min/max captions (28px below).
       Clamped so a short flow can't stretch it into a banner. */
    const chartTop = readY + 62;
    const chartBottom = (H - 78) - 46;
    const chartY = chartTop, chartH = Math.max(150, Math.min(310, chartBottom - chartTop));
    drawMiniTrend(tfKey, TF_LABEL[tfKey] + ' PRICE TREND', TF_LABEL[tfKey], 48, W - 96, chartY, chartH);
  }

  /* The market summary paragraph was here. It restated the numbers already
     on the card in sentence form, which is the one thing nobody reads in a
     feed preview — and it was the longest block on the card. The full
     sentence still runs under the chart on the page, and rides along in the
     share caption, which is where prose actually gets read. */

  // Footer watermark + live timestamp — a screenshot can circulate for
  // days, and "live" alone reads as unverifiable once it's no longer
  // fresh; stamping the actual fetch time gives it a real reference point.
  g.strokeStyle = '#2B2621';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(48, H - 78); g.lineTo(W - 48, H - 78); g.stroke();
  g.fillStyle = '#E5B842';
  g.font = '800 20px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
  g.fillText('PocketGE', 48, H - 44);
  g.fillStyle = '#8A8274';
  g.font = '600 16px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
  g.fillText('The OSRS Trading Terminal · pocketge.com', 48, H - 22);
  if (lastLiveFetchAt) {
    const stamp = new Date(lastLiveFetchAt * 1000).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
    g.textAlign = 'right';
    g.fillText('Live as of ' + stamp, W - 48, H - 22);
    g.textAlign = 'left';
  }

  return cv;
}
/* The caption that rides along with the shared image, so a post arrives
   ready to publish instead of just "Ruby — PocketGE". Composed from the
   same already-computed live state the card itself draws (rating, 5D
   flag, 30-day position, targets, volume) so the words can never
   disagree with the picture, and kept tight enough to paste into a
   280-char tweet without editing. */
function buildShareText() {
  if (!selected) return '';
  const node = latest && latest.data ? latest.data[String(selected.id)] : null;
  const p24 = past24h && past24h.data ? past24h.data[String(selected.id)] : null;
  const hl = dayState(node, p24, selected.id);
  const gauge = shareCardGaugeInfo();
  const d30 = shareCard30dInfo();
  const vol = dailyVolume(selected.id);
  const lines = [];

  /* One idea per line. The old caption packed the rating and the 30-day
     position onto one line and four numbers onto the next, which is dense to
     read anywhere and unreadable in a Reddit comment on a phone. Each line
     now answers a single question: what is it, where do I trade it, how much,
     and how liquid. */
  const flag = hl === 'high5d' ? '5-DAY HIGH'
    : hl === 'low5d' ? '5-DAY LOW'
    : hl === 'high' ? '24h high'
    : hl === 'low' ? '24h low' : '';
  /* Headline carries the two things worth a glance: the price, and the single
     most notable thing about it. A 5-day extreme outranks the rating, because
     it's usually the reason the post exists at all. */
  const head = [`${selected.name} — ${fmtGp(liveSellRaw)} gp`];
  if (flag) head.push(flag);
  if (gauge && gauge.text) head.push(gauge.text);
  lines.push(head.join(' · '));

  if (recommendedBuy > 0 && recommendedSell > 0) {
    const margin = recommendedSell - recommendedBuy - calculateTax(recommendedSell, selected.id);
    lines.push('');
    /* The SELECTED side only, matching the card and the target line drawn on
       its chart. "Buy 432 → Sell 446" states a plan and its opposite at once
       and leaves the reader to work out which half was the point; someone
       sharing a 24h high is making one call, and the caption should be that
       call. The other side still contributes to the margin figure on the next
       line — it has to, the margin is the difference — it just stops being
       presented as an equal recommendation. */
    const capIsBuy = activePriceBox === 'buy';
    const capWord = (view === '1d' ? '' : 'Swing ') + (capIsBuy ? 'Buy' : 'Sell');
    const capPrice = fmtGp(capIsBuy ? recommendedBuy : recommendedSell);
    lines.push(`${capWord} ${capPrice} gp${view && view !== '1d' ? ` (${String(view).toUpperCase()})` : ''}`);
    const money = [`${margin >= 0 ? '+' : ''}${fmtGp(margin)} gp/ea after tax`];
    if (selected.limit > 0) {
      const total = margin * selected.limit;
      money.push(`${total >= 0 ? '+' : ''}${abbreviateNumber(total)} per 4h limit`);
    }
    lines.push(money.join(' · '));
  }

  /* One liquidity fact and one range fact — enough to judge whether the flip
     above is realistic, without turning the caption into a stat block. */
  const ctx = [];
  if (vol > 0) ctx.push(`${abbreviateNumber(vol)} traded/day`);
  if (d30) {
    ctx.push((d30.pos <= 25 ? 'near 30-day low' : d30.pos >= 75 ? 'near 30-day high' : 'mid 30-day range')
      + ` (${d30.lo}–${d30.hi})`);
  }
  if (ctx.length) lines.push(ctx.join(' · '));

  /* Link lives inside the text rather than navigator.share's separate url
     field — targets that only read one of the two still get both. */
  lines.push('');
  lines.push(`Live prices & chart → https://pocketge.com/?q=${encodeURIComponent(selected.name)}`);
  return lines.join('\n');
}

function shareItemUrl() {
  return `https://pocketge.com/?q=${encodeURIComponent(selected ? selected.name : '')}`;
}
function shareFileName() {
  return `pocketge-${(selected ? selected.name : 'item').replace(/[^a-z0-9]+/gi, '-')}.png`;
}

/* ── Our own share sheet ─────────────────────────────────────────────────
   navigator.share() on a desktop browser opens the OS sheet — on Windows
   that's the system flyout listing your contacts and whichever UWP apps
   happen to be installed. It can't be styled, filtered or previewed, none
   of its targets are where OSRS players actually post, and it puts personal
   contacts on screen at the exact moment someone is likely screenshotting.
   So pointer devices get this dialog instead: the real PNG previewed at the
   top (you see precisely what goes out), the caption, and targets that
   matter here. Touch devices keep the native sheet — there it's genuinely
   better, since it hands the actual image file to the installed Discord /
   Reddit / WhatsApp apps, which no web intent can do. The footer keeps the
   OS sheet reachable on desktop for anyone who wants it. */
let shareBlob = null, sharePreviewUrl = null;

function shareCanUseNativeFiles(file) {
  return !!(navigator.canShare && navigator.canShare({ files: [file] }));
}

async function shareNativeWith(file) {
  await navigator.share({ files: [file], title: selected.name + ' — PocketGE', text: buildShareText() });
}

async function copyImageToClipboard() {
  if (!shareBlob || !navigator.clipboard || !window.ClipboardItem) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': shareBlob })]);
    return true;
  } catch (e) { return false; }
}
async function copyTextToClipboard(txt) {
  try { await navigator.clipboard.writeText(txt); return true; } catch (e) { return false; }
}
function downloadShareImage() {
  if (!shareBlob) return false;
  const url = URL.createObjectURL(shareBlob);
  const a = document.createElement('a');
  a.href = url; a.download = shareFileName();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

const SHARE_ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  down: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
  text: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  reddit: '<circle cx="12" cy="13" r="8"/><circle cx="9" cy="12.5" r="1"/><circle cx="15" cy="12.5" r="1"/><path d="M9 16c1.8 1.2 4.2 1.2 6 0"/><path d="m13 5 1.4 3.3"/><circle cx="15.5" cy="4.2" r="1.4"/>',
  x: '<path d="m4 4 16 16"/><path d="M20 4 4 20"/>'
};
const shareIcon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SHARE_ICONS[k]}</svg>`;

/* Confirmation lands on the tile you pressed, not in a corner toast — the
   pointer is already there and each tile has its own outcome. */
function shareFlash(btn, msg) {
  const sub = btn.querySelector('.sa-sub');
  if (!sub) return;
  if (btn._shareTimer) clearTimeout(btn._shareTimer);
  if (btn._shareSub == null) btn._shareSub = sub.textContent;
  sub.textContent = msg;
  btn.classList.add('done');
  btn._shareTimer = setTimeout(() => {
    sub.textContent = btn._shareSub;
    btn.classList.remove('done');
    btn._shareTimer = null;
  }, 2200);
}

/* Reddit and X open in a new tab, so the "now paste it" instruction has to
   survive losing focus — it stays put until the dialog is closed, and takes
   the general footer note's place once there's something specific to say. */
function shareStep(html) {
  const el = $('#shareStep');
  el.innerHTML = html;
  el.hidden = false;
  $('#shareNote').hidden = true;
  // On a short screen the dialog body scrolls, and the step lands below the
  // tiles — pull it into view so it isn't missed on the way to the new tab.
  el.scrollIntoView({ block: 'nearest' });
}

function shareActions() {
  return [
    { key: 'copy', icon: 'copy', label: 'Copy image', sub: 'Paste into Discord',
      run: async (b) => shareFlash(b, await copyImageToClipboard() ? 'Copied ✓' : 'Blocked — use Download') },
    { key: 'download', icon: 'down', label: 'Download', sub: 'PNG to your device',
      run: (b) => shareFlash(b, downloadShareImage() ? 'Saved ✓' : 'Failed') },
    { key: 'caption', icon: 'text', label: 'Copy caption', sub: 'Prices as text',
      run: async (b) => shareFlash(b, await copyTextToClipboard(buildShareText()) ? 'Copied ✓' : 'Failed') },
    { key: 'link', icon: 'link', label: 'Copy link', sub: 'Straight to this item',
      run: async (b) => shareFlash(b, await copyTextToClipboard(shareItemUrl()) ? 'Copied ✓' : 'Failed') },
    /* Reddit's composer prefills two things and only two: `title` and `url`.
       Passing `url` is precisely what turns the submission into a LINK post
       — and a link post renders whatever og:image the target serves, which
       for a static host is the one site-wide banner for every ?q=. Sending
       only `title` leaves the composer on a post type that accepts the
       image, so the card we just built becomes the post itself. The link
       still travels: it's printed on the card and sits in the caption. */
    { key: 'reddit', icon: 'reddit', label: 'Reddit', sub: 'Card becomes the post',
      run: async () => shareHandoff('Reddit',
        'https://www.reddit.com/submit?title='
          + encodeURIComponent(`${selected.name} — ${shareCardGaugeInfo()?.text || 'OSRS flip'} on PocketGE`),
        'Paste it into the post with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>V</kbd> — or use Reddit\'s <b>Images</b> tab.',
        'drag the PNG into the Reddit post') },
    /* X does take prefilled body text, so the caption and link land on their
       own — only the image needs pasting. */
    { key: 'x', icon: 'x', label: 'X', sub: 'Caption prefilled',
      run: async () => shareHandoff('X',
        'https://x.com/intent/post?text=' + encodeURIComponent(buildShareText()),
        'Paste it into the composer with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>V</kbd> — the caption and link are already filled in.',
        'attach the PNG in X') }
  ];
}

/* Copy the image, then STOP and say what happens next — the tab does not
   open until the second click.
   The old flow opened it immediately and left the instructions behind in a
   tab the poster had just navigated away from, so the first thing they saw
   was an empty composer and no image; the reasonable conclusion was that
   the share was broken. Neither site can be handed a file by a link, so
   the paste is unavoidable — but it has to be read BEFORE the jump, not
   after. Opening from a real click on the button also keeps the popup
   blocker out of it, which an await'd window.open never quite guaranteed. */
function shareHandoff(siteName, url, pasteHint, downloadHint) {
  return copyImageToClipboard().then(ok => {
    shareStep(`
      <div class="ss-title">Post to ${siteName}</div>
      <ol class="ss-steps">
        <li>${ok
          ? 'Card image copied to your clipboard <b class="ss-ok">✓</b>'
          : '<b>Your browser blocks clipboard images</b> — press <b>Download</b> above first'}</li>
        <li>${ok ? pasteHint : `Then ${downloadHint}.`}</li>
      </ol>
      <button type="button" class="ss-go" data-share-go="${escapeHtml(url)}">Open ${siteName} ↗</button>
      <div class="ss-why">No site can attach an image to a ${siteName} post on your behalf — that's why this last step is yours.</div>`);
  });
}
document.addEventListener('click', (ev) => {
  const b = ev.target.closest && ev.target.closest('[data-share-go]');
  if (!b) return;
  ev.stopPropagation();
  window.open(b.getAttribute('data-share-go'), '_blank', 'noopener');
});

function closeShareModal() {
  $('#shareModal').style.display = 'none';
  if (sharePreviewUrl) { URL.revokeObjectURL(sharePreviewUrl); sharePreviewUrl = null; }
}

function openShareModal(blob) {
  shareBlob = blob;
  if (sharePreviewUrl) URL.revokeObjectURL(sharePreviewUrl);
  sharePreviewUrl = URL.createObjectURL(blob);
  $('#sharePreviewImg').src = sharePreviewUrl;
  $('#shareModalTitle').textContent = 'Share ' + selected.name;
  $('#shareCaption').textContent = buildShareText();
  $('#shareStep').hidden = true;
  $('#shareStep').innerHTML = '';
  $('#shareNote').hidden = false;

  const grid = $('#shareGrid');
  grid.innerHTML = '';
  shareActions().forEach(a => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'share-act';
    b.innerHTML = `${shareIcon(a.icon)}<span>${a.label}</span><span class="sa-sub">${a.sub}</span>`;
    b.onclick = () => a.run(b);
    grid.appendChild(b);
  });

  /* Only offer the OS sheet where it can actually carry the image. */
  const nativeBtn = $('#shareNative');
  const file = new File([blob], shareFileName(), { type: 'image/png' });
  nativeBtn.hidden = !shareCanUseNativeFiles(file);
  nativeBtn.onclick = async () => {
    try { await shareNativeWith(file); } catch (e) { /* user dismissed the OS sheet */ }
  };

  $('#shareModal').style.display = 'flex';
}

async function shareCard() {
  if (!selected) return;
  track('share_card', { step: 'click' });
  const btn = $('#btnShare');
  const label = btn.querySelector('.fav-label');
  const originalText = label.textContent;
  label.textContent = '…';
  btn.disabled = true;

  /* Only the render is allowed to report "Failed" — everything after it is
     either a dialog or a sheet the user can simply dismiss. */
  let blob;
  try {
    const cv = await buildShareCardCanvas();
    blob = await new Promise(res => cv.toBlob(res, 'image/png'));
    if (!blob) throw new Error('toBlob failed');
  } catch (e) {
    label.textContent = 'Failed';
    setTimeout(() => { label.textContent = originalText; }, 1800);
    btn.disabled = false;
    /* Worth its own step: a render that throws is a bug report, not a
       behaviour signal, and it should not sit in the same bucket as a
       card the user simply chose not to send. */
    track('share_card', { step: 'render_failed' });
    return;
  }
  label.textContent = originalText;
  btn.disabled = false;

  const file = new File([blob], shareFileName(), { type: 'image/png' });
  // Touch first: the OS sheet is the right answer on a phone.
  if (matchMedia('(pointer: coarse)').matches && shareCanUseNativeFiles(file)) {
    // Cancelling the OS sheet rejects with AbortError — not a failure.
    try { await shareNativeWith(file); track('share_card', { step: 'shared_native' }); }
    catch (e) { track('share_card', { step: 'dismissed' }); }
    return;
  }
  track('share_card', { step: 'modal' });
  openShareModal(blob);
}
$('#btnShare').onclick = shareCard;
$('#closeShare').onclick = closeShareModal;
$('#shareModal').addEventListener('click', (ev) => { if (ev.target === $('#shareModal')) closeShareModal(); });
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && $('#shareModal').style.display === 'flex') closeShareModal();
});

/* ── "What am I sharing?" hover ──────────────────────────────────────────
   placeShareButton() parks Share in the Analyst Rating header, so at a
   glance it reads as "share the rating". Naming the item in the hover, and
   listing what the card contains, removes the guess before the click. */
(function shareHint() {
  const tip = document.createElement('div');
  tip.className = 'share-tip';
  tip.setAttribute('role', 'tooltip');
  tip.id = 'shareTip';
  document.body.appendChild(tip);

  const paint = () => {
    const name = selected ? selected.name : 'this item';
    tip.innerHTML = `<div class="st-title">Share this <b>${escapeHtml(name)}</b> trade idea</div>
      <div class="st-sub">Builds an image card of the whole item — not just the rating.</div>
      <ul class="st-list">
        <li>Price chart and 30-day range</li>
        <li>Target buy &amp; sell, margin after tax</li>
        <li>Caption and a link back to ${escapeHtml(name)}</li>
      </ul>`;
  };
  const place = (el) => {
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = r.top - h - 8;
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  };
  const open = (el) => { paint(); place(el); tip.classList.add('open'); };
  const close = () => tip.classList.remove('open');

  /* Delegated: #btnShare is re-parented by placeShareButton() on every
     rating re-render, and a directly-bound listener would ride along fine
     but a rebuilt node would not. Hover only — on touch the tap should
     open the sheet, which answers the question better than a tooltip. */
  document.addEventListener('mouseover', (ev) => {
    const b = ev.target.closest && ev.target.closest('#btnShare');
    if (!b || !matchMedia('(hover: hover)').matches) return;
    open(b);
  });
  document.addEventListener('mouseout', (ev) => {
    if (ev.target.closest && ev.target.closest('#btnShare')) close();
  });
  document.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
})();

/* CSS-pixel drawing space of the last resizeCanvas() — drawChart must use
   these exact values so its coordinates always match the bitmap + transform. */
let chartCssW = 0, chartCssH = 0;
function resizeCanvas() {
  /* Width tracks the container; height tracks the canvas's own flexed box
     (container minus the legend footer's REAL height — it varies with
     wrapping, so never derive it as parent-minus-a-guessed-constant). Any
     gap between the bitmap size and the flexed display size makes the
     browser scale the bitmap to fit, rendering the chart vertically
     squashed or stretched. */
  const rect = canvas.parentElement.getBoundingClientRect();
  const boxH = canvas.getBoundingClientRect().height;
  /* Skip transient zero/tiny sizes (mid-rotation, or when the on-screen keyboard
     collapses the layout) — sizing the canvas to those values breaks the chart. */
  if (rect.width < 10 || boxH < 60) return;
  /* HD canvas. devicePixelRatio scaling makes text + lines render at native
     pixel density. Round the backing-store dimensions to whole pixels so we
     don't paint into fractional pixels (which is what makes text look blurred). */
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssW = Math.floor(rect.width);
  const cssH = Math.floor(boxH);
  chartCssW = cssW; chartCssH = cssH;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  /* Tell the renderer to prefer legibility over speed on whatever it
     supports — Chromium honors textRendering, font smoothing carries over
     from CSS. Keeps glyph hinting at small sizes. */
  if ('textRendering' in ctx) ctx.textRendering = 'geometricPrecision';
  if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
  queueDraw();
}
let _resizeTimer = null;
function scheduleResize(delay) {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(resizeCanvas, delay || 0);
}
/* Plain window resize / container resize (dragging the browser edge,
   siblings shifting the chart's box) need the TIGHTEST possible
   turnaround — a setTimeout debounce here leaves a window where the
   canvas's box has already changed size but the bitmap hasn't caught up
   yet. That's not just a "draw with stale data" risk (queueDraw() already
   guards against that): the BROWSER stretches/squashes the existing
   bitmap into the new box on its own regular paint cycle, with no JS draw
   call involved at all, for as long as that window stays open. rAF-
   throttling instead of setTimeout-debouncing collapses a whole burst of
   resize events into one resizeCanvas() call on the very next frame
   (~16ms worst case) instead of 60ms — tight enough that the browser
   essentially never gets a chance to paint the mismatched state. */
let _resizeRAFPending = false;
function scheduleResizeTight() {
  if (_resizeRAFPending) return;
  _resizeRAFPending = true;
  /* Refit the target numbers too: the box width changes with the viewport, so
     a price that fitted in landscape can overflow in portrait and vice versa. */
  requestAnimationFrame(() => { _resizeRAFPending = false; resizeCanvas(); fitPriceNums();
    /* The timeframe strip starts/stops overflowing as the header width changes,
       so its edge fades have to be re-evaluated on the same beat. */
    if (typeof keepActiveViewVisible === 'function') keepActiveViewVisible(); });
}
window.addEventListener('resize', scheduleResizeTight);
/* Orientation changes settle layout asynchronously on mobile; re-measure after
   a short delay (and again later) so portrait↔landscape doesn't leave a broken canvas. */
window.addEventListener('orientationchange', () => { scheduleResize(250); setTimeout(resizeCanvas, 600); });
/* The chart container is flex:1, so its height also changes when siblings
   appear/disappear (banners, quick-facts strip, the item icon loading) with
   no window resize event. If the canvas bitmap isn't re-synced the browser
   scales the stale bitmap to the new box and the chart renders vertically
   squashed. Observe both the container (siblings shifting it) and the canvas
   itself (in-flow content inside the container, e.g. the legend wrapping,
   resizes the canvas without changing the container). */
if (window.ResizeObserver) {
  const ro = new ResizeObserver(scheduleResizeTight);
  ro.observe(canvas.parentElement);
  ro.observe(canvas);
}

/* Deep scan: 1Y/5Y lows + 1M margins. Wiki API has no bulk endpoint for these,
   so we per-item fetch a bounded pool (top vol + top price), throttled & cached. */
function getScanCandidates() {
  const active = membersOn ? mapping : mapping.filter(m => !m.members);
  const noOver = active.filter(m => !overMaxData[String(m.id)]);
  const byVol = [...noOver].sort((a, b) => (volumes?.data?.[String(b.id)] || 0) - (volumes?.data?.[String(a.id)] || 0)).slice(0, SCAN_VOL_POOL);
  const byPrice = [...noOver].sort((a, b) => (latest?.data?.[String(b.id)]?.high || 0) - (latest?.data?.[String(a.id)]?.high || 0)).slice(0, SCAN_PRICE_POOL);
  const map = {};
  [...byVol, ...byPrice].forEach(m => { map[m.id] = m; });
  return Object.values(map);
}

async function throttleMap(items, fn, concurrency) {
  let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; try { await fn(items[idx]); } catch (e) {} } }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

/* Fetch the true intraday high/low (from 5m candles, last 24h) for specific
   items so the day-high/low glow reflects the actual recent peak/trough — the
   whole point of the "wow, take action" highlight on your favorites. Cached and
   throttled; re-renders once a batch completes so the glow lights up. */
async function scanDayExtremes(ids) {
  const todo = [...new Set(ids.map(String))].filter(id => id && !(id in dayHiLoCache) && !overMaxData[id]);
  if (!todo.length) return;
  todo.forEach(id => { dayHiLoCache[id] = null; }); // reserve so we don't refetch mid-flight
  await throttleMap(todo, async (id) => {
    try {
      /* Use 1h candles instead of 5m — 1h goes back ~15 days, so we can
         compute both the 24h and 5-day extremes from the same fetch and
         power the new ▲▲ 5D HIGH / ▼▼ 5D LOW tier without doubling API load. */
      const ts = seriesFromTS(await loadTS('1h', id));
      const now = Math.floor(Date.now() / 1000);
      const cut1d = now - 86400, cut5d = now - 5 * 86400;
      let hi = 0, lo = Infinity, hi5d = 0, lo5d = Infinity;
      for (let i = 0; i < ts.labels.length; i++) {
        const t = ts.labels[i], H = ts.high[i], L = ts.low[i];
        if (t >= cut5d) {
          if (H != null && H > hi5d) hi5d = H;
          if (L != null && L > 0 && L < lo5d) lo5d = L;
        }
        if (t >= cut1d) {
          if (H != null && H > hi) hi = H;
          if (L != null && L > 0 && L < lo) lo = L;
        }
      }
      dayHiLoCache[id] = {
        hi: hi > 0 ? hi : 0,
        lo: lo < Infinity ? lo : 0,
        hi5d: hi5d > 0 ? hi5d : 0,
        lo5d: lo5d < Infinity ? lo5d : 0
      };
    } catch (e) { dayHiLoCache[id] = { hi: 0, lo: 0, hi5d: 0, lo5d: 0 }; }
  }, SCAN_CONCURRENCY);
  renderWatchlist();
  fireFavoriteAlerts();
}

/* Fire a native browser notification only on TRUE breakout / breakdown
   events: when a favorite's live insta-buy actually exceeds its tracked
   high-water mark, or the live insta-sell drops below the tracked low-water
   mark. Used to fire on every "near the extreme" state — far too noisy.
   Now persists watermarks per favorite so the alert only triggers on
   genuine new extremes, not on lingering "at-extreme" states.

   Tier (per favorite, per direction):
   • 5D break — current price beats the last-known 5-day extreme (rare,
     big-deal event)
   • 24h break — current price beats the last-known 24h extreme (still
     meaningful; can happen daily)

   Cooldown remains as a safety net so the same break can't double-fire if
   the cache jitters around the threshold. */
function fireFavoriteAlerts() {
  if (!notifEnabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const now = Date.now();
  let dirty = false;
  favorites.forEach(idStr => {
    const id = String(idStr);
    const item = mapping.find(m => String(m.id) === id);
    if (!item) return;
    if (!membersOn && item.members) return;
    const node = latest?.data?.[id];
    if (!node) return;
    const ex = dayHiLoCache[id];
    if (!ex || !ex.hi || !ex.lo) return;
    const sell = node.high || node.avgHighPrice || 0; // insta-buy = you can sell here
    const buy  = node.low  || node.avgLowPrice  || 0; // insta-sell = you can buy here

    const prev = notifAlertState[id] || {};
    /* Seed watermarks on first observation so we don't fire alerts for
       extremes that were already in place when the user favorited. */
    const hiMark = prev.hiMark ?? ex.hi;
    const loMark = prev.loMark ?? ex.lo;
    const hi5dMark = prev.hi5dMark ?? (ex.hi5d || ex.hi);
    const lo5dMark = prev.lo5dMark ?? (ex.lo5d || ex.lo);
    let tier = null;          // '5d' | '1d'
    let direction = null;     // 'high' | 'low'
    let price = 0, breakOf = 0;
    if (sell > hi5dMark)      { tier = '5d'; direction = 'high'; price = sell; breakOf = hi5dMark; }
    else if (sell > hiMark)   { tier = '1d'; direction = 'high'; price = sell; breakOf = hiMark; }
    else if (buy  < lo5dMark) { tier = '5d'; direction = 'low';  price = buy;  breakOf = lo5dMark; }
    else if (buy  < loMark)   { tier = '1d'; direction = 'low';  price = buy;  breakOf = loMark; }

    /* Update watermarks every cycle so future alerts only fire on FURTHER
       breaks past the new extreme. */
    notifAlertState[id] = {
      hiMark: Math.max(hiMark, sell),
      loMark: loMark > 0 && buy > 0 ? Math.min(loMark, buy) : (loMark || buy),
      hi5dMark: Math.max(hi5dMark, sell),
      lo5dMark: lo5dMark > 0 && buy > 0 ? Math.min(lo5dMark, buy) : (lo5dMark || buy),
      lastFired: prev.lastFired || 0
    };
    dirty = true;
    if (!tier) return;
    const cooledDown = (now - (prev.lastFired || 0)) > NOTIF_COOLDOWN_MS;
    if (!cooledDown) return;
    notifAlertState[id].lastFired = now;

    const emoji = direction === 'high' ? '📈' : '📉';
    const titleTier = tier === '5d' ? '5D' : '24H';
    const verb = direction === 'high' ? 'broke above' : 'broke below';
    const sideHint = direction === 'high' ? 'Sell into strength' : 'Buy the dip';
    try {
      const n = new Notification(`${emoji} ${item.name} ${verb} ${titleTier} ${direction === 'high' ? 'high' : 'low'}`, {
        body: `Live ${direction === 'high' ? 'sell' : 'buy'}: ${fmtGp(price)} gp (prev ${titleTier} ${direction === 'high' ? 'high' : 'low'}: ${fmtGp(breakOf)}) — ${sideHint}`,
        icon: itemIconUrl(item.id),
        tag: `pocketge-${id}-${tier}-${direction}`,
        renotify: false
      });
      n.onclick = () => { try { window.focus(); n.close(); setItem._userPicked = false; setItem(item); } catch (e) {} };
    } catch (e) {}
  });
  if (dirty) {
    try { localStorage.setItem('ge_notifAlertState', JSON.stringify(notifAlertState)); } catch (e) {}
  }
}

/* 5-day breakout scan — populates dayHiLoCache.hi5d / lo5d for the
   bounded candidate pool (top volume + top price ~100 items). Reuses
   scanDayExtremes (1h-candle endpoint → 5-day VWAP highs/lows from the
   API's volume-weighted bucket data). Throttled via SCAN_CONCURRENCY so
   we never blast 4500 per-item requests at once. */
async function runFiveDayScan() {
  if (scanStatus.fived === 'loading' || scanStatus.fived === 'done') return;
  scanStatus.fived = 'loading'; renderWatchlist();
  const cands = getScanCandidates();
  const ids = cands.map(m => String(m.id)).filter(id => !(id in dayHiLoCache));
  if (ids.length) await scanDayExtremes(ids);
  scanStatus.fived = 'done'; renderWatchlist();
}

/* Steady Flips scan — looks for items whose post-tax daily margin has been
   POSITIVE and CONSISTENT across the last ~14 days. These are the boring
   reliable grinds (runes, ammo, bars, common potions) that pay roughly the
   same flip every single day — the thing serious flippers actually grind,
   and the thing no other category surfaces (every margin list is a
   snapshot of THIS MINUTE's spread, which is noisy and disappears in
   minutes). Throttled per-item against the bounded candidate pool, same
   pattern as the 5D scan; cache lives in steadyFlipsCache. */
async function runSteadyFlipsScan() {
  if (scanStatus.steady === 'loading' || scanStatus.steady === 'done') return;
  scanStatus.steady = 'loading'; renderWatchlist();
  const cands = getScanCandidates();
  const results = [];
  await throttleMap(cands, async (m) => {
    try {
      const ts = seriesFromTS(await loadTS('24h', m.id));
      if (!ts.labels.length) return;
      const lastN = 14;
      const start = Math.max(0, ts.labels.length - lastN);
      const dayMargins = [];
      let totalVol = 0;
      for (let i = start; i < ts.labels.length; i++) {
        const hi = ts.high[i], lo = ts.low[i];
        const v = (ts.lowVol[i] || 0) + (ts.highVol[i] || 0);
        totalVol += v;
        if (hi == null || lo == null || hi <= lo) continue;
        const margin = hi - lo - calculateTax(hi, m.id);
        if (margin > 0 && margin < hi * 0.5) dayMargins.push(margin);
      }
      const days = ts.labels.length - start;
      if (days < 10) return;
      /* Looser thresholds than the original "Steady Flips" version, which
         was so strict that common potions/bars/gems would drop out for a
         single noisy day. Now: at least 60% of the last ~14 days had a
         positive after-tax margin (8 of 14), mean is >=3 gp, and stdev is
         <=80% of mean (filters fluke-driven items where one big day
         masquerades as a trend). Still rules out true noise; doesn't
         exclude perfectly reasonable grinds. */
      if (dayMargins.length < Math.ceil(days * 0.6)) return;
      const mean = dayMargins.reduce((a, b) => a + b, 0) / dayMargins.length;
      if (mean < 3) return;
      const variance = dayMargins.reduce((a, b) => a + (b - mean) ** 2, 0) / dayMargins.length;
      const stdev = Math.sqrt(variance);
      if (stdev > mean * 0.8) return;
      results.push({
        id: String(m.id), item: m,
        meanMargin: Math.round(mean),
        days: dayMargins.length,
        vol: Math.round(totalVol / Math.max(1, days)) // avg daily volume
      });
    } catch (e) {}
  }, SCAN_CONCURRENCY);
  /* Rank by mean margin (after tax), highest first. */
  results.sort((a, b) => b.meanMargin - a.meanMargin);
  steadyFlipsCache = results;
  scanStatus.steady = 'done'; renderWatchlist();
}

function trendSub(node, p24) {
  let currentMid = null;
  if (node?.high && node?.low) currentMid = (node.high + node.low) / 2;
  else if (node?.high || node?.low) currentMid = node.high || node.low;
  let pastMid = null;
  if (p24?.avgHighPrice && p24?.avgLowPrice) pastMid = (p24.avgHighPrice + p24.avgLowPrice) / 2;
  else if (p24?.avgHighPrice || p24?.avgLowPrice) pastMid = p24.avgHighPrice || p24.avgLowPrice;
  if (currentMid == null || pastMid == null) return "";
  if (currentMid > pastMid * 1.001) return `<span class="wl-trend up">▲</span>`;
  if (currentMid < pastMid * 0.999) return `<span class="wl-trend down">▼</span>`;
  return `<span class="wl-trend neutral">—</span>`;
}

function priceOf(item) {
  const node = latest?.data?.[String(item.id)];
  return node?.high ?? node?.avgHighPrice ?? node?.low ?? 0;
}

/* Is the item at the top ("high") or bottom ("low") of its recent range?
   When we have the true intraday extremes (fetched per-item from 5m candles via
   scanDayExtremes), glow "high" within ~1.5% of the 24h peak and "low" within
   ~1.5% of the trough — that's the actionable "it's at its recent peak" signal.
   Until those load, fall back to a coarse 24h band-position estimate so the
   discovery lists still populate. */
function dayState(node, p24, id) {
  if (!node) return "";
  const ex = id != null ? dayHiLoCache[String(id)] : null;
  if (ex && ex.hi > 0 && ex.lo > 0 && ex.hi > ex.lo) {
    const sell = node.high || node.avgHighPrice || 0;
    const buy = node.low || node.avgLowPrice || 0;
    /* 5D tier first — only fires when the price is CURRENTLY at the edge of
       the 5-day range, not just "happened to dip within 1% of it days ago."
       Range-position math: bottom 8% of the actual 5D high-low band = at
       5D low; top 8% = at 5D high. Requires a meaningful 5D range (>=3% of
       price) so flat items don't trigger on a single-gp wiggle. */
    if (ex.hi5d > 0 && ex.lo5d > 0 && ex.hi5d - ex.lo5d >= ex.lo5d * 0.03) {
      const range5d = ex.hi5d - ex.lo5d;
      if (sell > 0 && (ex.hi5d - sell) / range5d <= 0.08) return "high5d";
      if (buy > 0  && (buy - ex.lo5d) / range5d <= 0.08) return "low5d";
    }
    /* 24h tier — STRICT. Live price must literally meet or break the highest
       (or lowest) 1h VWAP bucket recorded across the last 24 hours. The old
       "within 1.5%" fuzz was flagging items that were just hanging out near
       their daily edges, so almost every favorite wore a ▲/▼ badge all the
       time. Strict equality + a 4% range floor (up from 2%) reserves the
       badge for items literally pressing against their true 24h extreme. */
    if (ex.hi - ex.lo >= ex.lo * 0.04) {
      if (sell > 0 && sell >= ex.hi) return "high";
      if (buy > 0 && buy <= ex.lo) return "low";
    }
    return "";
  }
  /* fallback: locate the current mid price within the 24h average [low, high]
     band (top 30% = high, bottom 30% = low). */
  if (!p24 || !(p24.avgHighPrice > 100)) return "";
  const gp = ((p24.highPriceVolume || 0) + (p24.lowPriceVolume || 0)) * p24.avgHighPrice;
  if (gp <= 10000000) return "";
  const aH = p24.avgHighPrice, aL = p24.avgLowPrice;
  if (!(aL > 0) || !(aH > aL)) return "";
  const sell = node.high || 0, buy = node.low || 0;
  if (sell <= 0 && buy <= 0) return "";
  const mid = (sell > 0 && buy > 0) ? (sell + buy) / 2 : (sell || buy);
  const pos = (mid - aL) / (aH - aL);
  if (pos >= 0.7) return "high";
  if (pos <= 0.3) return "low";
  return "";
}

/* Tab-title breakout badge — count favorites currently at an actionable
   5D peak or floor (same dayState that drives the ▲▲/▼▼ glow chips). 24h
   highs/lows are deliberately ignored: those wiggle multiple times per day
   and would make the (N) prefix nearly always non-zero, defeating the
   purpose of a "look at this NOW" signal. */
function countFavoriteBreakouts() {
  if (!Array.isArray(favorites) || favorites.length === 0) return 0;
  let count = 0;
  for (const idStr of favorites) {
    const id = String(idStr);
    if (overMaxData[id]) continue;
    const node = latest?.data?.[id];
    const p24 = past24h?.data?.[id];
    const st = dayState(node, p24, id);
    if (st === 'high5d' || st === 'low5d') count++;
  }
  return count;
}

/* Brand title for the homepage (no ?q=) — the page Google should index for
   "pocketge" and generic flipping terms. Item pages get "<Item> price -
   PocketGE". isHomepageDefault is true while showing the boot default
   landing (not an explicit item navigation), which keeps the crawler-
   visible title/meta/canonical brand-focused instead of itemising "/". */
const BRAND_TITLE = 'PocketGE — OSRS Trading Terminal | Live Grand Exchange Prices';
let isHomepageDefault = false;
/* SERP title, keyword-first ("<Item> Price OSRS") with the live gp figure
   once prices land — numbers in titles measurably lift click-through and
   signal freshness. Googlebot renders JS, so it indexes the gp variant. */
function itemSeoTitle() {
  if (!selected) return BRAND_TITLE;
  const gp = (typeof liveSellRaw === 'number' && liveSellRaw > 0) ? `${fmtGp(liveSellRaw)} gp · ` : '';
  return `${selected.name} Price OSRS — ${gp}Live GE Chart & Flip Margin | PocketGE`;
}
function applyTitleBadge() {
  const base = isHomepageDefault ? BRAND_TITLE : itemSeoTitle();
  /* The (n) breakout badge exists so an already-open tab can flag alerts.
     Gate it to returning visitors: a crawler (or any first render) must
     never index "(2) Ruby Price OSRS…" as the page title. */
  let n = 0;
  if (isReturningVisitor) n = countFavoriteBreakouts();
  document.title = n > 0 ? `(${n}) ${base}` : base;
}

/* Restore the brand-level meta/canonical for the homepage so a crawl of "/"
   indexes the brand page, not whatever item happens to be displayed. */
function restoreBrandMeta() {
  const desc = 'OSRS trading terminal for merchers and flippers. Build watchlists, follow Grand Exchange price action, and see margins, volume and flip recommendations.';
  setMetaTag('description', desc);
  setMetaTag('og:title', BRAND_TITLE, true);
  setMetaTag('og:description', desc, true);
  setMetaTag('og:url', 'https://pocketge.com/', true);
  setMetaTag('twitter:title', BRAND_TITLE);
  setMetaTag('twitter:description', desc);
  setCanonicalLink('https://pocketge.com/');
  removeItemJsonLd();
  clearItemSeo();
}

/* Footer freshness signal — stamps the last successful price refresh so a
   first-time visitor sees the data is genuinely live, not stale/abandoned. */
function updateFootFresh() {
  const el = document.getElementById('footFresh');
  if (!el) return;
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  /* Deliberately no "refreshes every N min" — naming an interval makes the
     data sound staler than it is (the reader anchors on the gap, not the
     freshness). The live "last updated <time>" stamp already proves it. */
  el.textContent = `Live prices · last updated ${t}`;
}

/* Build-stamp: bumped whenever a meaningful change ships. The displayed
   value auto-degrades to "Updated N days ago", so even if we forget to
   bump it for a week the footer doesn't go suspiciously stale-looking
   (which would HURT trust). Updated in the same commit as user-facing
   changes — git history is the source of truth, this is the surface. */
const BUILD_DATE = '2026-08-11';
function agoLabel(dateStr) {
  const built = new Date(dateStr);
  const days = Math.max(0, Math.floor((Date.now() - built.getTime()) / 86400000));
  return days === 0 ? 'Updated today'
       : days === 1 ? 'Updated yesterday'
       : days < 14 ? `Updated ${days} days ago`
       : days < 60 ? `Updated ${Math.floor(days / 7)} weeks ago`
       : `Updated ${Math.floor(days / 30)} months ago`;
}
/* Writes to every build-stamp surface (footer + the top-panel chip), so
   adding another one is markup-only — no extra wiring here. */
function updateFootUpdated() {
  let label;
  try { label = agoLabel(BUILD_DATE + 'T00:00:00Z'); } catch (e) { return; }
  document.querySelectorAll('.js-build-updated').forEach(el => { el.textContent = label; });
}
/* Keep the footer's build id + "Updated …" honest by syncing them to the
   repo's latest commit on GitHub, instead of a hand-bumped constant. The
   short SHA becomes the version chip (so it visibly changes every deploy) and
   the commit date drives the "Updated N ago" label. Cached 6h in
   localStorage so we make at most a handful of API calls per user per day,
   and every failure path silently falls back to the baked-in constants. */
/* In-game name shown as the byline on the deploy card. Empty string hides
   the whole block, so the card degrades to just the deploy facts. */
const OWNER_RSN = 'pocketge';
/* Split out so the logo hover and the deploy card cannot drift apart on the
   one detail someone would actually act on. */
const OWNER_WORLDS = 'W301/302';
const OWNER_NOTE = `Usually around the GE on ${OWNER_WORLDS} — add me to talk flips, bugs or ideas.`;
const REPO_URL = 'https://github.com/grant9008/pocketge.com';
/* "Updated today" is a rounded label, which is exactly what a passer-by
   wants — but it can't answer "did my fix actually ship?". This card gives
   the precise answer behind it: the real timestamp, how long ago, the commit
   that shipped and its subject line, all straight from the same GitHub
   response that drives the rounded label. */
function buildInfoCardHtml(info) {
  if (!info || !info.date) {
    return '<div class="bi-eyebrow">Last deploy</div><div class="bi-sub">Couldn\'t reach GitHub — showing the last known build.</div>';
  }
  const d = new Date(info.date);
  const exact = d.toLocaleString([], { weekday: 'short', year: 'numeric', month: 'short',
                                       day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const rel = fmtAge(Math.floor(d.getTime() / 1000));
  const sha = (info.sha || '').slice(0, 7);
  /* No commit subject here on purpose: those are written for whoever reads
     the diff, not for someone checking the data is current, and they run long
     enough to bury the timestamp that is the whole point of the card. The SHA
     link is the way through to the detail for anyone who actually wants it. */
  return '<div class="bi-eyebrow">Last deploy</div>'
    + `<div class="bi-when">${exact}</div>`
    + `<div class="bi-sub">${rel} · ${d.toLocaleTimeString([], { timeZoneName: 'short' }).replace(/^[\d:apm\s]+/i, '')}</div>`
    + (sha ? `<a class="bi-sha" href="${REPO_URL}/commit/${info.sha}" target="_blank" rel="noopener noreferrer">${sha} on GitHub ↗</a>` : '')
    + (OWNER_RSN ? `<div class="bi-by"><span class="bi-by-k">Built by</span><b>${OWNER_RSN}</b><span class="bi-by-n">${OWNER_NOTE}</span></div>` : '');
}
let buildInfoLatest = null;
function paintBuildInfoCard() {
  const pop = document.getElementById('buildInfoPop');
  if (pop) pop.innerHTML = buildInfoCardHtml(buildInfoLatest);
}
function syncBuildInfo() {
  const CACHE_KEY = 'pg_build_info';
  const apply = (info) => {
    if (!info) return;
    buildInfoLatest = info;
    paintBuildInfoCard();
    const v = document.getElementById('footVersion');
    if (v && info.sha) { v.textContent = info.sha.slice(0, 7); v.title = 'Latest commit ' + info.sha.slice(0, 7); }
    if (info.date) {
      const label = agoLabel(info.date);
      document.querySelectorAll('.js-build-updated').forEach(el => { el.textContent = label; });
    }
  };
  /* Stale-while-revalidate: paint the cached value immediately so the chip
     never flashes empty, then ALWAYS re-check in the background. This used
     to early-return for the whole TTL, which froze the label at whatever
     the newest commit was on the visitor's last load — so for up to six
     hours after a deploy it advertised the PREVIOUS one ("Updated 3 days
     ago" minutes after shipping). Being wrong right after a deploy defeats
     the entire point of the stamp. One API call per page load is cheap
     here: this is an SPA, so item switches don't reload, and every failure
     path (rate limit, offline) silently keeps the cached value. */
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) {}
  if (cached && cached.info) apply(cached.info);
  fetch('https://api.github.com/repos/grant9008/pocketge.com/commits?per_page=1', { headers: { Accept: 'application/vnd.github+json' } })
    .then(r => r.ok ? r.json() : null)
    .then(arr => {
      const c = Array.isArray(arr) ? arr[0] : null;
      if (!c || !c.sha) return;
      const commit = c.commit || {};
      const date = (commit.committer && commit.committer.date) || (commit.author && commit.author.date) || null;
      const info = { sha: c.sha, date };
      apply(info);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), info })); } catch (e) {}
    })
    .catch(() => {});
}
/* Lives on <body>, not inside the stamp. Fixed positioning keeps it clear
   of any clipping on the stamp's own container, and appending to the stamp
   would put a child node inside an element other rules may test for
   emptiness. Bound once — the stamp text is rewritten by syncBuildInfo but
   the elements themselves persist. */
(function wireBuildInfoCard(){
  const ready = (fn) => document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', fn) : fn();
  ready(() => {
    const triggers = Array.from(document.querySelectorAll('.js-build-updated'));
    if (!triggers.length) return;
    const pop = document.createElement('div');
    pop.className = 'build-info-pop';
    pop.id = 'buildInfoPop';
    pop.setAttribute('role', 'tooltip');
    document.body.appendChild(pop);
    paintBuildInfoCard();

    let anchor = null;
    const place = () => {
      if (!anchor) return;
      const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = r.top - h - 8;
      pop.style.left = left + 'px';
      pop.style.top = Math.max(8, Math.min(top, window.innerHeight - h - 8)) + 'px';
    };
    const open = (el) => { anchor = el; paintBuildInfoCard(); place(); pop.classList.add('open'); };
    const close = () => { pop.classList.remove('open'); anchor = null; };

    triggers.forEach(el => {
      el.tabIndex = 0;
      /* The rounded label is the summary; the card is the detail. Drop the
         native title so the two don't both appear on hover. */
      el.removeAttribute('title');
      let lastPointer = '';
      el.addEventListener('pointerdown', e => { lastPointer = e.pointerType || ''; });
      el.addEventListener('mouseenter', () => { if (matchMedia('(hover: hover)').matches) open(el); });
      el.addEventListener('mouseleave', (e) => {
        if (!matchMedia('(hover: hover)').matches) return;
        if (e.relatedTarget && pop.contains(e.relatedTarget)) return;   // heading into the card
        close();
      });
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (lastPointer === 'mouse') return;   // hover already owns it
        pop.classList.contains('open') ? close() : open(el);
        lastPointer = '';
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pop.classList.contains('open') ? close() : open(el); }
      });
    });
    pop.addEventListener('mouseleave', () => { if (matchMedia('(hover: hover)').matches) close(); });
    pop.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', (e) => { if (!e.target.closest('.js-build-updated, .build-info-pop')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
  });
})();

/* ── Logo hover: what the click does, plus who to find in-game ──────────
   The logo has always reloaded the page; that was buried in a native
   title= tooltip, which arrives late, renders as an OS box and cannot show
   the second half of this. Reuses .share-tip rather than inventing a
   second popover, so both hovers on this page look and behave alike.
   The in-game name lives here now because the top-bar deploy pill used to
   be the one path to it from above the fold, and removing that pill took
   the path with it. The footer card still carries the full version — this
   is the short form, on the element people are most likely to poke at.
   Hover only, and only on real pointer devices: on touch the tap has to
   stay a plain reload rather than being swallowed by a tooltip. */
(function logoHint() {
  const el = document.getElementById('logoBtn');
  if (!el || !OWNER_RSN) return;
  const tip = document.createElement('div');
  tip.className = 'share-tip';
  tip.setAttribute('role', 'tooltip');
  tip.id = 'logoTip';
  /* The click does two different things depending on where you are, so the
     tooltip has to be written at open time rather than baked in once: from an
     item page it navigates home (and brings the guide and FAQ with it), and
     from the homepage the same href is a reload. */
  const atHome = () => window.location.pathname === '/' && !window.location.search;
  const fill = () => {
    tip.innerHTML = (atHome()
      ? `<div class="st-title">Tap to <b>refresh</b></div>
         <div class="st-sub">Reloads the page for fresh prices and a reset chart view.</div>`
      : `<div class="st-title">Tap for the <b>homepage</b></div>
         <div class="st-sub">Back to pocketge.com — the guide, the worked example and the FAQ.</div>`) +
      `<ul class="st-list">
        <li>Add me in-game: <b style="color:var(--fav-gold)">${escapeHtml(OWNER_RSN)}</b></li>
        <li>Usually around the GE on ${escapeHtml(OWNER_WORLDS)}</li>
      </ul>`;
  };
  fill();
  document.body.appendChild(tip);

  const place = () => {
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = r.top - h - 8;
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  };
  /* Re-fill on every open: picking an item rewrites the URL under us via
     replaceState, so which of the two messages is true changes without a
     reload. */
  const open = () => { fill(); place(); tip.classList.add('open'); };
  const close = () => tip.classList.remove('open');

  el.addEventListener('mouseenter', () => { if (matchMedia('(hover: hover)').matches) open(); });
  el.addEventListener('mouseleave', close);
  el.addEventListener('focus', open);
  el.addEventListener('blur', close);
  /* No keydown shim any more: it existed because a span with role=button does
     not fire its onclick on Enter. A real anchor does. */
  document.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
})();

/* ── The homepage copy follows the URL ──────────────────────────────────
   Picking an item never reloads — it rewrites the URL with replaceState —
   so the about/FAQ prose used to sit on screen under an item URL, and
   /item/emerald/ rendered one page if you clicked your way there and a
   different one if you refreshed. Same address, two documents.

   The copy now shows in exactly the state a fresh load of the URL would
   show it in: a bare "/" visit, which is what isHomepageDefault already
   means. Clicking an item hides it, clicking home brings it back, and a
   refresh at any point lands on what was already on screen.

   The footer goes with it because the prerenderer cuts from
   .about-section to </body>, so a real item page has no footer either. */
function syncHomepageCopy() {
  document.body.classList.toggle('app-only', !isHomepageDefault);
}
/* Boot takes a couple of seconds to reach setItem, which on a /?q=Cake link
   is long enough to show 7000px of essay and then yank it away. This script
   tag sits above .about-section in the markup, so deciding here — from the
   URL alone, the same input boot uses — means the copy is never painted in
   the first place. Deliberately only ADDS the class: if this is wrong (a ?q=
   naming an item that does not resolve), setItem clears it a moment later,
   whereas defaulting to hidden would blank the homepage outright were the
   app to fail to boot. */
try {
  if (window.__PGE_ITEM__ || new URLSearchParams(window.location.search).get('q')) {
    document.body.classList.add('app-only');
  }
} catch (e) {}

/* Per-item meta refresh. Updates description / OG / Twitter / canonical so a
   shared `/?q=Cake` link's social card shows the actual item, and so each
   `?q=` URL has its own canonical (lets Google index per-item pages instead
   of consolidating everything to /). Idempotent; safe to call repeatedly. */
function setMetaTag(key, val, isProperty) {
  if (val == null) return;
  const attr = isProperty ? 'property' : 'name';
  let el = document.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', val);
}
function setCanonicalLink(url) {
  let el = document.querySelector('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.rel = 'canonical';
    document.head.appendChild(el);
  }
  el.href = url;
}
function updateMetaForItem(m) {
  if (!m) return;
  const title = itemSeoTitle();
  /* Once live prices exist, the description carries real numbers (price,
     insta-buy/-sell, volume, buy limit) — a data-rich snippet beats generic
     boilerplate for CTR and reads as fresh. Before prices land (or if the
     fetch fails) fall back to the evergreen question-form copy. */
  const isSel = selected && String(selected.id) === String(m.id);
  const gp = isSel && liveSellRaw > 0 ? liveSellRaw : 0;
  let desc;
  if (gp) {
    /* Keep it ≤ ~160 chars so Google shows the whole snippet un-truncated. */
    const vol = dailyVolume(m.id);
    /* Leads with the 1-year RANGE rather than a "currently at a 1-year
       low!" style flag. Google caches a description for days-to-weeks, so
       a volatile superlative is false by the time most people read it in
       the SERP — they click expecting an extreme, don't find one, bounce.
       A 1Y range moves slowly, stays true, carries the same "see where
       this sits" hook, and is unique per item. Falls back to the live
       insta-buy/sell pair when there isn't enough history for a range. */
    const y1 = rangeStatsForView(m, '1y');
    desc = `${m.name} is ${fmtGp(gp)} gp on the OSRS Grand Exchange` +
      (y1 ? ` — 1-year range ${fmtGp(y1.lo)}–${fmtGp(y1.hi)} gp`
          : (liveBuyRaw > 0 ? ` (insta-buy ${fmtGp(gp)}, insta-sell ${fmtGp(liveBuyRaw)})` : '')) + '.' +
      ` Live chart & flip margin after 2% tax` +
      (vol ? ` · ${abbreviateNumber(vol)} traded/day` : '') +
      (m.limit ? ` · ${abbreviateNumber(m.limit)} buy limit` : '') + '.';
  } else {
    desc = `How much is ${m.name} in OSRS right now? Live Grand Exchange buy and sell prices, target offer prices with the 2% GE tax already built in, daily volume, and the 5-day high/low. No login.`;
  }
  const url = window.location.href;
  setMetaTag('description', desc);
  setMetaTag('og:title', title, true);
  setMetaTag('og:description', desc, true);
  setMetaTag('og:url', url, true);
  setMetaTag('twitter:title', title);
  setMetaTag('twitter:description', desc.length > 200 ? desc.slice(0, 197) + '…' : desc);
  setCanonicalLink(url.split('#')[0]);
  setItemJsonLd(m, gp, desc);
  /* Same trigger as the meta tags: this runs on every item change AND every
     price tick, so the copy never lags the numbers above it. */
  renderItemSeo(m);
}

/* ── Prerendered item pages ────────────────────────────────────────────────
   Only a subset of items has a static page at /item/<slug>/ (see
   prerender_items.py). The generator writes the list to item-pages.js, which
   loads before this file, so both the canonical URL and the related links can
   point at a real document instead of guessing and linking a 404.
   Empty until the generator has run, in which case everything below falls
   back to the ?q= behaviour the site had before. */
const PGE_PAGES = (() => {
  try { return new Set((window.__PGE_PAGES__ || []).map(n => String(n).toLowerCase())); }
  catch (e) { return new Set(); }
})();
/* Mirrors slugify() in prerender_items.py. If these two ever disagree the
   links point at pages that do not exist, so they are deliberately trivial. */
function itemSlug(name) {
  /* Must match slugify() in prerender_items.py and generate_sitemap.py. "+" is
     spelled out rather than stripped: as punctuation it collapsed the
     (p)/(p+)/(p++) families onto one slug, so this would have sent
     "Adamant bolts (p++)" to the page for "Adamant bolts (p)". */
  return String(name || '').toLowerCase().replace(/\(-\)/g, ' minus ').replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function itemPagePath(name) {
  return PGE_PAGES.has(String(name || '').toLowerCase()) ? `/item/${itemSlug(name)}/` : null;
}

/* ── Per-item indexable copy ───────────────────────────────────────────────
   Generated from data already on the page, so it costs no extra request and
   cannot drift from what the terminal shows.

   Plurality: "Mahogany logs is trading at" reads like scraped spam, so the
   verb agrees with the item. The head noun is the LAST word normally but the
   FIRST word when the name contains " of " — OSRS is full of "Ring of coins"
   and "Bag of salt", which are singular things whose last word is plural.
   -ss and -us are excluded so "Molten glass" and "Cactus" stay singular. */
function isPluralName(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  const head = / of /i.test(n) ? n.split(/\s+/)[0] : n.split(/\s+/).pop();
  const w = head.toLowerCase();
  return /s$/.test(w) && !/(ss|us)$/.test(w);
}
/* Sibling items, by the most distinctive word in the name — "Emerald" for
   Emerald, "Mahogany" for Mahogany logs. Ranked by daily volume so the links
   point at pages worth crawling rather than at dead stock. */
function relatedItems(m, max) {
  if (!m || !Array.isArray(mapping) || !mapping.length) return [];
  const STOP = new Set(['of','the','and','a','an','grimy','raw','cooked','uncut','super','half']);
  const words = String(m.name).toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !STOP.has(w))
    .sort((a, b) => b.length - a.length);
  /* Longest word FIRST, then fall back through the rest. Taking only the
     longest was the first cut and it strands compound names: "Emerald
     necklace" keys on "necklace", matches nothing else in the game, and
     loses the entire Emerald family it should be linking to. Trying each
     word in turn keeps the specific match when one exists and reaches the
     family when it does not. */
  for (const key of words) {
    const hits = mapping
      .filter(x => x.id !== m.id && String(x.name).toLowerCase().includes(key))
      .sort((a, b) => dailyVolume(b.id) - dailyVolume(a.id));
    if (hits.length) return hits.slice(0, max || 4);
  }
  return [];
}
function renderItemSeo(m) {
  const host = document.getElementById('itemSeo');
  const sumEl = document.getElementById('isSummary');
  const qaEl = document.getElementById('isQa');
  const relEl = document.getElementById('isRelated');
  const h1 = document.getElementById('seoH1');
  if (!host || !sumEl || !qaEl || !relEl) return;
  const isSel = m && selected && String(selected.id) === String(m.id);
  const buyNow = isSel && liveSellRaw > 0 ? liveSellRaw : 0;   // insta-buy
  const sellNow = isSel && liveBuyRaw > 0 ? liveBuyRaw : 0;    // insta-sell
  /* No prices, nothing honest to say. Better an absent block than a
     paragraph of em-dashes, which is what a crawler would otherwise index. */
  if (!m || !buyNow) { host.hidden = true; return; }
  const name = escapeHtml(m.name);
  const are = isPluralName(m.name) ? 'are' : 'is';

  /* Terse on purpose. The long form said the same numbers twice — once in
     the paragraph and again in a Q&A pair underneath — and spent a clause
     on "on the Old School RuneScape Grand Exchange" that no reader needed
     at that length. Same facts, roughly a third of the words.
     The spread is no longer stated as a figure: printing both prices says
     it, and dropping the claim retires the zero and negative branches this
     sentence used to need (a 0 gp spread read like a broken template, and
     a stale print on one side could produce a negative one). */
  let out = `<b>${name}</b> ${are} <b>${fmtGp(buyNow)} gp</b> on the OSRS GE`;
  /* Only when the sell side is BELOW the buy side. Above it means the two
     prints are from different moments, not that there is money in it, and the
     pair states a spread whether or not the sentence names one — which is why
     dropping the figure alone was not enough. Mirrors summary_html(). */
  if (sellNow > 0 && sellNow <= buyNow) out += ` (insta-sell ${fmtGp(sellNow)} gp)`;
  out += '.';
  if (sellNow > buyNow) out += ' Both sides last traded at different times — no live spread to quote.';
  const r30 = thirtyDayStats(m);
  const vol = dailyVolume(m.id);
  /* Joined, so a missing range or volume never leaves a stray separator. */
  const facts = [];
  if (r30) facts.push(`30-day range <b>${fmtGp(r30.lo)}–${fmtGp(r30.hi)} gp</b>`);
  if (vol) facts.push(`~${abbreviateNumber(vol)}/day`);
  /* Mirrors summary_html() in prerender_items.py. It has to: hydration
     REPLACES this block, so anything the generated HTML says and this does not
     is deleted the moment the app boots — and Google renders JS, so a fact
     only in the prerendered copy is a fact that mostly does not count. */
  facts.push(m.members ? 'members' : 'F2P');
  if (facts.length) out += ' ' + facts.join(' · ') + '.';
  const tBuy = recommendedBuy, tSell = recommendedSell;
  if (tBuy > 0 && tSell > 0) {
    const per = tSell - tBuy - calculateTax(tSell, m.id);
    out += ` Target ${fmtGp(tBuy)} / ${fmtGp(tSell)} → `;
    /* Still two branches. A spread that cannot beat the tax is not a flip,
       and gems land there often — "+0 gp after tax" would be true and
       useless. And no buy limit is a real state for potions, seeds and raw
       materials, so that clause is dropped rather than invented. */
    out += per > 0
      ? `<b>+${fmtGp(per)} gp after tax</b>` +
        (m.limit > 0 ? ` (~${abbreviateNumber(per * m.limit)} per 4h limit).` : '.')
      : 'no margin after the 2% tax.';
  }
  sumEl.innerHTML = out;

  /* One line, not two questions. "How much is X in OSRS?" repeated the
     price the sentence above had just given; the buy limit is the only
     answer the paragraph does not already carry, since it names the limit
     only as "per 4h limit". Visible text only — still no per-item FAQPage
     schema, which Google dropped for most sites. */
  let qa = m.limit > 0
    ? `<p><b>Buy limit:</b> ${m.limit.toLocaleString()} every 4 hours.</p>`
    : `<p><b>Buy limit:</b> none on this item.</p>`;
  /* High alch, mirroring qa_html() in prerender_items.py. The nature rune's
     own live price comes from the same /latest payload every row on this page
     already reads, so the margin is real rather than a baked-in constant.
     Stated only when alching PROFITS: printing the loss for everything gave
     "Twisted bow … alching loses 1,398,288,996 gp", which is true and reads
     like a broken template — the same failure "a 0 gp spread" had. */
  const alch = Number(m.highalch || 0);
  if (alch > 0) {
    const natNode = latest && latest.data ? latest.data['561'] : null;
    const nat = natNode ? Number(natNode.high || 0) : 0;
    const net = (buyNow && nat) ? alch - buyNow - nat : 0;
    qa += `<p><b>High alch:</b> ${fmtGp(alch)} gp` +
      (net > 0 ? ` — alching profits ${fmtGp(net)} gp after a nature rune.</p>` : '.</p>');
  }
  qaEl.innerHTML = qa;

  const rel = relatedItems(m, 4);
  if (rel.length) {
    relEl.innerHTML = 'Related: ' + rel.map(x =>
      /* the static page when there is one, ?q= otherwise — both resolve to
         the same item, but only one of them is prerendered */
      `<a href="${itemPagePath(x.name) || '/?q=' + encodeURIComponent(x.name)}">${escapeHtml(x.name)}</a>`
    ).join('<span class="is-sep">·</span>');
    relEl.hidden = false;
  } else {
    /* Emptied, not just hidden. Hiding alone left the PREVIOUS item's links
       in the DOM — switching from Emerald ring to Emerald necklace left the
       necklace page holding a hidden link to itself. */
    relEl.innerHTML = '';
    relEl.hidden = true;
  }
  if (h1) h1.textContent = `${m.name} price in OSRS — live Grand Exchange data`;
  /* The item sprite carried one generic alt on every page. Its name is the
     single most on-topic string available for it. */
  const icon = document.getElementById('tickerHeaderIcon');
  if (icon) icon.alt = `${m.name} — OSRS Grand Exchange item icon`;
  host.hidden = false;
}
function clearItemSeo() {
  const host = document.getElementById('itemSeo');
  const h1 = document.getElementById('seoH1');
  if (host) host.hidden = true;
  if (h1) h1.textContent = 'PocketGE: The OSRS Trading Terminal — Grand Exchange Prices, Watchlists & Flip Finder';
}

/* Per-item structured data, swapped in place on every item change:
   BreadcrumbList gives the SERP a "pocketge.com › <Item>" trail, ItemPage +
   dateModified marks the page as a live, per-item document. (No Product/
   Offer schema on purpose — gp is not an ISO-4217 currency, and invalid
   offer markup risks a manual action rather than a rich result.) */
function setItemJsonLd(m, gp, desc) {
  let el = document.getElementById('itemJsonLd');
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/ld+json'; el.id = 'itemJsonLd';
    document.head.appendChild(el);
  }
  const url = `https://pocketge.com/?q=${encodeURIComponent(m.name)}`;
  el.textContent = JSON.stringify([
    {
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "PocketGE — OSRS GE Prices", "item": "https://pocketge.com/" },
        { "@type": "ListItem", "position": 2, "name": m.name }
      ]
    },
    {
      "@context": "https://schema.org", "@type": "ItemPage",
      "url": url,
      "name": `${m.name} — live OSRS Grand Exchange price`,
      "description": desc,
      "dateModified": new Date().toISOString(),
      "isPartOf": { "@type": "WebSite", "name": "PocketGE", "url": "https://pocketge.com/" },
      "mainEntity": {
        "@type": "Thing",
        "name": m.name,
        "image": `https://pocketge.com/images/${m.id}.png`,
        "description": `${m.name} — tradeable Old School RuneScape item.` + (m.limit ? ` Grand Exchange buy limit: ${m.limit.toLocaleString()} per 4 hours.` : '')
      }
    }
  ]);
}
function removeItemJsonLd() {
  const el = document.getElementById('itemJsonLd');
  if (el) el.remove();
}

/* Render the column-customize dropdown PLUS inline sort labels. The ⋯
   button opens column-visibility checkboxes; the sort labels next to it
   one-tap sort the Favorites list (other lists keep their inherent sort
   because the list's name describes its sort — "High Vol Margins" is
   sorted by margin by definition, etc.). */
/* Column header row (TradingView-style) — "Item" on the left, then the
   enabled data columns right-aligned to match the row cells exactly so the
   numbers stack into clean columns. Rebuilt whenever column prefs change. */
/* Single header bar — TradingView style. The column labels ARE the sort
   controls (click a column to sort Favorites by it; click the active one
   again to return to Manual order). The ⋯ on the right opens the
   column-visibility menu. Replaces the old two-row "sort strip + column
   header" stack. */
function renderColToggles() { renderColHeader(); } // back-compat alias
/* Built once, then repainted. This used to rewrite the whole header's
   innerHTML on every column toggle — which destroyed the open menu mid-click.
   Tapping a checkbox made the panel vanish, so the change read as "that did
   nothing", and the natural response (tap it again) put the column straight
   back. Hence "I can't turn off Ea". Repainting only the column strip keeps
   the menu alive so several columns can be toggled in one visit, and stops a
   fresh document click-listener being registered on every toggle. */
let colHeaderBuilt = false;
function renderColHeader() {
  const host = document.getElementById('colHeader');
  if (!host) return;
  if (!colHeaderBuilt) { buildColHeader(host); colHeaderBuilt = true; }
  paintColHeader(host);
}
function buildColHeader(host) {
  /* ⋯ lives on the LEFT of the header (a tiny gear-style button) so the data
     columns can run all the way to the right edge — no reserved right gutter
     eating into every row, which frees ~22px for the item name. */
  host.innerHTML = `
    <span class="ch-name ch-sortable" data-sort="name" role="button" tabindex="0" title="Sort favorites by name">Item<span class="ch-arrow"></span></span>
    <span class="ch-cols"></span>`;
  /* ⋯ and its menu live in the list-name row above, not in the label row —
     appended once here rather than by renderWatchlist, so re-rendering the
     favorites title can't take them with it. */
  const menuHost = document.getElementById('favHeadHost') || host;
  const menuWrap = document.createElement('div');
  menuWrap.className = 'ch-menu-wrap';
  menuWrap.innerHTML = `
    <button type="button" id="btnCols" class="col-menu-btn" aria-label="Customize columns" title="Customize columns" aria-expanded="false">⋯</button>
    <div class="col-menu" id="colMenu" role="menu">
      <div class="col-menu-section">Customize columns</div>
      <label class="col-menu-row"><input type="checkbox" data-col="change"><span><b class="col-menu-tag">Chg%</b> 24h change</span></label>
      <label class="col-menu-row"><input type="checkbox" data-col="margin"><span><b class="col-menu-tag">Ea</b> Margin (after tax)</span></label>
      <label class="col-menu-row"><input type="checkbox" data-col="volume"><span><b class="col-menu-tag">Vol</b> Daily volume</span></label>
      <div class="col-menu-sep"></div>
      <button type="button" class="col-menu-danger" id="btnClearFavs">Clear this list</button>
    </div>`;
  menuHost.appendChild(menuWrap);

  const btn = menuWrap.querySelector('#btnCols');
  const menu = menuWrap.querySelector('#colMenu');
  const closeMenu = () => { menu.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
  /* Empty the ACTIVE list in one go. New users land on a seeded watchlist
     (see FAVORITES_DEFAULTS) and removing a dozen rows one swipe at a time
     to make room for their own is a chore that reads as the app fighting
     them. Two-step rather than a confirm() dialog: the button asks once,
     and reverts on its own after four seconds if the answer is nothing —
     a native confirm is a modal for something that takes one tap to redo
     by re-favouriting, and this keeps the interaction inside the menu.
     Clearing writes an empty list, which the loader treats as a real saved
     state, so the defaults do NOT come back on the next reload. */
  const clearBtn = menuWrap.querySelector('#btnClearFavs');
  if (clearBtn) {
    let armed = null;
    const disarm = () => { clearTimeout(armed); armed = null;
      clearBtn.classList.remove('is-armed'); clearBtn.textContent = 'Clear this list'; };
    clearBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (!armed) {
        if (!favorites.length) return;
        clearBtn.classList.add('is-armed');
        clearBtn.textContent = 'Tap again to clear ' + favorites.length;
        armed = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      for (const id of favorites.slice()) rlPostFavorite(id, '', true);
      favorites = [];
      persistFavoriteLists();
      updateFavoriteBtn();
      closeMenu();
      renderWatchlist();
    };
  }
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const open = menu.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  menu.querySelectorAll('input[data-col]').forEach(cb => {
    cb.onchange = () => {
      columnPrefs[cb.getAttribute('data-col')] = cb.checked;
      saveColPrefs();
      paintColHeader(host);
      renderWatchlist();
    };
  });
  /* Column-label click → sort favorites. Clicking the already-active column
     toggles back to Manual (the user's drag order). Delegated, because the
     column labels are recreated by every paint. Sorting is a one-shot action,
     so picking one from the menu closes it — unlike the checkboxes. */
  const applySort = (el) => {
    const key = el.getAttribute('data-sort');
    favSort = (favSort === key) ? 'manual' : key;
    try { localStorage.setItem('ge_favSort', favSort); } catch (e) {}
    if (menu.contains(el)) closeMenu();
    paintColHeader(host);
    renderWatchlist();
  };
  const sortRoots = [host, menuWrap];
  const owns = (el) => el && sortRoots.some(r => r.contains(el));
  sortRoots.forEach(root => {
    root.addEventListener('click', (ev) => {
      const el = ev.target.closest('.ch-sortable');
      if (owns(el)) applySort(el);
    });
    root.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const el = ev.target.closest && ev.target.closest('.ch-sortable');
      if (owns(el)) { ev.preventDefault(); applySort(el); }
    });
  });
  /* Menu clicks are already excluded by the contains() check, so the menu
     doesn't need to stop propagation — which would otherwise also hide the
     delegated sort handler above from its own "Item type" row. */
  document.addEventListener('click', (ev) => {
    if (menu.classList.contains('open') && !menu.contains(ev.target) && ev.target !== btn) closeMenu();
  });
}
function paintColHeader(host) {
  const arrow = (key) => favSort === key ? '↓' : '';
  /* Each column header doubles as a sort button. data-sort maps the column
     to its favSort key. */
  const col = (cls, sortKey, label) =>
    `<span class="${cls} ch-sortable ${favSort === sortKey ? 'sorted' : ''}" data-sort="${sortKey}" role="button" tabindex="0" title="Sort favorites by ${label}">${label}<span class="ch-arrow">${arrow(sortKey)}</span></span>`;
  let cols = col('ch-last', 'price', 'Last');
  if (columnPrefs.change) cols += col('ch-chg', 'change', 'Chg%');
  if (columnPrefs.margin) cols += col('ch-ea', 'margin', 'Ea');
  if (columnPrefs.volume) cols += col('ch-vol', 'volume', 'Vol');
  host.querySelector('.ch-cols').innerHTML = cols;
  document.querySelectorAll('.col-menu input[data-col]').forEach(cb => {
    cb.checked = !!columnPrefs[cb.getAttribute('data-col')];
  });
  document.querySelectorAll('#colHeader .ch-name').forEach(el => {
    const key = el.getAttribute('data-sort');
    el.classList.toggle('sorted', favSort === key);
    const a = el.querySelector('.ch-arrow');
    if (a) a.textContent = arrow(key);
  });
}

function renderWatchlist() {
  const container = $("#watchlistContent");
  container.innerHTML = "";
  const favHeadTitle = document.getElementById('favHeadTitle');
  if (favHeadTitle) favHeadTitle.innerHTML = "";

  let activeItems = membersOn ? mapping : mapping.filter(m => !m.members);

  /* Favorites are ordered to MATCH the favorites array (user-reorderable),
     so up/down moves persist in the visible list. */
  const favsById = new Map(activeItems.map(it => [String(it.id), it]));
  /* When linked to RuneLite AND the currently active local list's name
     matches one of the plugin's lists, that list's items are unioned in
     for display — never written to the local list, so they simply drop
     back out if the link goes away and never touch the user's own saved
     order. Lists with no matching name on the other side just don't merge. */
  const rlMatchedIds = rlWanted ? rlMatchedFavIds() : [];
  const mergedFavIds = rlMatchedIds.length
    ? Array.from(new Set([...favorites.map(String), ...rlMatchedIds.map(String)]))
    : favorites;
  const favs = mergedFavIds.map(id => favsById.get(String(id))).filter(Boolean);

  const dayLows = [], dayHighs = [], marginHigh1d = [], marginLow1d = [], movers = [];
  const mover1dPct = {}; // id -> % (live mid vs 24h avg mid), for inline fav badges

  activeItems.forEach(item => {
    const id = String(item.id);
    if (overMaxData[id]) return;
    const node = latest?.data?.[id];
    const p24 = past24h?.data?.[id];

    /* 5D breakout test — use the API's rolling 1h volume-weighted high/low
       across the last 5 days, NOT the 24h band. Item only qualifies when the
       live competitive price is testing or breaching the actual 5-day outer
       extreme (within 0.5%, or above/below it). Requires a meaningful 5D
       range (>= 3% of price) so flat items don't trigger on rounding noise.
       Only items in the bounded scan-candidate pool have a populated
       dayHiLoCache entry — others are silently skipped (no per-item fetch). */
    const ex = dayHiLoCache[id];
    if (ex && ex.hi5d > 0 && ex.lo5d > 0 && (ex.hi5d - ex.lo5d) >= ex.lo5d * 0.03) {
      const sell = node?.high || 0, buy = node?.low || 0;
      if (sell > 0 && sell >= ex.hi5d * 0.995) dayHighs.push(item);
      else if (buy > 0 && buy <= ex.lo5d * 1.005) dayLows.push(item);
    }

    /* 1D margin from the live instant-buy/instant-sell spread — the real margin
       a flipper can capture right now. The 24h volume-weighted averages compress
       the true spread and were hiding genuinely-spread items (e.g. uncut diamond)
       while surfacing misleading near-zero margins. Require recent trades both sides. */
    if (node && node.high > 0 && node.low > 0 && node.high > node.low
        && p24 && (p24.highPriceVolume || 0) > 0 && (p24.lowPriceVolume || 0) > 0) {
      const sell = node.high, buy = node.low;
      const margin = sell - buy - calculateTax(sell, item.id);
      if (margin > 0 && margin < sell * 0.7) {
        const row = { item, margin };
        if (isLowVolume(item.id)) marginLow1d.push(row); else marginHigh1d.push(row);
      }
    }

    /* 1D movers — live mid price vs its 24h volume-weighted average mid. A
       bulk-computable momentum read (no per-item fetch) that captures news
       spikes / dumps the 5D position lists miss. Stored per-id for the inline
       favorites badge; the discovery sections additionally junk-filter on
       price, volume, and a >=3% move so penny pumps don't dominate. */
    if (node && node.high > 0 && node.low > 0
        && p24 && p24.avgHighPrice > 0 && p24.avgLowPrice > 0) {
      const curMid = (node.high + node.low) / 2;
      const avgMid = (p24.avgHighPrice + p24.avgLowPrice) / 2;
      if (avgMid > 0) {
        const pct = (curMid - avgMid) / avgMid * 100;
        mover1dPct[id] = pct;
        /* Volume floor matches LOW_VOL_THRESHOLD (100k/day) — anything below
           that, a single seller's dump can fake a 5% drop. Restricting
           movers to high-volume names means a -5% on Coal or Adamantite bar
           is a real dip-buy candidate, not one whale liquidating a niche. */
        const vol = (p24.highPriceVolume || 0) + (p24.lowPriceVolume || 0);
        if (curMid >= 100 && vol >= LOW_VOL_THRESHOLD && Math.abs(pct) >= 3) movers.push({ item, pct });
      }
    }
  });

  dayLows.sort((a, b) => priceOf(b) - priceOf(a));
  dayHighs.sort((a, b) => priceOf(b) - priceOf(a));
  marginHigh1d.sort((a, b) => b.margin - a.margin);
  marginLow1d.sort((a, b) => b.margin - a.margin);

  /* Winners (24H) was removed: an item that already pumped is the LEAST
     actionable for a buy-low-sell-high flipper — entry's missed and you
     probably don't hold to sell. Losers stays — those are genuine dip-buys. */
  const losers  = movers.filter(m => m.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, 15);

  /* Unified row meta — every category uses this so the sidebar shows the
     same {% change · ea margin · daily volume} triplet on every row, with
     "—" placeholders when a value is unavailable. Which columns render is
     gated by columnPrefs, controlled by the toggle pills above the list. */
  function buildMeta(item, overrides) {
    overrides = overrides || {};
    const id = String(item.id);
    const parts = [];
    if (columnPrefs.change) {
      const pct = (overrides.pct != null) ? overrides.pct : mover1dPct[id];
      if (pct == null) {
        parts.push(`<span class="meta-piece meta-chg neutral" title="Live price vs 24h average">—</span>`);
      } else {
        const cls = pct >= 1 ? 'up' : pct <= -1 ? 'down' : 'neutral';
        const rounded = pct.toFixed(1);
        const display = (rounded === '0.0' || rounded === '-0.0') ? '0.0%' : `${pct > 0 ? '+' : ''}${rounded}%`;
        parts.push(`<span class="meta-piece meta-chg ${cls}" title="Live price vs its 24-hour average">${display}</span>`);
      }
    }
    if (columnPrefs.margin) {
      let margin = (overrides.margin != null) ? overrides.margin : null;
      if (margin == null) {
        const node = latest && latest.data ? latest.data[id] : null;
        if (node && node.high > 0 && node.low > 0 && node.high > node.low) {
          const m = node.high - node.low - calculateTax(node.high, id);
          if (m > 0 && m < node.high * 0.7) margin = m;
        }
      }
      if (margin != null && margin > 0) {
        parts.push(`<span class="meta-piece meta-ea up" title="${overrides.marginLabel || 'Margin per item, after 2% GE tax'}">+${abbreviateNumber(margin)}</span>`);
      } else {
        parts.push(`<span class="meta-piece meta-ea neutral" title="No profitable spread right now (after 2% tax)">—</span>`);
      }
    }
    if (columnPrefs.volume) {
      const vol = (overrides.vol != null) ? overrides.vol : dailyVolume(item.id);
      /* Favorites rows: the delete button lives INSIDE the vol cell, wrapped
         with the K/M suffix in a positioned .mv-swap span, so on hover the
         trash paints exactly where the suffix character is — "1.53M" reads
         "1.53[🗑]" with zero layout shift (TradingView-style). Anchoring it
         to the row edge (the old approach) drifted off the suffix because
         row padding varies by breakpoint. */
      const favBtn = overrides.favRemove
        ? `<button type="button" class="wl-fav-remove" data-fav-id="${item.id}" title="Remove from favorites" aria-label="Remove ${item.name} from favorites"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg></button>`
        : '';
      if (vol > 0) {
        const ab = String(abbreviateNumber(vol));
        const sm = ab.match(/^(.*?)([KMB])$/);
        const volHtml = sm
          ? (favBtn ? `${sm[1]}<span class="mv-swap"><span class="mv-sfx">${sm[2]}</span>${favBtn}</span>` : `${sm[1]}<span class="mv-sfx">${sm[2]}</span>`)
          /* No suffix (raw number like "850"): swap in over the whole value. */
          : (favBtn ? `<span class="mv-swap"><span class="mv-sfx">${ab}</span>${favBtn}</span>` : ab);
        parts.push(`<span class="meta-piece meta-vol" title="Daily traded volume">${volHtml}</span>`);
      } else {
        const dashHtml = favBtn ? `<span class="mv-swap"><span class="mv-sfx">—</span>${favBtn}</span>` : '—';
        parts.push(`<span class="meta-piece meta-vol" title="Daily traded volume">${dashHtml}</span>`);
      }
    }
    return parts.length ? `<span class="wl-meta">${parts.join('')}</span>` : '';
  }

  /* Every entry helper now defers to buildMeta — guarantees consistent
     columns across all categories. Per-category overrides feed in the
     value the category specifically tracks (mover %, average margin, etc.)
     so we don't recompute it from latest data when we already have it. */
  const plainEntries = (items) => items.map(item => ({ item, price: priceOf(item), sub: buildMeta(item) }));
  const favEntries = (items) => items.map(item => ({ item, price: priceOf(item), sub: buildMeta(item, { favRemove: true }) }));
  const marginEntries = (rows, tag) => rows.slice(0, 30).map(r => ({
    item: r.item, price: priceOf(r.item),
    sub: buildMeta(r.item, { margin: r.margin, marginLabel: tag === 'ea avg' ? '14-day average margin per item, after 2% GE tax' : 'Live margin per item, after 2% GE tax' })
  }));
  const moverEntries = (rows) => rows.map(r => ({ item: r.item, price: priceOf(r.item), sub: buildMeta(r.item, { pct: r.pct }) }));

  /* Apply the favorites sort (display-only — never mutates the saved order,
     so switching back to Manual restores the user's drag arrangement). */
  let favsSorted = favs;
  if (favSort !== 'manual') {
    favsSorted = [...favs];
    const liveMargin = (it) => {
      const n = latest && latest.data ? latest.data[String(it.id)] : null;
      if (!n || !(n.high > 0) || !(n.low > 0) || n.high <= n.low) return -Infinity;
      const m = n.high - n.low - calculateTax(n.high, it.id);
      return (m > 0 && m < n.high * 0.7) ? m : -Infinity;
    };
    if (favSort === 'price') favsSorted.sort((a, b) => priceOf(b) - priceOf(a));
    else if (favSort === 'name') favsSorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (favSort === 'change') favsSorted.sort((a, b) => (mover1dPct[String(b.id)] ?? -Infinity) - (mover1dPct[String(a.id)] ?? -Infinity));
    else if (favSort === 'margin') favsSorted.sort((a, b) => liveMargin(b) - liveMargin(a));
    else if (favSort === 'volume') favsSorted.sort((a, b) => dailyVolume(b.id) - dailyVolume(a.id));
  }

  /* Reliable 14D Margins entries — uses cache populated by
     runSteadyFlipsScan(). Pass the multi-day mean margin + average daily
     volume into buildMeta so the row shows {%Δ · +meanMargin · vol}
     consistent with every other category. */
  const steadyEntries = steadyFlipsCache.slice(0, 30).map(r => ({
    item: r.item, price: priceOf(r.item),
    sub: buildMeta(r.item, { margin: r.meanMargin, marginLabel: `${r.days}-day average margin per item, after 2% GE tax`, vol: r.vol })
  }));

  /* Final scanner ordering — favorites pinned on top, then live margins
     (the right-now snapshot), then Steady Flips (reliable day-over-day
     grinds, the thing serious flippers actually farm), then dip-buys, then
     5D extremes. Winners (24H) was dropped: an item that already pumped is
     the least actionable thing for a buy-low-sell-high flipper. */
  const groups = [
    /* Display name follows whichever list is active (e.g. "Long holds"),
       but the collapse-state key stays fixed so switching lists doesn't
       reset whether the section is expanded. */
    { name: activeFavList().name, key: "Favorites", className: "fav-title", entries: favEntries(favsSorted), alwaysShow: true },
    { name: "High Vol Margins", className: "margin-title", entries: marginEntries(marginHigh1d, "ea"), pageUrl: "/high-vol-margins.html" },
    { name: "Low Vol Margins", className: "marginlo-title", entries: marginEntries(marginLow1d, "ea"), pageUrl: "/low-vol-margins.html" },
    { name: "Reliable 14D Margins", className: "steady-title", entries: steadyEntries, scan: "steady", pageUrl: "/reliable-14d-margins.html" },
    { name: "Biggest Losers (24H)", className: "fall-title", entries: moverEntries(losers), pageUrl: "/biggest-losers-24h.html" },
    { name: "At 5D Highs", className: "high-title", entries: plainEntries(dayHighs.slice(0, 30)), scan: "fived", pageUrl: "/at-5d-highs.html" },
    { name: "At 5D Lows", className: "low-title", entries: plainEntries(dayLows.slice(0, 30)), scan: "fived", pageUrl: "/at-5d-lows.html" }
  ];

  const fragment = document.createDocumentFragment();
  /* Builds one collapsible title+list pair. Shared by the top-level
     Favorites group and each scanner group nested inside "Find
     Opportunities" below — `nested` just swaps in a smaller, non-sticky
     title style, since the outer wrapper's own title already does the
     sticky/section-header job for all six at once. */
  function buildGroupDiv(group, nested) {
    const hasScan = !!group.scan;
    const scanState = hasScan ? scanStatus[group.scan] : null;
    if (group.entries.length === 0 && !group.alwaysShow && !hasScan) return null;
    const stateKey = group.key || group.name;
    const isFavTitle = group.className === "fav-title";
    const groupDiv = document.createElement("div"); groupDiv.className = `category-group${nested ? ' nested' : ''}`;
    /* Favorites never collapses — there's nothing to toggle, only which
       list is showing — so it ignores any stale stored collapse state
       from before this changed (otherwise a list collapsed under the old
       chevron would have no way to reopen now that the chevron is gone). */
    const isGroupOpen = isFavTitle ? true : groupOpenStates[stateKey] !== false;
    const titleDiv = document.createElement("div");
    titleDiv.className = `category-title ${group.className}${nested ? ' nested' : ''}`;
    /* No Edit button anymore — the per-row × reveals on hover (desktop) /
       is always shown (touch), TradingView-style. "Linked" only shows
       when the ACTIVE list's name actually matches one of the plugin's
       lists — with multiple lists, being connected doesn't mean every
       list merges. */
    const rlBadge = (isFavTitle && rlConnected && rlMatchedFavIds().length) ? `<span class="rl-linked-badge" title="Live-linked to your RuneLite Favorites (list name match)"><span class="rl-dot on"></span>Linked</span>` : '';
    if (isFavTitle) {
      /* The list-switcher IS the title's name slot — a "[list] ⌄" button
         opening a dropdown of every list — and "+" replaces the collapse
         chevron on the right, since this title never collapses. Create/
         rename happen INLINE as a text input swapped into the dropdown
         row (see flsCreatingNew/flsEditingListId), not a native prompt(). */
      const listMenuHtml = favoriteLists.map(l => l.id === flsEditingListId ? `
        <div class="fls-menu-row editing">
          <input type="text" class="fls-menu-input" data-list-id="${l.id}" value="${escapeHtml(l.name)}" maxlength="40">
        </div>` : `
        <div class="fls-menu-row ${l.id === activeFavListId ? 'active' : ''}">
          <span class="fls-menu-name" data-list-id="${l.id}" role="button" tabindex="0" title="Switch to &quot;${escapeHtml(l.name)}&quot;">${escapeHtml(l.name)}</span>
          <button type="button" class="fls-rename" data-list-id="${l.id}" title="Rename list" aria-label="Rename ${escapeHtml(l.name)}">${uiIcon('pencil')}</button>
          ${favoriteLists.length > 1 ? `<button type="button" class="fls-delete" data-list-id="${l.id}" title="Delete list" aria-label="Delete ${escapeHtml(l.name)}">×</button>` : ''}
        </div>`).join('')
        + (flsCreatingNew ? `<div class="fls-menu-row editing"><input type="text" class="fls-menu-input" data-new="1" placeholder="List name" maxlength="40"></div>` : '');
      const flsMenuOpen = flsCreatingNew || flsEditingListId != null;
      titleDiv.innerHTML = `
        <span class="cat-title-label">
          <button type="button" class="fls-current${flsMenuOpen ? ' open' : ''}" id="flsCurrent" aria-haspopup="true" aria-expanded="${flsMenuOpen ? 'true' : 'false'}">
            <span class="fls-name">${escapeHtml(group.name)}</span>
            <span class="fls-caret">${uiIcon('chev')}</span>
          </button>
          ${rlBadge}
        </span>
        <button type="button" class="fls-add" title="New favorites list" aria-label="New favorites list">+</button>
        <div class="fls-menu${flsMenuOpen ? ' open' : ''}" id="flsMenu" role="menu">${listMenuHtml}</div>`;
    } else {
      titleDiv.innerHTML = `<span class="cat-title-label">${escapeHtml(group.name)}</span><span class="cat-title-right"><span class="cat-chevron${isGroupOpen ? '' : ' closed'}">${uiIcon('chev')}</span></span>`;
    }
    const listDiv = document.createElement("div");
    listDiv.className = `category-list ${isGroupOpen ? "" : "collapsed"}`;
    if (!isFavTitle) {
      titleDiv.onclick = () => {
        const nowCollapsed = listDiv.classList.toggle("collapsed");
        titleDiv.querySelector(".cat-chevron").classList.toggle('closed', nowCollapsed);
        groupOpenStates[stateKey] = !nowCollapsed;
        /* nested === true is exactly the Find Opportunities children (the only
           other caller passes the Favorites group, which takes the isFavTitle
           branch and never reaches this handler). State rather than an
           open-only event, matching the other toggles here, so the open rate
           is a ratio inside one event instead of a join across two. */
        if (nested) {
          track('opportunities_category', {
            category: group.name,
            state: nowCollapsed ? 'closed' : 'open',
          });
        }
        if (!nowCollapsed && hasScan && scanStatus[group.scan] === 'idle') {
          if (group.scan === 'fived') runFiveDayScan();
          else if (group.scan === 'steady') runSteadyFlipsScan();
        }
      };
    }
    let inner = "";
    if (hasScan && scanState !== 'done' && group.entries.length === 0) {
      const loadLabel = group.scan === 'steady' ? 'Scanning the last 14 days of margins…' : 'Scanning 5-day extremes…';
      const idleLabel = group.scan === 'steady' ? 'Tap to scan 14-day reliable margins' : 'Tap to scan 5-day extremes (top items)';
      if (scanState === 'loading') inner = `<div class="scan-row loading">${uiIcon('loader', 'ic-spin')} ${loadLabel}</div>`;
      else inner = `<div class="scan-row" data-scan="${group.scan}">${uiIcon('search')} ${idleLabel}</div>`;
    } else if (group.entries.length === 0) {
      const emptyMsg = isFavTitle
        ? `No favorites in "${escapeHtml(group.name)}" yet — star an item to add it.`
        : group.scan === 'steady'
          ? 'No items met the consistency bar over the last 14 days'
          : 'Nothing at a 5-day extreme right now';
      inner = `<div class="wl-item" style="color:var(--text-muted); justify-content:center;">${emptyMsg}</div>`;
    } else {
      /* Keyed on className, not the display name — the name already got
         reworded once (emoji purge) and silently broke this check. */
      const isFavGroup = group.className === "fav-title";
      group.entries.forEach(e => {
        const item = e.item, id = String(item.id);
        const node = latest?.data?.[id];
        const p24 = past24h?.data?.[id];
        let hlClass = "";
        if (!overMaxData[id]) {
          const st = dayState(node, p24, id);
          if (st === "high5d") hlClass = "at-high5d";
          else if (st === "low5d") hlClass = "at-low5d";
          else if (st === "high") hlClass = "at-high";
          else if (st === "low") hlClass = "at-low";
        }
        /* Spike tier — a genuine ±15%+ move vs 24h typical, rarer and more
           urgent than a routine 5D extreme, so it takes over the row's
           highlight class entirely rather than stacking with it. Color
           still tells you which way it moved (green/gold up, red/magenta
           down), matching the RuneLite plugin's identical treatment. */
        const spikePct = mover1dPct[id];
        if (spikePct != null && Math.abs(spikePct) >= 15) {
          hlClass = spikePct >= 0 ? 'at-spike-up' : 'at-spike-down';
        }
        const activeClass = selected?.id === item.id ? 'active' : '';
        const hlBadge =
            hlClass === 'at-spike-up'   ? `<span class="hl-badge high5d" title="Spiking — up ${spikePct.toFixed(1)}% vs its 24h typical price.">🚀 ${spikePct >= 0 ? '+' : ''}${spikePct.toFixed(0)}%</span>`
          : hlClass === 'at-spike-down' ? `<span class="hl-badge low5d" title="Spiking — down ${Math.abs(spikePct).toFixed(1)}% vs its 24h typical price.">💥 ${spikePct.toFixed(0)}%</span>`
          : hlClass === 'at-high5d' ? `<span class="hl-badge high5d" title="At or near the 5-DAY HIGH — notable peak across the last 5 days.">▲ 5D</span>`
          : hlClass === 'at-low5d'  ? `<span class="hl-badge low5d"  title="At or near the 5-DAY LOW — notable trough across the last 5 days.">▼ 5D</span>`
          : hlClass === 'at-high'   ? `<span class="hl-badge high" title="Currently at or above its 24-hour high. Sell now to catch the peak.">▲</span>`
          : hlClass === 'at-low'    ? `<span class="hl-badge low" title="Currently at or below its 24-hour low. Buy now to catch the dip.">▼</span>` : '';
        /* Favorites delete now rides inside the vol cell (see buildMeta) so
           it lands exactly on the K/M suffix. Fallback: if the VOL column is
           toggled off there's no cell to ride in, so fall back to a
           row-level button in the right gutter. Swipe-left ("REMOVE"
           backdrop) still handles touch. */
        /* Always render the row-gutter fallback for fav rows; CSS shows it
           only when the VOL column (which hosts the primary in-cell trash)
           is unavailable. */
        const removeBtn = isFavGroup ? `<button type="button" class="wl-fav-remove wl-fav-remove-row" data-fav-id="${item.id}" title="Remove from favorites" aria-label="Remove ${item.name} from favorites"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg></button>` : '';
        const swipeBg = isFavGroup ? `<span class="wl-swipe-bg">REMOVE</span>` : '';
        inner += `
          <div class="wl-item ${activeClass} ${hlClass}" data-id="${item.id}" ${isFavGroup ? `data-fav-row="1" data-fav-id="${item.id}"` : ''}>
            ${swipeBg}
            <div class="wl-item-left">
              <img src="${itemIconUrl(item.id)}" alt="${item.name} icon" loading="lazy">
              <span class="wl-item-name">${item.name}</span>
              ${hlBadge}
            </div>
            <div class="wl-item-right">
              <span class="wl-item-price">${abbreviateNumber(e.price)}</span>
              ${e.sub}
            </div>
            ${removeBtn}
          </div>`;
      });
    }
    // A real, indexable page for this category — separate from (and linked
    // to, not replacing) this same live scanner. Crawlable content Google
    // can actually rank for "osrs high volume flips" etc., where this
    // interactive widget itself can't be.
    if (group.pageUrl) {
      inner += `<a class="wl-page-link" href="${group.pageUrl}">${uiIcon('external')} About this list &amp; a live top 10 →</a>`;
    }
    listDiv.innerHTML = inner;
    /* The favorites title is hoisted out of the list and into the header
       host above the column labels; every other group keeps its title
       inline, since only the active list gets the terminal treatment. */
    const favHead = document.getElementById('favHeadTitle');
    if (isFavTitle && favHead) favHead.appendChild(titleDiv);
    else groupDiv.appendChild(titleDiv);
    groupDiv.appendChild(listDiv);
    return groupDiv;
  }

  const favDiv = buildGroupDiv(groups[0], false);
  if (favDiv) fragment.appendChild(favDiv);

  /* The six scanner sections used to render as six always-visible bars —
     ~210px of chrome above the favorites list on every load, even though
     every one of them defaults to collapsed (see groupOpenStates). They
     collapse into one "Find Opportunities" wrapper instead: same six
     sections one tap away, each still individually collapsible and
     remembering its own open/closed state, but only a single header's
     worth of height by default. */
  const FIND_OPPS_KEY = "FindOpportunities";
  const findOppsOpen = groupOpenStates[FIND_OPPS_KEY] === true; // opt-in open, unlike the rest
  const findOppsDiv = document.createElement("div");
  findOppsDiv.className = "category-group";
  const findOppsTitle = document.createElement("div");
  findOppsTitle.className = "category-title find-opps-title";
  findOppsTitle.innerHTML = `<span class="cat-title-label">Find Opportunities</span><span class="cat-title-right"><span class="cat-chevron${findOppsOpen ? '' : ' closed'}">${uiIcon('chev')}</span></span>`;
  const findOppsBody = document.createElement("div");
  findOppsBody.className = `category-list find-opps-body${findOppsOpen ? '' : ' collapsed'}`;
  findOppsTitle.onclick = () => {
    const nowCollapsed = findOppsBody.classList.toggle("collapsed");
    findOppsTitle.querySelector(".cat-chevron").classList.toggle('closed', nowCollapsed);
    groupOpenStates[FIND_OPPS_KEY] = !nowCollapsed;
    track('find_opportunities_toggle', { state: nowCollapsed ? 'closed' : 'open' });
  };
  groups.slice(1).forEach(group => {
    const gd = buildGroupDiv(group, true);
    if (gd) findOppsBody.appendChild(gd);
  });
  findOppsDiv.appendChild(findOppsTitle);
  findOppsDiv.appendChild(findOppsBody);
  container.appendChild(fragment);
  /* Separate host so this block can sit after the Recommended Flip card in
     landscape without needing to live inside the favorites container. */
  const oppsHost = $("#findOppsHost");
  if (oppsHost) { oppsHost.innerHTML = ""; oppsHost.appendChild(findOppsDiv); }
  const flsCurrent = document.querySelector('#flsCurrent');
  const flsMenu = document.querySelector('#flsMenu');
  const closeFlsMenu = () => { if (!flsCurrent) return; flsCurrent.classList.remove('open'); flsMenu.classList.remove('open'); flsCurrent.setAttribute('aria-expanded', 'false'); };
  if (flsCurrent) {
    flsCurrent.onclick = (ev) => {
      ev.stopPropagation();
      const open = flsMenu.classList.toggle('open');
      flsCurrent.classList.toggle('open', open);
      flsCurrent.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
  }
  if (flsMenu) flsMenu.addEventListener('click', (ev) => ev.stopPropagation());
  /* renderWatchlist rebuilds this menu on every refresh (favorite change,
     sort, 5-min poll, …) — track the one active outside-click listener and
     swap it out each time instead of stacking a new one against a detached
     node on every render. */
  if (_flsOutsideClickHandler) document.removeEventListener('click', _flsOutsideClickHandler);
  _flsOutsideClickHandler = (ev) => {
    if (flsMenu && flsMenu.classList.contains('open') && !flsMenu.contains(ev.target) && ev.target !== flsCurrent) closeFlsMenu();
  };
  document.addEventListener('click', _flsOutsideClickHandler);
  document.querySelectorAll('.fls-menu-name').forEach(el => {
    const apply = () => { closeFlsMenu(); switchFavoriteList(el.getAttribute('data-list-id')); };
    el.onclick = apply;
    el.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); apply(); } };
  });
  document.querySelectorAll('.fls-rename').forEach(el => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      flsCreatingNew = false;
      flsEditingListId = el.getAttribute('data-list-id');
      renderWatchlist();
    };
  });
  document.querySelectorAll('.fls-delete').forEach(el => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      const listId = el.getAttribute('data-list-id');
      const l = favoriteLists.find(x => x.id === listId);
      if (l && confirm(`Delete the "${l.name}" list and its favorites?`)) deleteFavoriteListLocal(listId);
    };
  });
  const addListBtn = document.querySelector('.fls-add');
  if (addListBtn) {
    addListBtn.onclick = (ev) => {
      ev.stopPropagation();
      flsEditingListId = null;
      flsCreatingNew = true;
      renderWatchlist();
    };
  }
  /* Inline create/rename input — on-theme text field swapped into the
     dropdown row instead of a native prompt() dialog. Enter commits,
     Escape cancels, blur commits (so clicking away still saves, matching
     how most inline-rename UIs behave) — guarded against double-firing
     since Enter's commit and the resulting blur can both fire. */
  document.querySelectorAll('.fls-menu-input').forEach(input => {
    let done = false;
    const isNew = input.getAttribute('data-new') === '1';
    const listId = input.getAttribute('data-list-id');
    const commit = () => {
      if (done) return; done = true;
      const val = input.value.trim();
      flsCreatingNew = false; flsEditingListId = null;
      if (isNew) { if (val) createFavoriteListLocal(val); else renderWatchlist(); }
      else { if (val) renameFavoriteListLocal(listId, val); else renderWatchlist(); }
    };
    const cancel = () => {
      if (done) return; done = true;
      flsCreatingNew = false; flsEditingListId = null;
      renderWatchlist();
    };
    input.addEventListener('click', (ev) => ev.stopPropagation());
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
  });
  const flsFocusInput = document.querySelector('.fls-menu-input');
  if (flsFocusInput) { flsFocusInput.focus(); flsFocusInput.select(); }
  /* Tell CSS whether the VOL column is present, so the fav-delete fallback
     knows when the in-cell trash exists (see .wl-fav-remove-row rules). */
  container.classList.toggle('has-vol', !!columnPrefs.volume);

  /* Rows live in TWO hosts. The favorites groups are appended to
     #watchlistContent, but Find Opportunities is moved into its own
     #findOppsHost sibling above, so it can be reordered independently in
     landscape. Anything binding row behaviour therefore has to walk both —
     container.querySelectorAll() alone silently skips every row under Find
     Opportunities, which is how those rows ended up rendering with data-id
     and cursor:pointer and then doing nothing at all when clicked. The
     scanner trigger rows nested in there were dead for the same reason. */
  const rowHosts = [container, $("#findOppsHost")].filter(Boolean);
  const eachRow = (sel, fn) => rowHosts.forEach(h => h.querySelectorAll(sel).forEach(fn));

  eachRow('.scan-row[data-scan="fived"]', el => {
    el.onclick = () => runFiveDayScan();
  });
  eachRow('.scan-row[data-scan="steady"]', el => {
    el.onclick = () => runSteadyFlipsScan();
  });
  eachRow('.wl-item[data-id]', el => {
    el.onclick = (ev) => {
      /* Don't navigate when the user clicks the per-row × / drag handle,
         just finished dragging the row to reorder it (suppressClick, set by
         wireFavoritesDrag), or after a swipe has revealed the remove
         backdrop. */
      if (ev.target.closest('.wl-fav-remove')) return;
      if (el.dataset.suppressClick) return;
      if (el.classList.contains('swipe-revealed')) {
        el.classList.remove('swipe-revealed');
        return;
      }
      const m = mapping.find(x => String(x.id) === String(el.getAttribute('data-id')));
      if (m) { setItem._userPicked = false; setItem(m); }
    };
  });

  /* Quick-remove from favorites — clicking the per-row × unfavorites without
     navigating. Updates localStorage, re-renders, refreshes the top star. */
  function unfavorite(idStr) {
    if (!favorites.includes(idStr)) return;
    favorites = favorites.filter(x => x !== idStr);
    persistFavoriteLists();
    rlPostFavorite(idStr, '', true);
    updateFavoriteBtn();
    renderWatchlist();
  }
  eachRow('.wl-fav-remove', b => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      unfavorite(String(b.getAttribute('data-fav-id')));
    };
  });

  wireFavoritesDrag(container);

  /* Swipe-left to remove on touch devices. Threshold of 40px reveals the
     "REMOVE" backdrop and animates the row content out of the way; releasing
     past 80px commits the unfavorite, otherwise it snaps back. */
  container.querySelectorAll('.wl-item[data-fav-row="1"]').forEach(row => {
    let startX = 0, startY = 0, dx = 0, dragging = false, revealed = false;
    const left = row.querySelector('.wl-item-left');
    const right = row.querySelector('.wl-item-right');
    const apply = (px) => {
      if (left)  left.style.transform  = `translateX(${px}px)`;
      if (right) right.style.transform = `translateX(${px}px)`;
    };
    row.addEventListener('touchstart', (ev) => {
      const t = ev.touches[0]; startX = t.clientX; startY = t.clientY;
      dx = 0; dragging = false;
      revealed = row.classList.contains('swipe-revealed');
      row.classList.add('swiping');
    }, { passive: true });
    row.addEventListener('touchmove', (ev) => {
      /* A row being reordered is not being swiped — without this the row
         would slide sideways under the finger mid-drag. */
      if (favDragId) return;
      const t = ev.touches[0]; const x = t.clientX - startX; const y = t.clientY - startY;
      if (!dragging && Math.abs(x) > Math.abs(y) + 4 && Math.abs(x) > 6) dragging = true;
      if (!dragging) return;
      dx = Math.min(0, Math.max(-110, x + (revealed ? -56 : 0)));
      apply(dx);
    }, { passive: true });
    row.addEventListener('touchend', () => {
      row.classList.remove('swiping');
      if (!dragging) return;
      if (dx < -80) { unfavorite(String(row.getAttribute('data-id'))); return; }
      if (dx < -28) { row.classList.add('swipe-revealed'); apply(''); return; }
      row.classList.remove('swipe-revealed'); apply('');
    });
  });

  /* fetch true intraday extremes for the visible favorites (+ the selected item)
     so their glow reflects the actual recent peak/trough, not the coarse average. */
  const idsToScan = favs.map(i => String(i.id));
  if (selected) idsToScan.push(String(selected.id));
  scanDayExtremes(idsToScan);

  /* Refresh the tab-title (N) badge against the same data the watchlist
     just rendered against. scanDayExtremes will re-render the watchlist
     once it resolves, so this is called again then with the fresh cache. */
  applyTitleBadge();
}

function seriesFromTS(ts) {
  const src = ts?.data || [];
  const rows = src.map(r => ({
    t: Number(r.timestamp ?? r.ts ?? r.time),
    lo: r.avgLowPrice ?? r.low ?? null,
    hi: r.avgHighPrice ?? r.high ?? null,
    lowVol: r.lowPriceVolume ?? 0,
    highVol: r.highPriceVolume ?? 0
  })).filter(r => r.t && (r.lo != null || r.hi != null)).sort((a, b) => a.t - b.t);
  return { labels: rows.map(r => r.t), low: rows.map(r => r.lo), high: rows.map(r => r.hi), lowVol: rows.map(r => r.lowVol), highVol: rows.map(r => r.highVol) };
}

function seriesFromHistorical(h, id) {
  const src = h?.[String(id)] || [];
  const rows = src.map(r => ({
    t: Number(r.timestamp / 1000),
    lo: r.price, hi: r.price,
    lowVol: r.volume ?? 0, highVol: 0
  })).filter(r => r.t && r.lo != null).sort((a, b) => a.t - b.t);
  return { labels: rows.map(r => r.t), low: rows.map(r => r.lo), high: rows.map(r => r.hi), lowVol: rows.map(r => r.lowVol), highVol: rows.map(r => r.highVol) };
}

function getPeriod(v) {
  const p = { "1d": 86400, "5d": 432000, "1m": 2592000, "6m": 15552000, "1y": 31536000, "5y": 157680000 };
  return p[v] || Infinity;
}

function filterSeries(series, period) {
  if (!series || !series.labels.length) return emptySeries();
  const minT = Math.max(...series.labels) - period;
  let startIdx = series.labels.findIndex(t => t >= minT);
  if (startIdx < 0) startIdx = 0;
  return {
    labels: series.labels.slice(startIdx), low: series.low.slice(startIdx), high: series.high.slice(startIdx),
    lowVol: series.lowVol.slice(startIdx), highVol: series.highVol.slice(startIdx)
  };
}

/* Pick which data source feeds a given timeframe. Low-volume items use daily
   history for 1M+ so charts aren't full of gaps from sparse 5m/1h candles. */
/* Pick the data source for a given timeframe. We now prefer the wiki
   timeseries endpoints (which track separate insta-buy and insta-sell
   prints) over weirdgloop's daily-consensus history wherever both exist,
   so the chart shows both gold (buy) and teal (sell) dots instead of a
   single-color scatter on low-volume items. Requires at least 5 points in
   a source before considering it valid; falls back to anything available. */
function seriesForView(v, src, lowVol) {
  const order = {
    '5y': ['hist'],
    '1y': ['ts24h', 'hist'],
    '6m': ['ts24h', 'ts6h', 'hist'],
    '1m': ['ts6h', 'ts24h', 'ts1h', 'hist'],
    '5d': ['ts1h', 'ts5m', 'ts6h', 'ts24h', 'hist'],
    '1d': ['ts5m', 'ts1h', 'ts6h', 'ts24h', 'hist']
  }[v] || ['hist'];
  for (const k of order) {
    const s = src[k];
    if (s && s.labels && s.labels.length >= 5) return s;
  }
  for (const k of order) {
    const s = src[k];
    if (s && s.labels && s.labels.length) return s;
  }
  return src.hist || emptySeries();
}

function pctChange(series, period) {
  const f = filterSeries(series, period);
  let first = null, last = null;
  for (let i = 0; i < f.labels.length; i++) {
    const l = f.low[i], h = f.high[i];
    if (l != null || h != null) { const mid = ((l ?? h) + (h ?? l)) / 2; if (first == null) first = mid; last = mid; }
  }
  if (first == null || last == null || first === 0) return 0;
  return (last - first) / first * 100;
}

function computeAllChanges(src, lowVol) {
  const out = {};
  ['1d', '5d', '1m', '6m', '1y', '5y'].forEach(v => { out[v] = pctChange(seriesForView(v, src, lowVol), getPeriod(v)); });
  return out;
}

async function buildSeriesForItem(id) {
  const [histRaw, t5m, t1h, t6h, t24h] = await Promise.all([
    loadHistorical(id).catch(() => null),
    loadTSCached('5m', id).catch(() => null),
    loadTSCached('1h', id).catch(() => null),
    loadTS('6h', id).catch(() => null),
    loadTS('24h', id).catch(() => null)
  ]);
  const hist = histRaw ? seriesFromHistorical(histRaw, id) : emptySeries();
  fullHistorical = hist;
  return {
    hist,
    ts5m: t5m ? seriesFromTS(t5m) : emptySeries(),
    ts1h: t1h ? seriesFromTS(t1h) : emptySeries(),
    ts6h: t6h ? seriesFromTS(t6h) : emptySeries(),
    ts24h: t24h ? seriesFromTS(t24h) : emptySeries()
  };
}

function ypx(v, vmin, vmax, y0, h) { if (vmin === vmax) return y0 + h / 2; return y0 + (1 - ((v - vmin) / (vmax - vmin))) * h; }

/* Produce human-friendly axis tick values spanning [min, max] with roughly
   `count` divisions. Steps snap to 1 / 2 / 2.5 / 5 × 10^n so prices anchor on
   round numbers (2,600 / 2,700) instead of raw data-derived values. */
function niceTicks(min, max, count) {
  const range = max - min;
  if (!(range > 0)) return [min];
  const rawStep = range / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  /* Snap the step DOWN to the nearest nice base (1 / 2 / 5) so we get MORE
     labels rather than fewer — traders want to read the scale, not decode
     wide gaps. E.g. range 70 gp, target ~14 labels: rawStep ≈ 5, snap-down
     to 5 gives 15 labels at clean 5-gp increments (1600, 1605, 1610, …).
     Skip 2.5× because at mag 1 it rounds to uneven whole-gp jumps
     (288 / 290 / 293 / 295); it only lands nicely at mag ≥ 10 (25, 250, …). */
  let niceNorm;
  if (norm >= 5) niceNorm = 5;
  else if (norm >= 2.5 && mag >= 10) niceNorm = 2.5;
  else if (norm >= 2) niceNorm = 2;
  else niceNorm = 1;
  const step = Math.max(1, niceNorm * mag);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) ticks.push(Math.round(v));
  return ticks;
}

function linearRegression(x, y) {
  const n = x.length; let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) { sumX += x[i]; sumY += y[i]; sumXY += x[i] * y[i]; sumX2 += x[i] * x[i]; }
  const d = (n * sumX2 - sumX * sumX);
  if (d === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / d;
  return { slope, intercept: (sumY - slope * sumX) / n };
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(index), hi = Math.ceil(index), w = index - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

/* Find the most extreme repeated price level in the array. A percentile
   smooths away cluster behaviour (e.g. "4 recent prints at 1,346" gets
   buried below the 75th-percentile boundary), but a flipper looking at the
   chart sees that repeat as proof the price actually trades. This finds
   the highest (or lowest) integer-rounded price that appears ≥ minCount
   times — single-print outliers are filtered out, real clusters surface. */
function findRepeatedExtreme(arr, wantHighest, minCount) {
  const counts = new Map();
  for (const v of arr) {
    const k = Math.round(v);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null;
  for (const [k, c] of counts) {
    if (c < minCount) continue;
    if (best === null || (wantHighest ? k > best : k < best)) best = k;
  }
  return best;
}

/* Volume-weighted wall detection — bucket actual trade volume by price level
   (the volume-profile concept) and return the most extreme price whose
   accumulated volume clears `minVolFraction` of the filtered total. Replaces
   the count-only heuristic for the chart's Sell/Buy wall overlay: a price
   that printed 4 times in heavy volume now beats a price that printed 8
   times in dead volume — that's where actual liquidity sits.
   `priceFilter(p)` lets the caller restrict the search to overhead (above
   current sell) or underfoot (below current buy). Falls back to print-count
   when volume data is entirely missing so old data still gets a sensible
   answer. */
function findVolumeWall(prices, volumes, wantHighest, minVolFraction, priceFilter) {
  if (!prices || !prices.length) return null;
  const byPrice = new Map();
  let totalVol = 0, valid = 0, samplePrice = 0;
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (p == null) continue;
    if (priceFilter && !priceFilter(p)) continue;
    valid++;
    if (!samplePrice) samplePrice = p;
    const v = (volumes && volumes[i]) ? volumes[i] : 0;
    const k = Math.round(p);
    byPrice.set(k, (byPrice.get(k) || 0) + v);
    totalVol += v;
  }
  if (valid < 4) return null;
  if (totalVol <= 0) {
    /* No volume data → revert to print-count style (effectively the old
       findRepeatedExtreme on the filtered subset). */
    const counts = new Map();
    for (let i = 0; i < prices.length; i++) {
      const p = prices[i];
      if (p == null || (priceFilter && !priceFilter(p))) continue;
      const k = Math.round(p);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const minHits = Math.max(4, Math.round(valid * 0.04));
    let best = null;
    for (const [k, c] of counts) {
      if (c < minHits) continue;
      if (best === null || (wantHighest ? k > best : k < best)) best = k;
    }
    return best;
  }
  /* BAND-sum, not per-integer. Earlier version required each individual
     integer price to clear the 5% threshold on its own — so a cluster
     genuinely worth flagging (Diamond on 5D: heavy trading 1820-1840) had
     its volume split across ~20 integers and NO single tick passed, leaving
     the chart wall-less even when the eye plainly saw a ceiling. We now sum
     volume across a small band (±0.2% of price, min ±2 ticks) around each
     candidate, so spread-out clusters register and tight clusters still
     register the same way. The line still anchors to a single integer
     (the most extreme passing one) — same visual, much more reliable. */
  const halfBand = Math.max(2, Math.round(samplePrice * 0.002));
  const minVol = totalVol * minVolFraction;
  let best = null;
  for (const k of byPrice.keys()) {
    let bandVol = 0;
    for (let dk = -halfBand; dk <= halfBand; dk++) bandVol += byPrice.get(k + dk) || 0;
    if (bandVol < minVol) continue;
    if (best === null || (wantHighest ? k > best : k < best)) best = k;
  }
  return best;
}

/* Trade engine — anchor to RECENT prints only (last ~7% of the visible
   window, ~1.5 hours on 1D). Three complementary signals per side:
     1. 20th / 80th percentile of recent insta-sells / insta-buys (was 25/75
        — bumped to a more ambitious slice, but still inside the realised
        order flow so the targets remain fillable).
     2. Cluster detection: lowest / highest integer price with ≥3 prints in
        the recent window. Since the window is tight, a 3-print cluster
        means the level is CURRENTLY trading.
     3. Hard realised extreme of the very-recent slice (last ~3%) — only
        used to nudge the anchor a step toward what just printed at the
        edge, capped by a 0.6% guard rail so a single spike can't run away.
   Trend bias unchanged: if the very-recent mean diverges past the anchor
   (price is currently above your buy anchor or below your sell anchor),
   blend toward the recent mean so a moving market doesn't leave the target
   stale. Then ±1 to undercut / outbid by a tick. */

/* Pick the finest-grain timeseries available for the engine — independent
   of which timeframe is currently being CHARTED. The trade engine is about
   "what should I bid/ask RIGHT NOW", and "now" should mean the last ~hour
   of wall-clock activity regardless of whether the user is looking at the
   1D or 5D view. Previously the engine read the visible series, so on 5D
   the "recent 7%" slice was 8h of 1h candles, dragging targets backwards. */
function pickEngineSeries(src) {
  if (!src) return null;
  for (const k of ['ts5m', 'ts1h', 'ts6h', 'ts24h', 'hist']) {
    const s = src[k];
    if (s && s.labels && s.labels.length >= 8) return s;
  }
  return null;
}

/* ════════════════════════════════════════════════════════════════════════
   FLIP-PRICING ENGINE  —  one code path, EV-optimised, tax-safe.

   A flip target is only good if it BOTH clears a profit after the 2% GE tax
   AND fills often enough to be worth posting, so we maximise the expected
   captured margin  score(price) = P(offer fills) × (margin after tax), and
   pick the pair jointly (each leg's exit/entry is the OTHER leg's real target,
   not a static median). P(fill) is built from the actual recent tape.

   Two halves of the promise, both enforced:
     (1) NEVER recommend a pair that loses money after tax — a hard
         net-of-tax floor gates every emitted target; if nothing inside the
         fillable band clears it, we say so instead of faking a spread.
     (2) NEVER recommend a target that won't realistically fill — reachability
         is judged on the RECENT sub-window, so a stale spike or a pre-crash
         level can't certify an exit that the current market never revisits.
   Between them we still bid the reachable dip / ask the reachable pop to
   capture the patience premium — the point is to MAXIMISE profit, not just
   dodge losses.

   Hardening note: the trend guard keys on DRIFT (level change over the
   window), not on return-volatility — a smooth 4%/hr slide has near-zero
   return-vol yet is exactly the regime where an exit leg gets over-certified
   off stale higher buckets. Against the drift direction the holding-window
   fill bonus is killed (a level in a trend is visited once, never revisited).
   ════════════════════════════════════════════════════════════════════════ */
const ENGINE_CFG = {
  TARGET_TRADES: 2000, MIN_TRADES: 200, MIN_BUCKETS: 8,
  /* MIN_AGE 1h (was 20min): the evidence window is what tells us which price
     levels actually trade. A hyper-liquid item was collapsing to a ~20-min
     window, so a level that prints several times an HOUR looked unreachable
     and targets pinned to the live quote — far too timid vs the real tape. */
  MIN_AGE: 60 * 60, MAX_AGE: 24 * 3600,
  alpha: 0.25, minScale: 1, maxSpreadFrac: 0.34, absCapFrac: 0.05,
  volFloor: 20, volCapW: 200,
  NEFF_MIN: 2, NEFF_MAX: 8,
  ALPHA_LIVE: 0.6, FRESH_SEC: 120, STALE_MIN: 5 * 60, STALE_MAX: 60 * 60,
  kMax: 6, maxFrac: 0.25, pMin: 0.15,
  kSafety: 0.002,
  DRIFT_GATE: 0.006,    // >=0.6% level move over the window ⇒ trend regime
  RECENT_FRAC: 0.34,    // "recent sub-window" = newest third by trade count
  PATIENCE_K: 0.25      // gentle preference for nearer/faster fills (was ~4x harsher)
};
function engMedian(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/* weighted median of records by numeric key `k`, weighted by key `wk` */
function engWMedian(recs, k, wk) {
  const s = recs.filter(r => r[k] > 0).sort((a, b) => a[k] - b[k]);
  if (!s.length) return 0;
  const tot = s.reduce((a, r) => a + r[wk], 0);
  let acc = 0;
  for (const r of s) { acc += r[wk]; if (acc >= tot / 2) return r[k]; }
  return s[s.length - 1][k];
}
function engMinEdge(b) { return Math.max(2, Math.ceil(ENGINE_CFG.kSafety * b)); }

/* Core: given the live /latest node and the finest series, return
   { buy, sell, viable, reason, edge, lowConf }.
   When !viable the (buy,sell) are still the tightest CURRENTLY-FILLABLE pair
   (never a stale-unreachable price) so the box shows honest live-ish numbers
   and the Grade's margin-health gate flags the thin/negative margin — we never
   blank the user out, and we never dress a loser or an unfillable ask green. */
function computeTargets(node, series, itemId) {
  const C = ENGINE_CFG;
  const NO = (reason, buy, sell, lowConf) =>
    ({ buy: buy || 0, sell: sell || 0, viable: false, reason, edge: 0, lowConf: !!lowConf });

  const rawLow  = node && node.low  > 0 ? node.low  : 0;  // insta-sell price = you BUY at
  const rawHigh = node && node.high > 0 ? node.high : 0;  // insta-buy  price = you SELL into
  if (!series || !series.labels || series.labels.length < C.MIN_BUCKETS)
    return NO('insufficient data', rawLow, rawHigh, true);

  const L = series.labels, now = L[L.length - 1];
  if (!(now > 0)) return NO('insufficient data', rawLow, rawHigh, true);

  // dt = typical bucket spacing (adapts to a 5m / 1h / 6h source)
  const gaps = [];
  for (let i = 1; i < L.length; i++) { const g = L[i] - L[i - 1]; if (g > 0) gaps.push(g); }
  const dt = engMedian(gaps) || 300;

  // ---- adaptive, liquidity-sized window (walk newest → oldest) --------------
  // The stop condition counts USABLE (two-sided) buckets, not raw buckets: on
  // 5m data even liquid items print one-sided buckets, and a window that
  // stopped at 8 raw buckets could hold <8 usable ones — a 1M+/day item was
  // reporting "thin data". Keep walking until the stats actually have sample.
  const idx = [];
  let cum = 0, oldest = now, usable = 0;
  for (let i = L.length - 1; i >= 0; i--) {
    const age = now - L[i];
    if (age < 0) continue;
    if (age > C.MAX_AGE) break;
    idx.push(i);
    if (series.low[i] > 0 && series.high[i] > 0) usable++;
    cum += (series.lowVol[i] || 0) + (series.highVol[i] || 0);
    oldest = L[i];
    const span = now - oldest;
    if (cum >= C.TARGET_TRADES && span >= C.MIN_AGE && usable >= C.MIN_BUCKETS) break;
  }
  if (usable < C.MIN_BUCKETS) return NO('insufficient buckets', rawLow, rawHigh, true);
  idx.reverse(); // oldest → newest
  const span = Math.max(dt, now - L[idx[0]]);
  const lowConf = cum < C.MIN_TRADES;
  const halfLife = Math.max(dt, span / 4);

  // ---- robust, winsorised per-bucket records --------------------------------
  const loArr = idx.map(i => series.low[i]).filter(x => x > 0);
  const hiArr = idx.map(i => series.high[i]).filter(x => x > 0);
  if (loArr.length < 4 || hiArr.length < 4) return NO('thin data', rawLow, rawHigh, true);
  const P1lo = percentile(loArr, 1), P99lo = percentile(loArr, 99);
  const P1hi = percentile(hiArr, 1), P99hi = percentile(hiArr, 99);
  const volMed = engMedian(idx.map(i => (series.lowVol[i] || 0) + (series.highVol[i] || 0))) || 1;

  const B = [];
  for (const i of idx) {
    let lo = series.low[i], hi = series.high[i];
    if (!(lo > 0) || !(hi > 0)) continue;
    lo = Math.min(Math.max(lo, P1lo), P99lo);
    hi = Math.min(Math.max(hi, P1hi), P99hi);
    if (hi < lo) { const t = lo; lo = hi; hi = t; }
    const mid = (lo + hi) / 2, spread = Math.max(0, hi - lo);
    const age = now - L[i];
    const decay = Math.pow(0.5, age / halfLife);
    /* Reach weights use a much flatter decay (half-life = whole window): for
       "does this level trade?" an hour-old print in a FLAT market is nearly as
       good evidence as a fresh one. The steep level-decay stays for anchors. */
    const decayReach = Math.pow(0.5, age / span);
    const volL = Math.min(series.lowVol[i] || 1, 5 * volMed);
    const volH = Math.min(series.highVol[i] || 1, 5 * volMed);
    const wL = decay * Math.sqrt(Math.min(volL, C.volCapW));
    const wH = decay * Math.sqrt(Math.min(volH, C.volCapW));
    /* Endangered-regime evidence decays per BUCKET (half-life = one bucket):
       in a moving market each print supersedes the last, so a 15-min-old
       crash bucket must not certify an ask the newest prints already left. */
    const decayFresh = Math.pow(0.5, age / dt);
    B.push({
      i, age, lo, hi, mid, spread, wL, wH,
      wFreshL: decayFresh * Math.sqrt(Math.min(volL, C.volCapW)),
      wFreshH: decayFresh * Math.sqrt(Math.min(volH, C.volCapW)),
      wM: wL + wH, // drift/level medians must see BOTH sides — a crash printing
                   // thin on the low side is invisible to a wL-only median
      /* Reach votes answer "does this level recur?", not "how big was the one
         print?" — cap the volume at 1x median so a single whale bucket can't
         out-shout hours of subsequent tape. */
      wReachL: decayReach * Math.sqrt(Math.min(volL, volMed, C.volCapW)),
      wReachH: decayReach * Math.sqrt(Math.min(volH, volMed, C.volCapW)),
      volL, volH,
      recent: age <= Math.max(halfLife, 3 * dt), // corroboration tail
      fresh: age <= 3 * dt                       // strict regime tail (endangered evidence)
    });
  }
  if (B.length < C.MIN_BUCKETS) return NO('thin data', rawLow, rawHigh, true);

  const refMid = engWMedian(B, 'mid', 'wM');
  const relSpread = engWMedian(B.map(b => ({ v: b.spread / b.mid, w: b.wL + b.wH })), 'v', 'w');

  // realized step-vol (MAD of log-returns), gap-skipped
  const rets = [];
  for (let k = 1; k < B.length; k++) {
    if (L[B[k].i] - L[B[k - 1].i] <= 2 * dt && B[k].mid > 0 && B[k - 1].mid > 0)
      rets.push(Math.log(B[k].mid / B[k - 1].mid));
  }
  const medR = engMedian(rets);
  let sigma = rets.length ? 1.4826 * engMedian(rets.map(r => Math.abs(r - medR))) : 0;
  sigma = Math.max(sigma, 0.5 * (relSpread || 0), 1 / Math.max(1, refMid));

  // ---- DRIFT (level change), independent of sigma — the hardening core ------
  const recentB = B.filter(b => b.recent);
  const freshB = B.filter(b => b.fresh);
  const third = Math.max(1, Math.round(B.length * C.RECENT_FRAC));
  const midNew = engWMedian(B.slice(B.length - third), 'mid', 'wM');
  const midOld = engWMedian(B.slice(0, third), 'mid', 'wM');
  /* Two drift signals, because each is blind somewhere:
     - thirds drift misses any move confined to the newest third (flash crash)
       or a mid-window hump, and its centers sit only ~0.7 spans apart, so the
       measured value understates the true per-window move — gate at 0.7x;
     - tail drift (corroboration tail vs whole-window median) catches moves the
       thirds can't see; it is a ~half-window signal, so it counts doubled. */
  const driftFrac = refMid > 0 ? (midNew - midOld) / refMid : 0; // >0 rising, <0 falling
  const midTail = recentB.length ? engWMedian(recentB, 'mid', 'wM') : refMid;
  const driftTail = refMid > 0 ? (midTail - refMid) / refMid : 0;
  /* A fresh live quote breaching the window band on BOTH sides in the same
     direction is not a fat finger — it is the regime moving. Treat it as
     endangerment evidence (and keep trusting the quote, see blend below). */
  const bothBreachDown = rawLow > 0 && rawHigh > 0 && rawLow < P1lo && rawHigh < P1hi;
  const bothBreachUp   = rawLow > 0 && rawHigh > 0 && rawLow > P99lo && rawHigh > P99hi;

  /* Per-side endangerment: a trend only invalidates evidence for the side it
     is moving AWAY from (falling market ⇒ old highs won't recur; rising ⇒ old
     lows won't). That side gets the strict fresh-tail gate + no holding-window
     bonus. The other side — and BOTH sides in a flat market — may use the whole
     window as reachability evidence, which is what lets us bid the recurring
     dip and ask the recurring pop instead of pinning to the live quote. */
  const sellEndangered = driftFrac <= -C.DRIFT_GATE * 0.7 || 2 * driftTail <= -C.DRIFT_GATE || bothBreachDown;
  const buyEndangered  = driftFrac >=  C.DRIFT_GATE * 0.7 || 2 * driftTail >=  C.DRIFT_GATE || bothBreachUp;
  // effective drift for the entry-trap penalty: the strongest signal we saw
  const effDrift = Math.abs(driftFrac / 0.7) >= Math.abs(2 * driftTail) ? driftFrac / 0.7 : 2 * driftTail;

  // Neff (bounded holding-window revisits). Against the drift direction the
  // price does NOT revisit a level, so kill the holding-window bonus there.
  let NeffBuy = Math.min(C.NEFF_MAX, Math.max(C.NEFF_MIN, Math.round((span / dt) / 3)));
  let NeffSell = NeffBuy;
  if (sellEndangered) NeffSell = 1;
  if (buyEndangered) NeffBuy = 1;

  // ---- deblur + soft touch prob + holding-window P(fill) ---------------------
  // Deblur to an inferred intra-bucket extreme using ONLY the per-bucket spread
  // (conservative — over-deblur is the one failure the directive forbids, so we
  // bias the scale DOWN). Capped to 1/3 spread and 5% of price, shrunk for thin
  // buckets so a 1-print bucket can't assert a deep reachable low.
  function deblur(b, side) {
    const g = b.spread;
    let sc = Math.max(C.alpha * g, C.minScale);
    const cap = Math.min(g > 0 ? C.maxSpreadFrac * g : Infinity, C.absCapFrac * b.mid);
    sc = Math.min(sc, cap);
    const volSide = side === 'buy' ? b.volL : b.volH;
    sc *= Math.min(1, volSide / C.volFloor);
    return Math.max(0, sc);
  }
  /* Soft per-bucket touch fraction. Gating is PER SIDE by regime: the
     endangered side (trend moving away from it) sees only the strict FRESH
     tail (last ~3 buckets) with steep decay — a pre-crash level can't certify
     it. A safe side sees the whole window with the flat reach decay, so a
     level that trades a few times an hour in a flat market is reachable. */
  function qTouch(c, side) {
    const endangered = side === 'buy' ? buyEndangered : sellEndangered;
    let acc = 0, W = 0;
    for (const b of B) {
      if (endangered && !b.fresh) continue;
      const sc = deblur(b, side);
      const w = endangered ? (side === 'buy' ? b.wFreshL : b.wFreshH)
                           : (side === 'buy' ? b.wReachL : b.wReachH);
      let f;
      if (side === 'buy') { const p = b.lo, ext = p - sc; f = c >= p ? 1 : (c <= ext ? 0 : (c - ext) / (p - ext)); }
      else { const p = b.hi, ext = p + sc; f = c <= p ? 1 : (c >= ext ? 0 : (ext - c) / (ext - p)); }
      acc += w * f; W += w;
    }
    return W > 0 ? acc / W : 0;
  }
  /* Distinct touch EPISODES (runs of consecutive touching buckets). The
     holding-window bonus 1-(1-q)^N assumes the level is REVISITED; a single
     contiguous dead cluster is one visit, not N chances. A periodic level
     (touched every few buckets) keeps its full N. */
  function touchEpisodes(c, side) {
    let eps = 0, inTouch = false;
    for (const b of B) { // oldest → newest
      const sc = deblur(b, side);
      const t = side === 'buy' ? (c >= b.lo - sc) : (c <= b.hi + sc);
      if (t && !inTouch) eps++;
      inTouch = t;
    }
    return eps;
  }
  const Pfill = (c, side) => {
    const base = side === 'buy' ? NeffBuy : NeffSell;
    const n = Math.max(1, Math.min(base, touchEpisodes(c, side)));
    return 1 - Math.pow(1 - qTouch(c, side), n);
  };
  /* Recent-tail corroboration, in ALL regimes: a level only counts as fillable
     if the tail still touches it (within deblur). A genuinely recurring
     dip/pop keeps printing in the tail by definition — ambition is preserved —
     but an 8h-dead whale wall, a pulled buy wall, or a one-off cluster whose
     flow vanished can no longer certify an ask the live market never visits. */
  function tailTouches(c, side) {
    for (const b of B) {
      if (!b.recent) continue;
      const sc = deblur(b, side);
      if (side === 'buy' ? (c >= b.lo - sc) : (c <= b.hi + sc)) return true;
    }
    return false;
  }
  const reachable = (c, side) => qTouch(c, side) >= C.pMin && tailTouches(c, side);

  // ---- live-anchor blend (staleness trust + slew cap) -----------------------
  const tradesPerMin = cum / Math.max(1, span / 60);
  function trust(ageSec) {
    if (!(ageSec >= 0)) return 0.5; // unknown timestamp → blend half
    const gap = 60 / Math.max(1e-6, tradesPerMin);
    const A = Math.min(C.STALE_MAX, Math.max(C.STALE_MIN, 10 * gap));
    let t = Math.max(0, Math.min(1, 1 - ageSec / A));
    if (ageSec < C.FRESH_SEC) t = Math.max(t, 0.5);
    return t;
  }
  const distBuy = engWMedian(B, 'lo', 'wL');
  const distSell = engWMedian(B, 'hi', 'wH');
  const delta = Math.max(Math.round(0.003 * refMid), Math.round(sigma * refMid * 0.75));
  function blend(dist, live, ageSec, p1, p99) {
    if (!(live > 0)) return { price: Math.round(dist), t: 0 };
    let t = trust(ageSec);
    /* Fat-finger guard — but NOT when both live legs breach the band in the
       same direction: that is the regime moving, and the live quote is then
       the only honest anchor (a crash pins fresh quotes below P1 precisely
       when trusting them matters most). */
    if ((live < p1 || live > p99) && !(bothBreachDown || bothBreachUp)) t = 0;
    const clamped = Math.max(dist - delta, Math.min(dist + delta, live));
    const a = C.ALPHA_LIVE * t;
    return { price: Math.round((1 - a) * dist + a * clamped), t };
  }
  const ageLow  = node && node.lowTime  > 0 ? now - node.lowTime  : -1;
  const ageHigh = node && node.highTime > 0 ? now - node.highTime : -1;
  const aBuy  = blend(distBuy,  rawLow,  ageLow,  P1lo, P99lo);
  const aSell = blend(distSell, rawHigh, ageHigh, P1hi, P99hi);

  // ---- volatility-scaled edge candidates around the live anchor -------------
  const sAbs = sigma * ((aBuy.price + aSell.price) / 2);
  const eMax = Math.max(1, Math.min(C.kMax * sAbs, C.maxFrac * aBuy.price));
  const step = Math.max(1, Math.round(eMax / 40));
  /* Never bid ABOVE the fresh live insta-sell: sellers are demonstrably
     accepting rawLow right now, so a standing bid above it just becomes the
     price the next impatient seller hits — pure overpay (this is how a crash
     tape produced a bid 26 gp above the live market). Ambition means bidding
     BELOW the market, never above it. Only enforced when the quote is trusted. */
  const buyCapLive = (rawLow > 0 && aBuy.t >= 0.5) ? rawLow : Infinity;
  const buyCands = [], sellCands = [];
  for (let e = 0; e <= eMax; e += step) {
    const bb = Math.round(aBuy.price - e); if (bb >= 1 && bb <= buyCapLive) buyCands.push(bb);
    sellCands.push(Math.round(aSell.price + e));
  }
  // fillable band from the same per-side evidence set as reachability: strict
  // fresh tail for an endangered side (can't widen into a stale spike),
  // whole winsorized window for a safe side (recurring levels are fair game)
  const loEvid = ((buyEndangered ? freshB : B).length ? (buyEndangered ? freshB : B) : B).map(b => b.lo);
  const hiEvid = ((sellEndangered ? freshB : B).length ? (sellEndangered ? freshB : B) : B).map(b => b.hi);
  const buyFloor = Math.min(rawLow > 0 ? rawLow : Infinity, percentile(loEvid.length ? loEvid : loArr, 2));
  const sellCap  = Math.max(rawHigh > 0 ? rawHigh : 0, percentile(hiEvid.length ? hiEvid : hiArr, 98));

  // an "easy" fill the drift is FEEDING is a trap (buy into a crash / sell into a
  // spike you can't repeat) — discount that leg so the optimizer can't reward it.
  const strongDrift = Math.abs(effDrift) >= 3 * C.DRIFT_GATE;
  function score(side, c, otherTarget) {
    if (!reachable(c, side)) return -1;                 // recency gate
    const p0 = Pfill(c, side);
    if (p0 < C.pMin) return -1;
    const margin = side === 'buy' ? netKept(c, otherTarget, itemId) : netKept(otherTarget, c, itemId);
    if (margin <= 0) return -1;
    let p = p0;
    if (strongDrift) {
      if (side === 'buy'  && effDrift < 0) p *= 0.5;
      if (side === 'sell' && effDrift > 0) p *= 0.5;
    }
    const eB = aBuy.price - (side === 'buy' ? c : otherTarget);
    const eS = (side === 'sell' ? c : otherTarget) - aSell.price;
    /* Gentle patience preference. The old form (1 + eB/σ + eS/σ) divided a
       2-sigma-wide pair's EV by ~5, crushing exactly the patient dip-bid /
       pop-ask pairs that pay the 2% tax — the engine ended up quoting the
       live spread. P(fill) already discounts distance; this is a tiebreaker. */
    const patience = 1 + C.PATIENCE_K * (Math.max(0, eB) + Math.max(0, eS)) / Math.max(1, sAbs);
    return p * margin / patience;
  }
  function argmax(cands, side, other) {
    /* bs starts at 0, not -Infinity: score() returns the -1 sentinel for any
       candidate that is unreachable in the recent tape or tax-negative, and
       strictly > 0 for a real one. Starting at 0 means when EVERY candidate is
       a sentinel we return null (→ NO_TRADE / widen), instead of certifying an
       arbitrary profitable-but-unreachable pair as viable. */
    let best = null, bs = 0;
    for (const c of cands) { const sc = score(side, c, other); if (sc > bs) { bs = sc; best = c; } }
    return best;
  }

  // ---- coupled 2-sweep fixed point ------------------------------------------
  let s = Math.round(Math.min(Math.max(distSell, aSell.price), sellCap));
  let b = argmax(buyCands, 'buy', s); if (b != null) s = argmax(sellCands, 'sell', b) ?? s;
  if (b != null) { b = argmax(buyCands, 'buy', s) ?? b; s = argmax(sellCands, 'sell', b) ?? s; }
  /* A seed that never passed an argmax sweep was never validated by the fill
     model — it must not slip through the money gate as a "viable" target
     (that's how a stale anchor above the fresh tape leaked out as a sell). */
  if (s != null && !reachable(s, 'sell')) s = null;
  if (b != null && (!reachable(b, 'buy') || b > buyCapLive)) b = null;

  // ---- money floor / safety rails -------------------------------------------
  const edgeReq = lowConf
    ? Math.max(engMinEdge(b || rawLow), Math.ceil(2 * C.kSafety * (b || rawLow)))
    : engMinEdge(b || rawLow);

  if (b != null && s != null && netKept(b, s, itemId) >= edgeReq) {
    // gated queue-jump — a mutation may never cross the guarantee
    if (netKept(b, s - 1, itemId) >= edgeReq && reachable(s - 1, 'sell')) s -= 1;
    return { buy: b, sell: s, viable: true, reason: '', edge: netKept(b, s, itemId), lowConf };
  }

  // widen minimally, staying inside the RECENT fillable band + recency gate
  if (b == null) b = Math.max(1, Math.min(Math.round(aBuy.price), buyCapLive));
  if (s == null) s = Math.round(aSell.price);
  /* Pull the sell seed down into validated territory before the money gate:
     an anchor stranded above the fresh tape must not pass as-is. Selling AT
     the live insta-buy is definitionally fillable, so stop there. */
  let seedGuard = 0;
  while (s > (rawHigh || 1) && !reachable(s, 'sell') && ++seedGuard < 20000) s--;
  if (rawHigh > 0 && s < rawHigh) s = rawHigh;
  let guard = 0;
  while (netKept(b, s, itemId) < edgeReq) {
    const canLower = (b - 1) >= buyFloor && (b - 1) >= 1 && reachable(b - 1, 'buy');
    const canRaise = (s + 1) <= sellCap && reachable(s + 1, 'sell');
    if (canLower && (!canRaise || qTouch(b - 1, 'buy') >= qTouch(s + 1, 'sell'))) b -= 1;
    else if (canRaise) s += 1;
    else break; // can't reach a tax-clearing pair without leaving the fillable band
    if (++guard > 20000) break;
  }
  if (netKept(b, s, itemId) >= edgeReq)
    return { buy: b, sell: s, viable: true, reason: '', edge: netKept(b, s, itemId), lowConf };

  // No clean flip. Return the tightest CURRENTLY-FILLABLE honest pair (never a
  // stale-unreachable price); the Grade surfaces the thin/negative margin.
  const honestBuy = Math.min(Math.round(aBuy.price), buyCapLive);
  let honestSell = Math.max(Math.round(aSell.price), rawHigh || 0);
  if (aSell.t < 0.5) honestSell = Math.round(aSell.price); // don't pin to a stale live spike
  else if (sellEndangered && rawHigh > 0) honestSell = rawHigh; // falling market: live is the honest ask
  return NO('spread does not clear ' + feeLabelFor(itemId) + ' right now', honestBuy, honestSell, lowConf);
}

/* Back-compat entry point. Existing callers pass (rawLow, rawHigh, series);
   the newer ones also pass the live /latest node (for freshness timestamps)
   and the item id (for tax exemption). Always returns
   { buy, sell, viable, reason, edge, lowConf }. */
function runTradeEngine(rawLow, rawHigh, series, node, id) {
  const n = node ? Object.assign({}, node) : { low: rawLow, high: rawHigh };
  if (n.low == null) n.low = rawLow;
  if (n.high == null) n.high = rawHigh;
  if (!n.low || !n.high)
    return { buy: n.low || 0, sell: n.high || 0, viable: false, reason: 'no live quote', edge: 0, lowConf: true };
  return computeTargets(n, series, id);
}

/* ── Timeframe-aware targets: day trade vs swing trade ───────────────────
   1D = the live day-flip engine (fill prices for a same-day flip; when the
   spread is dead both targets legitimately converge on the live quote).
   5D and longer chart timeframes switch to SWING anchors from THAT window's
   realized prints: a patient bid near the window's floor (10th percentile
   of lows) and an ask near its ceiling (90th percentile of highs) —
   percentiles, not min/max, so one freak spike can't set the target. The
   chart timeframe IS the trade horizon: targets, grades, and the profit
   calc all answer for the horizon on screen. */
function computeSwingTargets(series) {
  if (!series || !series.labels || !series.labels.length) return null;
  /* RECENCY-WEIGHTED percentiles. A flat percentile over the whole window
     was too ambitious on trending items: in a month-long downtrend the
     90th-percentile high comes from the start of the slide — a level the
     market has left behind — so the swing ask never fills. Weight each
     print by age (half-life = a third of the window) so last week's highs
     dominate months-old ones. Rangebound items are barely affected;
     trending ones pull the anchor toward levels the price still visits. */
  const lows = [], highs = [];
  let tLast = -Infinity, tFirst = Infinity;
  for (let i = 0; i < series.labels.length; i++) {
    const t = series.labels[i], L = series.low[i], H = series.high[i];
    if (L != null && L > 0) lows.push({ v: L, t });
    if (H != null && H > 0) highs.push({ v: H, t });
    if (L != null || H != null) { if (t > tLast) tLast = t; if (t < tFirst) tFirst = t; }
  }
  if (lows.length < 8 || highs.length < 8 || !(tLast > tFirst)) return null;
  const halfLife = (tLast - tFirst) / 3;
  for (const e of lows)  e.w = Math.pow(0.5, (tLast - e.t) / halfLife);
  for (const e of highs) e.w = Math.pow(0.5, (tLast - e.t) / halfLife);
  lows.sort((a, b) => a.v - b.v); highs.sort((a, b) => a.v - b.v);
  const wpct = (arr, p) => {
    const total = arr.reduce((s, e) => s + e.w, 0);
    let acc = 0;
    for (const e of arr) { acc += e.w; if (acc >= p * total) return e.v; }
    return arr[arr.length - 1].v;
  };
  const buy = Math.round(wpct(lows, 0.12));
  const sell = Math.round(wpct(highs, 0.88));
  return sell > buy ? { buy, sell } : null;
}
/* Direction of the selected window, as a fraction: median of the last fifth
   of the prints against the median of the first fifth. Medians, not endpoints,
   so a single spike at either edge can't declare a trend. */
function swingTrendPct(series) {
  if (!series || !series.labels || series.labels.length < 10) return 0;
  const mid = [];
  for (let i = 0; i < series.labels.length; i++) {
    const L = series.low[i], H = series.high[i];
    if (L != null && H != null) mid.push((L + H) / 2);
    else if (L != null) mid.push(L);
    else if (H != null) mid.push(H);
  }
  if (mid.length < 10) return 0;
  const n = Math.max(3, Math.round(mid.length * 0.2));
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const first = med(mid.slice(0, n)), last = med(mid.slice(-n));
  return first > 0 ? (last - first) / first : 0;
}
/* How much default edge a swing ask may claim over the live price before it
   stops looking executable. Only bites on higher-value items: a 300gp herb
   genuinely swings 40% in a month, a 60M item does not, and quoting one like
   the other is what produced a 100M+ ask on a 60M Virtus. */
function defaultSwingEdgeCap(price) {
  if (!(price > 0)) return Infinity;
  if (price >= 1e6) return 0.15;
  if (price >= 1e5) return 0.25;
  return Infinity;
}
/* Ceiling for the swing ask on long windows.
   The monotonic-horizon rule takes the MAX ask across every window up to the
   one selected. That is right for execution logic — more patience can always
   run the shorter plan — but on a year-long slide the 1Y window's own anchor
   comes from the top of the slide, a level the market has left behind, and the
   max locks it in. The result is an ask no experienced flipper would place.
   So the ask is bounded by whichever is HIGHER of:
     - local resistance: the ~30-day window's own recency-weighted ask, i.e.
       where sellers have actually been filling lately, and
     - a percentage cap over the live price (see defaultSwingEdgeCap).
   Local structure wins when it is genuinely higher, which is how a real
   breakout still gets an ambitious target. The ceiling never drops below the
   live market or the day-flip engine, so this can only ever pull an ask DOWN
   toward reality, never below where buyers are paying.
   Deliberately computed from the 1M window rather than the selected one, so
   the ceiling is the same number on 6M as on 1Y — a view-dependent ceiling
   would let a longer horizon quote WORSE than a shorter one and break the
   monotonic rule this sits inside. Defaults only: the -/+ buttons write
   recommendedSell directly and are not clamped by any of this. */
function swingSellCeiling(engineSell) {
  const recent = computeSwingTargets(filterSeries(seriesForView('1m', currentItemSrc, currentItemLowVol), getPeriod('1m')));
  const local = recent ? recent.sell : 0;
  const ref = liveSellRaw > 0 ? liveSellRaw : (liveBuyRaw > 0 ? liveBuyRaw : 0);
  let cap = defaultSwingEdgeCap(ref);
  /* Clearly trending up — a more ambitious default is fair, the market is
     still making new levels rather than leaving old ones behind. */
  if (isFinite(cap) && swingTrendPct(currentSeries) >= 0.03) cap *= 2;
  const pctCeil = (ref > 0 && isFinite(cap)) ? Math.round(ref * (1 + cap)) : Infinity;
  return Math.max(local, pctCeil, engineSell > 0 ? engineSell : 0, liveSellRaw > 0 ? liveSellRaw : 0);
}
/* Two sanity clamps every recommended pair obeys: never ASK below what
   buyers pay right now (live insta-buy), never BID above what sellers
   accept right now (live insta-sell). */
function clampToLive(t) {
  if (!t) return t;
  const out = { buy: t.buy, sell: t.sell };
  if (liveSellRaw > 0) out.sell = Math.max(out.sell, liveSellRaw);
  if (liveBuyRaw > 0) out.buy = Math.min(out.buy, liveBuyRaw);
  return out.sell > out.buy ? out : t;
}
/* One entry point every target-render site uses: engine on 1D, swing
   anchors on longer views (engine as fallback when the window is too
   sparse to trust percentiles). */
function computeViewTargets(node, id) {
  const engine = runTradeEngine(liveBuyRaw, liveSellRaw, pickEngineSeries(currentItemSrc) || currentSeries, node, id);
  if (view === '1d') {
    /* Dead live spread: the engine converges both targets on the live
       quote ("buy 1,640 / sell 1,640") — useless. If the DAY's prints
       still show a real range (insta-buys spiking 1,690 all day while
       live sits 1,640), anchor the boxes to the day's recency-weighted
       dip/peak instead, so they show the levels worth waiting for. Only
       when that day-pair actually beats the tax; else keep the engine's
       honest no-margin pair. */
    const tax = calculateTax(engine.sell, id);
    if (engine.sell - engine.buy - tax <= 0) {
      const day = clampToLive(computeSwingTargets(currentSeries));
      if (day && day.sell - day.buy - calculateTax(day.sell, id) > 0) return day;
    }
    return engine;
  }
  /* MONOTONIC HORIZON RULE: a longer horizon can always execute the
     shorter plan, so more patience must never quote a WORSE level — the
     5D ask can't sit below the 1D ask just because each window ran its
     percentile independently. Take the best anchor across every window
     from 1D up to the selected view (Swing Sell = max, Swing Buy = min),
     then clamp to live. */
  const VIEW_CHAIN = ['1d', '5d', '1m', '6m', '1y', '5y'];
  let best = null;
  for (let i = 0; i <= VIEW_CHAIN.indexOf(view); i++) {
    const w = VIEW_CHAIN[i];
    const s = (w === view) ? currentSeries : filterSeries(seriesForView(w, currentItemSrc, currentItemLowVol), getPeriod(w));
    const t = computeSwingTargets(s);
    if (!t) continue;
    if (!best) best = { buy: t.buy, sell: t.sell };
    else { best.buy = Math.min(best.buy, t.buy); best.sell = Math.max(best.sell, t.sell); }
  }
  if (best) {
    /* Fold in the day-flip engine pair too, so the swing boxes never
       quote a worse level than what the 1D boxes would display. */
    if (engine.sell > 0) best.sell = Math.max(best.sell, engine.sell);
    if (engine.buy > 0) best.buy = Math.min(best.buy, engine.buy);
    /* ...then pull the ask back to something placeable. The bid needs no
       equivalent: bidding LOW is always executable, it just may not fill, so
       there is no realism problem to fix on that side. */
    best.sell = Math.min(best.sell, swingSellCeiling(engine.sell));
  }
  best = clampToLive(best);
  return (best && best.sell > best.buy) ? best : engine;
}
/* Shared renderer for the two target boxes — labels say what the number
   IS for the active horizon ("Target Buy" on 1D, "Swing Buy · 1M" beyond). */
/* Guarantee the target price fits its box.
   pvFit() inside renderTargetBoxes picks a size tier from the string length,
   which is all the information available while building the HTML and is
   enough almost everywhere. It is not enough on a 390px phone, where a
   13-digit price still overflowed at the smallest tier — a character count
   cannot know how wide the box actually is.
   So measure, and step down until it fits. Cheap (two elements, a handful of
   half-pixel steps, and only when the number is long enough to overflow in
   the first place), self-correcting on rotation and resize, and it cannot
   clip by construction rather than by my having picked the right constants. */
/* Minimum width the caption needs to say something useful.
   Was 148 — the width at which nothing is truncated at all — which made the box
   stack the moment the caption lost its "· 1m ago" suffix, even in a 340px box
   with room to spare. That trades a whole row of height for a timestamp. The
   caption ellipsises perfectly well; the number does not shrink either way.
   96px still shows "Insta-sell: 1,999" — the label and the figure, which is the
   part that matters — so stacking is reserved for boxes that genuinely cannot
   fit a caption beside the number. */
const PRICE_CAPTION_MIN_W = 96;
function fitPriceNums() {
  /* Decide the LAYOUT first, and always measure from the un-stacked state, so
     the answer depends only on width and content — never on what the box
     happened to be doing a moment ago. Deciding from the current state would
     let it oscillate: stacking makes the caption fit, which then argues for
     un-stacking, which crushes it again. */
  document.querySelectorAll('.price-box').forEach(box => {
    box.classList.remove('is-stacked');
  });
  /* Matches the media guard on .price-box.is-stacked. Kept in sync here too so
     the class is never applied where it has no styles — a stacked class with no
     rules is invisible in the DOM inspector and reads as a mystery. */
  /* Phone portrait hides the steppers, so an extra row buys nothing there.
     Phone LANDSCAPE is excluded for the opposite reason: it has the steppers,
     but it is pinned to 100dvh with the chart already the tightest thing on
     screen, so a second row in each target box is the most expensive 20px on
     the page. That layout would rather truncate the caption — which is exactly
     what it does without the class. */
  const canStack = !window.matchMedia('(max-width: 640px)').matches
    && !window.matchMedia('(max-height: 600px) and (orientation: landscape) and (pointer: coarse)').matches;
  document.querySelectorAll('.price-box').forEach(box => {
    if (!canStack) return;
    const lab = box.querySelector('.price-label');
    const val = box.querySelector('.price-val');
    if (!lab || !val) return;
    const lr = lab.getBoundingClientRect(), vr = val.getBoundingClientRect();
    /* Only bands that put the caption and the number on ONE row have this
       problem; where they already stack, there is nothing to fix.
       Tested by HORIZONTAL adjacency, not by comparing tops. The inline bands
       centre both items vertically, so a caption wrapped to three lines beside
       a one-line number has tops ~20px apart and a top-comparison calls it
       "already stacked" — which is exactly the worst-crushed case, and it got
       skipped. If the number starts at or after the caption's right edge, they
       are side by side, whatever their tops say. */
    if (vr.left < lr.right - 2) return;
    const cs = getComputedStyle(box);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const gap = (parseFloat(cs.columnGap) || parseFloat(cs.gap) || 0);
    /* scrollWidth, not the rendered width: the number may already have been
       squeezed, and what matters is the room it actually wants. */
    const wantsForCaption = box.clientWidth - padX - gap - val.scrollWidth;
    if (wantsForCaption < PRICE_CAPTION_MIN_W) box.classList.add('is-stacked');
  });
  /* Then shrink the numeral if it still overflows — the stack may have given
     it more room, so this has to run after the layout is settled. */
  document.querySelectorAll('.price-val .pv-num').forEach(el => {
    el.style.fontSize = '';                       // back to the class tier
    let size = parseFloat(getComputedStyle(el).fontSize) || 0;
    let guard = 0;
    while (size > 9 && el.scrollWidth > el.clientWidth + 1 && guard++ < 24) {
      size -= 0.5;
      el.style.fontSize = size + 'px';
    }
  });
}

function renderTargetBoxes() {
  const swing = view !== '1d';
  const tf = view.toUpperCase();
  const buyLbl = swing ? `Swing Buy · ${tf}` : 'Target Buy';
  const sellLbl = swing ? `Swing Sell · ${tf}` : 'Target Sell';
  /* Nudge the price gp-by-gp without opening the Potential Profit breakdown.
     One button either side of the numeral rather than a stacked pair in the
     corner — see .price-step. */
  const step = (side, dir) => {
    const verb = dir > 0 ? 'Increase' : 'Decrease';
    const tip = `${verb} ${side} price by 1 gp\nShift +${'\u00A0'}click: 10 gp\nCtrl / Cmd + click: 100 gp`;
    return `<button type="button" class="price-step" data-side="${side}" data-dir="${dir}" title="${tip}" aria-label="${verb} ${side} price by 1 gp. Hold shift for 10, control for 100.">${dir > 0 ? '+' : '\u2212'}</button>`;
  };
  /* "· Xm ago" next to the live price — the reassurance a manual refresh
     button would've given ("is this actually current?"), without a control
     that implies you have to press it to get fresh data. Ticked live by
     tickLiveAge() rather than re-rendered, so it stays cheap. */
  /* Step the target number down when it is long enough to overflow its box.
     A Scythe of vitur trades around 1,181,199,999 — thirteen characters — and
     the box rendered it as "1,18" on a phone and "1,181,19" on desktop,
     clipped mid-number by the ellipsis. A price cut off partway through is
     worse than a small one: it looks like a complete number and it is wrong.

     Deliberately NOT abbreviated to "1.18B". This is the price you type into
     the Grand Exchange, and rounding it to three significant figures would be
     off by up to a million gp. The digits stay; the type gets smaller.

     Sized in em, on the inner span, on purpose: .price-val sets an explicit
     px size in SIX different breakpoints, so any px value here would be right
     in one layout and wrong in five. em on the child resolves against
     whichever of those actually applied. */
  const pvFit = (str) => {
    const n = String(str).length;
    return n >= 14 ? 'pv-xs' : n >= 11 ? 'pv-sm' : n >= 8 ? 'pv-md' : '';
  };
  /* "Live:" alone never said WHICH live price. Under Target Buy it's
     liveBuyRaw = node.low, the Insta-sell; under Target Sell it's node.high,
     the Insta-buy. These two captions are now the ONLY place the live pair is
     printed — the quick-facts strip below the chart used to repeat both, with
     a different age beside each, which is how the disagreement showed up.
     The age is the print's own timestamp, so "3m ago" means the trade
     happened three minutes ago, NOT that we polled three minutes ago. Coloured
     with the same fresh/ok/stale scale the strip used, so the signal survived
     the move. */
  const ageSpan = (t, side) => `<span class="live-age ${ageClass(t)}" data-live-age="${side}">${t ? ' · ' + fmtAge(t) : ''}</span>`;
  $("#buyPrice").innerHTML = `<div class="price-label"><span class="pl-t">${buyLbl}</span> <span class="live-val">Insta-sell: ${fmtGp(liveBuyRaw)}${ageSpan(liveBuyTime, 'buy')}</span></div><div class="price-val">${step('buy', -1)}<span class="pv-num ${pvFit(fmtGp(recommendedBuy))}">${fmtGp(recommendedBuy)}</span>${step('buy', 1)}</div>`;
  $("#sellPrice").innerHTML = `<div class="price-label"><span class="pl-t">${sellLbl}</span> <span class="live-val">Insta-buy: ${fmtGp(liveSellRaw)}${ageSpan(liveSellTime, 'sell')}</span></div><div class="price-val">${step('sell', -1)}<span class="pv-num ${pvFit(fmtGp(recommendedSell))}">${fmtGp(recommendedSell)}</span>${step('sell', 1)}</div>`;
  wireTargetPriceSteppers();
  fitPriceNums();
  /* Re-sync the flip card's Buy @ / Sell @ highlight: it only lights while the
     card's item is the one on the chart, and that can change under it (opening
     the card's item, or ↻ Next landing on the one already shown) without any
     click to trigger the update. */
  updateSelection();
}
/* Keeps the "· Xm ago" labels above current without a full re-render (which
   would also re-wire the stepper buttons every tick for no reason). */
function tickLiveAge() {
  document.querySelectorAll('[data-live-age]').forEach(el => {
    const t = el.dataset.liveAge === 'sell' ? liveSellTime : liveBuyTime;
    el.textContent = t ? ' · ' + fmtAge(t) : '';
    el.className = 'live-age ' + ageClass(t);
  });
}
/* Nudging the box updates the actual recommendedBuy/Sell — the same
   variables the chart's dashed target line and the Potential Profit calc
   read — so both move with it instead of just the box's own text changing. */
/* Modifier keys scale the nudge, so walking a target 100 gp doesn't mean a
   hundred clicks. Ctrl is checked before Shift because Ctrl+Shift should
   land on the larger of the two rather than depending on rule order. metaKey
   covers Cmd on macOS. */
function priceStepMultiplier(ev) {
  if (!ev) return 1;
  if (ev.ctrlKey || ev.metaKey) return 100;
  if (ev.shiftKey) return 10;
  return 1;
}
function adjustTargetPrice(side, dir, ev) {
  const mult = priceStepMultiplier(ev);
  if (side === 'buy') {
    recommendedBuy = Math.max(1, recommendedBuy + dir * priceStepFor(recommendedBuy) * mult);
    buyOverridden = true;
  } else {
    recommendedSell = Math.max(1, recommendedSell + dir * priceStepFor(recommendedSell) * mult);
    sellOverridden = true;
  }
  applyTargetPriceChange();
  /* After the change, so `value` reports the price landed on. */
  trackTargetAdjust(side, dir);
}
function applyTargetPriceChange() {
  renderTargetBoxes();
  const buyEl = $('#calcBuy'), sellEl = $('#calcSell');
  if (buyEl) buyEl.value = recommendedBuy || 0;
  if (sellEl) sellEl.value = recommendedSell || 0;
  if (buyEl || sellEl) updateCalculator();
  queueDraw();
}
function wireTargetPriceSteppers() {
  document.querySelectorAll('.price-step').forEach(btn => {
    btn.onclick = (ev) => { ev.stopPropagation(); adjustTargetPrice(btn.getAttribute('data-side'), Number(btn.getAttribute('data-dir')), ev); };
  });
}

/* Composite 0–100 grade for the currently-selected item on the SELECTED
   chart timeframe, scored from the perspective of the active price box
   (buy or sell). Switching timeframes re-asks the question against that
   window — "Steal Buy on 1Y" = near a multi-year floor; "Top Sell on 1D"
   = at today's peak — and the context chip labels which window answered.
   Coherence rule: the number and the verdict must never contradict — any
   "wait" verdict caps the score below the 70+ act-now tier (see below).
   Weighted components:
     - 45 pts: position within the timeframe's price range
     - 25 pts: trend direction (price moving into the desired extreme)
     - 20 pts: liquidity (log-scale 24h GP volume — can you actually trade it)
     - 25 pts (weighted): margin health over the same window */
function computeGrade(item, side) {
  if (!item || overMaxData[String(item.id)]) return null;
  const gs = currentSeries;
  if (!gs || !gs.labels || !gs.labels.length) return null;
  const id = String(item.id);
  const node = latest?.data?.[id];
  if (!node) return null;
  const current = side === 'buy'
    ? (node.low ?? node.avgLowPrice ?? 0)
    : (node.high ?? node.avgHighPrice ?? 0);
  if (current <= 0) return null;

  /* 1) Range position — against the window's USUAL range, not its absolute
     extremes. A handful of spike prints used to define the floor: on a real
     1D chart whose body traded 630-652, three isolated dips (0.7% of the
     day's buckets, the deepest at 551) stretched the range to 551-652 and
     put a 643 price at 91% of it — reading "near the ceiling, Strong Sell"
     for a price sitting mid-body. Trimming to the 5th/95th percentile puts
     the same price at 59%. The chart still draws every print and still
     marks the true extremes; it's only the SCORE that stops being decided
     by prints nobody could have traded size into. */
  const pctOf = (arr, f) => {
    const a = [];
    for (const v of arr) if (v != null && v > 0) a.push(v);
    if (!a.length) return null;
    a.sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.round(f * (a.length - 1))))];
  };
  const allPrints = [];
  for (let i = 0; i < gs.labels.length; i++) {
    if (gs.low[i] != null && gs.low[i] > 0) allPrints.push(gs.low[i]);
    if (gs.high[i] != null && gs.high[i] > 0) allPrints.push(gs.high[i]);
  }
  let minV = pctOf(allPrints, 0.05), maxV = pctOf(allPrints, 0.95);
  /* Flat/thin windows can trim to nothing — fall back to the true extremes
     rather than returning no grade at all. */
  if (minV == null || maxV == null || maxV <= minV) {
    minV = Math.min(...allPrints); maxV = Math.max(...allPrints);
  }
  if (!isFinite(minV) || !isFinite(maxV) || maxV <= minV) return null;
  const pos = Math.max(0, Math.min(1, (current - minV) / (maxV - minV)));
  const rangeScore = (side === 'buy' ? (1 - pos) : pos) * 45;

  // 2) Trend
  const valid = [];
  for (let i = 0; i < gs.labels.length; i++) {
    const L = gs.low[i], H = gs.high[i];
    if (L != null && H != null) valid.push((L + H) / 2);
    else if (L || H) valid.push(L || H);
  }
  let trendScore = 12, trendPct = null;
  if (valid.length >= 5) {
    const xs = valid.map((_, i) => i);
    const { slope } = linearRegression(xs, valid);
    const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
    if (avg > 0) {
      const slopePct = (slope * valid.length) / avg;
      trendPct = slopePct;
      const dir = side === 'buy' ? -slopePct : slopePct;
      trendScore = Math.max(0, Math.min(25, 12 + dir * 100));
    }
  }

  // 3) Liquidity (log-scale GP/24h)
  let liqScore = 5;
  const p24 = past24h?.data?.[id];
  if (p24) {
    const vol = (p24.highPriceVolume || 0) + (p24.lowPriceVolume || 0);
    const gp = vol * (p24.avgHighPrice || 0);
    if (gp > 1000) {
      const logGp = Math.log10(gp);
      liqScore = Math.max(0, Math.min(15, (logGp - 4) * 4));
    }
  }

  // 4) Long-term context — fixed baseline contribution. The 1Y-low buy-side
  //    bonus that used to live here was tied to the deleted history scanner.
  const longScore = 3;

  /* 5) Margin health — use the BETTER of two signals:
       a. The right-now engine spread (recommendedSell - recommendedBuy - tax).
       b. The visible window's potential margin (its max - min - tax) —
          captures the realised range, so a chart like Ruby that shows
          850→920 daily prints scores as a good flip even when the right-now
          tight spread is unprofitable.
     The grade only gets hard-pinned to "No Margin" when BOTH signals are
     unprofitable (i.e. the timeframe genuinely doesn't have a flip in it). */
  let currentMarginPct = null, dayMarginPct = null;
  if (recommendedBuy > 0 && recommendedSell > 0) {
    const tax = calculateTax(recommendedSell, item.id);
    currentMarginPct = (recommendedSell - recommendedBuy - tax) / recommendedBuy;
  }
  /* Same trimming, same reason — and it matters more here. Taken raw, the
     window's absolute high minus its absolute low called that 630-652 day a
     "16.2% margin" when the live spread was 4 gp. A margin you could only
     have captured by being the counterparty to a one-off spike is not a
     margin; the 95th/5th percentiles are the levels an order could
     realistically have filled at. */
  let dayHi = pctOf(gs.high, 0.95), dayLo = pctOf(gs.low, 0.05);
  if (dayHi == null) dayHi = -Infinity;
  if (dayLo == null) dayLo = Infinity;
  if (isFinite(dayHi) && isFinite(dayLo) && dayHi > dayLo) {
    const dayTax = calculateTax(dayHi, item.id);
    dayMarginPct = (dayHi - dayLo - dayTax) / dayLo;
  }
  /* Margin score weighted by side-appropriate range position so the same
     timeframe range can't simultaneously hand out 25/25 to BOTH buy and
     sell sides (which previously let a mid-range item read as "Top Sell"
     AND "Steal Buy" at the same time). At pos = 0.6 a SELL keeps 60% of
     the margin credit and a BUY keeps 40% — neither maxes unless the item
     is genuinely at the right end of the range for the side being graded. */
  const bestMarginPct = Math.max(currentMarginPct ?? -Infinity, dayMarginPct ?? -Infinity);
  const rawMarginScore = bestMarginPct > -Infinity
    ? Math.max(0, Math.min(25, (bestMarginPct / 0.02) * 25))
    : 0;
  const sideWeight = side === 'buy' ? (1 - pos) : pos;
  const marginScore = rawMarginScore * (0.35 + sideWeight * 0.65);

  let grade = Math.max(0, Math.min(100, Math.round(rangeScore + trendScore + liqScore + longScore + marginScore)));

  /* Returned so the gauge can show its working. Every figure here is one
     the user can check against the chart in front of them, which is the
     point — a 0-100 score nobody can audit is just a number. */
  const parts = {
    pos, rangeScore, trendScore, trendPct, liqScore, longScore, marginScore, side,
    marginPct: bestMarginPct > -Infinity ? bestMarginPct : null,
    gpVol: (() => { const q = past24h?.data?.[id]; return q ? ((q.highPriceVolume || 0) + (q.lowPriceVolume || 0)) * (q.avgHighPrice || 0) : 0; })(),
    minV, maxV, current
  };

  let verdict, color;
  /* Hard gate: only when BOTH right-now and day-potential are unprofitable
     — that means the timeframe genuinely has no flip in it. */
  const bothNegative = (currentMarginPct ?? 0) <= 0 && (dayMarginPct ?? 0) <= 0;
  const bothThin = (currentMarginPct ?? 0) < 0.005 && (dayMarginPct ?? 0) < 0.005;
  if (bothNegative) {
    grade = Math.min(grade, 22);
    verdict = 'No Margin'; color = '#EF5350';
    return { grade, verdict, color, parts };
  }
  if (bothThin) {
    grade = Math.min(grade, 42);
    verdict = 'Thin — Hold'; color = '#FF9F43';
    return { grade, verdict, color, parts };
  }
  /* Right-now is tight but the timeframe shows a real range — tell the user
     the opportunity is there if they're patient (don't hide it behind "Fair"). */
  if ((currentMarginPct ?? 1) <= 0 && (dayMarginPct ?? 0) > 0.01) {
    /* Verdict reads as a plain action — "Wait for Dip" / "Wait for Peak" —
       instead of "Patient Bid / Patient Ask" jargon a new flipper won't
       parse. COHERENCE: "wait" means don't act yet, so the score must sit
       BELOW the 70+ "act" tier — "100 Wait for Dip" read as a
       contradiction. 69 max = "good setup brewing, not ready". */
    grade = Math.min(grade, 69);
    verdict = side === 'buy' ? 'Wait for Dip' : 'Wait for Peak';
    /* Muted cream, not bright gold — gold verdicts inside the gold Target
       Buy box blended into the price and read as more "buy" signal. Cream
       says "fine / not yet" without borrowing an action color. */
    color = '#D6CCB2';
    return { grade, verdict, color, parts };
  }
  /* Verdict colors lean on the RuneScape palette: bright RS-green for the
     elite tier, RS-gold for the middle, scaling down to red. */
  if (grade >= 85) { verdict = side === 'buy' ? 'Steal Buy' : 'Top Sell'; color = '#4FFF8E'; }
  else if (grade >= 70) { verdict = side === 'buy' ? 'Strong Entry' : 'Strong Exit'; color = '#10B981'; }
  else if (grade >= 50) { verdict = side === 'buy' ? 'OK Buy' : 'OK Sell'; color = '#D6CCB2'; }
  else if (grade >= 30) { verdict = side === 'buy' ? 'Weak Buy' : 'Weak Sell'; color = '#FF9F43'; }
  else { verdict = side === 'buy' ? 'Avoid Buying' : 'Avoid Selling'; color = '#EF5350'; }
  return { grade, verdict, color, parts };
}

/* The per-box grade/fill badges were removed: they duplicated the Analyst
   Rating's job and every wording of them read as a second opinion fighting
   the targets. The boxes now show just the level + live quote; the gauge
   is the single opinion on the page. */

/* ════════════════════════════════════════════════════════════════════════
   ANALYST RATING GAUGE — reframes computeGrade(buy)+(sell) into ONE
   Strong-Sell … Strong-Buy call. Only valid for the SELECTED item (computeGrade
   reads the global currentSeries + recommendedBuy/Sell); for any other item
   pass opts.gBuy/gSell or it renders nothing. The word is a strict function of
   the DOMINANT grade so it can never sit opposite the higher price-box badge.
   ════════════════════════════════════════════════════════════════════════ */
/* Collapse preferences are stored PER LAYOUT. A phone and a desktop have
   completely different space budgets, so collapsing a card to survive a
   cramped landscape column shouldn't also collapse it on a 27-inch monitor —
   which is exactly what one shared key did, and why a desktop could open
   collapsed despite the default being expanded. Desktop reads its own key,
   so it gets the expanded-by-default first run even for someone who has been
   using the app on a phone for weeks. */
const isRoomyLayout = () => window.matchMedia('(min-width: 1024px)').matches;
const collapseKey = (base) => isRoomyLayout() ? base + '_wide' : base;
/* Collapsed hides the Buy/grade/Sell scale and the four-row breakdown,
   leaving the label, the verdict and the bar — everything a repeat user
   still reads.
   Collapsed is the FIRST-LOAD default, matching every other sidebar
   section: Potential Profit, Find Opportunities and all six scanners
   already start shut, so this one starting open made the sidebar's opening
   state look arbitrary rather than chosen. An explicit preference still
   wins in both directions — '1' and '0' are both stored, so a user who
   opens it keeps it open. Only the untouched case changed. */
function ratingCollapsed() {
  try {
    const v = localStorage.getItem(collapseKey('ge_ratingCollapsed'));
    if (v === '1') return true;
    if (v === '0') return false;
    return true;
  } catch (e) { return true; }
}
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest && ev.target.closest('.rg-toggle');
  if (!btn) return;
  ev.stopPropagation();
  const next = !ratingCollapsed();
  try { localStorage.setItem(collapseKey('ge_ratingCollapsed'), next ? '1' : '0'); } catch (e) {}
  document.querySelectorAll('.rg-wrap').forEach(el => el.classList.toggle('is-collapsed', next));
  document.querySelectorAll('.rg-toggle').forEach(b => {
    b.classList.toggle('closed', next);
    b.setAttribute('aria-expanded', next ? 'false' : 'true');
    b.setAttribute('aria-label', (next ? 'Expand' : 'Collapse') + ' Analyst Rating details');
  });
  /* `next` is the COLLAPSED flag, so it inverts to the panel's state. */
  track('analyst_rating_toggle', { state: next ? 'closed' : 'open' });
});

/* The expanded gauge shows its working. A 0-100 score nobody can audit is
   just a number — and this one moves when you change timeframe, which reads
   as noise until you can see that it's the RANGE that changed underneath it.
   Every row here is checkable against the chart on screen. */
/* ── Market Read ─────────────────────────────────────────────────────────
   A deterministic rule engine over data the page already has: the selected
   window's prints, its volumes, and the grade parts the rating was built
   from. No model, no network call — the same inputs always produce the same
   sentence, which is the only way a caption like this can be trusted.
   Tone rules, deliberately enforced by having ONLY these strings: describe
   what the tape is doing, never what it will do next. No "buy now", no
   "confirmed bottom", no outcome language. Returns null when nothing fires,
   and the caller renders nothing — an empty Market Read is worse than none,
   because a section that's always there trains people to ignore it. */
function computeMarketRead(parts) {
  const s = currentSeries;
  if (!s || !s.labels || s.labels.length < 12) return null;

  const lows = [], highs = [], vols = [], mids = [];
  for (let i = 0; i < s.labels.length; i++) {
    const L = s.low[i], H = s.high[i];
    if (L != null && L > 0) lows.push(L);
    if (H != null && H > 0) highs.push(H);
    if (L != null && H != null) mids.push((L + H) / 2);
    else if (L != null) mids.push(L); else if (H != null) mids.push(H);
    vols.push((s.lowVol[i] || 0) + (s.highVol[i] || 0));
  }
  if (lows.length < 6 || highs.length < 6) return null;
  const lo = Math.min.apply(null, lows), hi = Math.max.apply(null, highs);
  if (!(hi > lo)) return null;

  const price = (liveBuyRaw > 0 && liveSellRaw > 0) ? (liveBuyRaw + liveSellRaw) / 2
    : (liveSellRaw > 0 ? liveSellRaw : (liveBuyRaw > 0 ? liveBuyRaw : mids[mids.length - 1]));
  if (!(price > 0)) return null;

  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const tail = Math.max(3, Math.round(s.labels.length * 0.1));
  const recentVol = mean(vols.slice(-tail)), allVol = mean(vols);
  const volRatio = allVol > 0 ? recentVol / allVol : 0;

  /* Volatility compression: how much of the window's full range the most
     recent fifth of it actually covered. */
  const rTail = Math.max(4, Math.round(mids.length * 0.2));
  const recent = mids.slice(-rTail);
  const recentRange = recent.length ? (Math.max.apply(null, recent) - Math.min.apply(null, recent)) : 0;
  const compression = (hi - lo) > 0 ? recentRange / (hi - lo) : 1;

  const nearLow = price <= lo * 1.03;
  const nearHigh = price >= hi * 0.97;
  const elevated = volRatio >= 2;
  const pos = (price - lo) / (hi - lo);

  /* 1. Volume at the lows. If the price is ALSO within 3% of the yearly low,
        say so — a year-scale level is a stronger piece of context than the
        selected window's own floor, and the caption should reflect that
        without becoming a forecast. */
  if (nearLow && elevated) {
    let yearLow = 0;
    try {
      const ys = filterSeries(seriesForView('1y', currentItemSrc, currentItemLowVol), getPeriod('1y'));
      const yl = (ys.low || []).filter(v => v != null && v > 0);
      if (yl.length >= 12) yearLow = Math.min.apply(null, yl);
    } catch (e) { yearLow = 0; }
    if (yearLow > 0 && price <= yearLow * 1.03 && view !== '1y') {
      return { text: 'Heavy volume near the 1-year low. Sustained interest at a level the market has held before — not a prediction.', key: 'lows-year' };
    }
    return { text: 'Heavy volume near the period low. Possible absorption / base forming — not a prediction.', key: 'lows' };
  }
  /* 2. Volume at the highs. */
  if (nearHigh && elevated) {
    return { text: 'Heavy volume near the period high. Watch for profit-taking / rejection.', key: 'highs' };
  }
  /* 3. Wide margin nobody is trading.
        Measured in UNITS per day, not gp per day. The rating's own liqScore is
        log10(gp/day) based, so "liqScore <= 5" means under ~178k gp/day and
        almost nothing reaches it: a 2M item trading twice a day — days to fill
        an order — scores 10.5/15, because two units of something expensive is
        a lot of gp. The question this caption answers is "will my order fill",
        and that is a unit question. Under one buy-limit's worth a day means you
        cannot even complete a single limit in a session. */
  if (parts && parts.gpVol > 0 && parts.marginPct != null && parts.marginPct >= 0.03) {
    const unitsPerDay = parts.gpVol / price;
    const limit = (selected && selected.limit > 0) ? selected.limit : 1;
    if (unitsPerDay < limit) {
      return { text: 'Wide margin, but low liquidity — fills may be slow.', key: 'illiquid' };
    }
  }
  /* 4. Quiet and coiled in the lower third. */
  if (pos <= 0.35 && compression <= 0.35) {
    return { text: 'Quiet consolidation near support. Possible swing candidate if volume returns.', key: 'quiet' };
  }
  return null;
}

function ratingWhyHtml(gBuy, gSell, tf) {
  const b = gBuy.grade, s = gSell.grade;
  const dom = (b >= s) ? gBuy : gSell;
  const p = dom.parts;
  if (!p) return '';
  const pct = (n) => Math.round(n * 100);
  const bar = (score, max) => {
    const w = Math.max(0, Math.min(100, (score / max) * 100));
    return '<span class="rw-bar"><i style="width:' + w.toFixed(0) + '%"></i></span>'
      + '<span class="rw-p">' + Math.round(score) + '<em>/' + max + '</em></span>';
  };
  const row = (k, v, score, max) =>
    '<div class="rg-why-row"><span class="rw-k">' + k + '</span>'
    + '<span class="rw-v">' + v + '</span>' + bar(score, max) + '</div>';

  /* Every row used to restate the timeframe — "…over 1D", "…1D's usual
     range" — even though the head says "· 1D" directly above them. Said
     once, the rows get shorter without losing anything.
     Range in particular read as arithmetic to decode: "0% up 1D's usual
     range (2,440–2,500)". Where the price SITS is the answer, so it says
     that in words and keeps the bounds as the supporting parenthetical. */
  const posTxt = p.pos == null ? 'Range unknown'
    : p.pos < 0.15 ? 'Bottom of range'
    : p.pos < 0.35 ? 'Low in range'
    : p.pos < 0.65 ? 'Mid range'
    : p.pos < 0.85 ? 'High in range'
    : 'Top of range';
  const rangeTxt = (p.minV == null || p.maxV == null) ? posTxt
    : posTxt + ' (' + fmtGp(Math.round(p.minV)) + '–' + fmtGp(Math.round(p.maxV)) + ')';
  const trendTxt = p.trendPct == null ? 'Flat'
    : Math.abs(p.trendPct) <= 0.005 ? 'Flat'
      : (p.trendPct > 0 ? 'Rising ' : 'Falling ') + Math.abs(pct(p.trendPct)) + '%';
  const marginTxt = p.marginPct == null ? 'No workable spread'
    : (p.marginPct * 100).toFixed(1) + '% after ' + feeLabelShort(selected && selected.id);
  const liqTxt = p.gpVol > 0 ? abbreviateNumber(p.gpVol) + ' gp/day' : 'Barely traded';

  /* The gap between the two sides decides how strong the call is, so it is
     said out loud rather than left as an unexplained jump — but in ONE
     line. This was two sentences ("Scored from the buy side, the better
     graded of the two. One side wins by 32 points, so this is a firm
     call."), which turned a scorecard into a write-up at exactly the point
     a reader has already got their answer. Naming the winning side covers
     what the dropped first sentence was for: it IS the side the four rows
     are scored from. The tie case has no winner to name, so that one says
     it outright. */
  const gap = Math.abs(b - s);
  const sideWord = p.side === 'buy' ? 'Buy' : 'Sell';
  const verdictNote = gap >= 30
    ? sideWord + ' side wins by ' + gap + ' — firm call.'
    : gap >= 12
      ? sideWord + ' side leads by ' + gap + ' — a lean.'
      : 'Buy and Sell within ' + gap + ' — rows show the ' + sideWord.toLowerCase() + ' side.';

  return '<div class="rg-why">'
    + '<div class="rg-why-head"><span class="rw-t">Why this rating · ' + tf + '</span>'
    + '<span class="rw-sides"><b class="rw-buy">Buy ' + b + '</b><i>vs</i><b class="rw-sell">Sell ' + s + '</b></span></div>'
    + row('Range', rangeTxt, p.rangeScore, 45)
    + row('Trend', trendTxt, p.trendScore, 25)
    + row('Margin', marginTxt, p.marginScore, 25)
    + row('Liquidity', liqTxt, p.liqScore, 15)
    + '<div class="rg-why-foot">' + verdictNote + '</div>'
    /* Secondary to the rating by construction: it comes last, after the
       verdict line, behind a hairline, in muted type. Absent entirely when no
       rule fires — see computeMarketRead. */
    + (() => {
        const mr = computeMarketRead(p);
        if (!mr) return '';
        return '<div class="rg-read"><span class="rr-t">Market Read</span>'
          + '<p class="rr-b">' + mr.text + '</p></div>';
      })()
    + '</div>';
}

function renderRatingGauge(item, mountEl, opts = {}) {
  if (!mountEl) return;
  const isSel = item && selected && String(item.id) === String(selected.id);
  let gBuy = opts.gBuy, gSell = opts.gSell;
  if (gBuy === undefined || gSell === undefined) {
    if (!isSel) { mountEl.hidden = true; mountEl.innerHTML = ''; return; }
    gBuy = computeGrade(item, 'buy'); gSell = computeGrade(item, 'sell');
  }
  const tf = (opts.timeframe || view || '').toUpperCase();
  let label, hue = 'var(--text-muted)', sub = '', signed = 0, liveIdx = -1, muted = false, strong = false, whyHtml = '';

  if (item && overMaxData[String(item.id)]) { muted = true; label = 'No live gauge'; sub = 'Rare item — off the live market'; }
  else if (!gBuy || !gSell) { muted = true; label = 'Analyzing…'; sub = 'Waiting for price history'; }
  else {
    const vB = gBuy.verdict, vS = gSell.verdict;
    if (vB === 'No Margin' && vS === 'No Margin') { muted = true; hue = 'var(--negative)'; label = 'No clean flip'; sub = `Spread doesn't beat the 2% tax on ${tf}`; }
    else if (/^Thin/.test(vB) && /^Thin/.test(vS)) { muted = true; hue = '#FF9F43'; label = 'Too thin to flip'; sub = `Margin under 0.5% on ${tf}`; }
    else {
      const b = gBuy.grade, s = gSell.grade;
      /* Conviction is the MARGIN OF VICTORY, not the winner's absolute
         score. It used to be (dom - 40) / 60 — the better side's own grade —
         which meant that whenever both sides scored well (any liquid item
         with a real range) mag pinned near 1 and the label jumped straight
         to Strong Buy or Strong Sell on whichever side led, however
         narrowly. Measured: at 70% through the range the two grades tied at
         86/86 and it still read "Strong Buy"; three gp higher, at a 7-point
         deficit, it read "Strong Sell". Buy / no-call / Sell were
         unreachable, and switching timeframe re-rolled the near-tie, which
         is why one item read Strong Sell on 1D, Strong Buy on 5D, Strong
         Sell on 1M and Strong Buy on 6M at one unchanged price.
         Now: quality asks "is the better side any good", conviction asks
         "does it win clearly", and BOTH have to hold for a strong call. A
         genuine tie produces no verdict word at all — which for a
         mid-range item with a healthy spread is the honest answer, since it
         flips fine in either direction. */
      const dir = (b >= s) ? 1 : -1, dom = Math.max(b, s);
      const quality = Math.max(0, Math.min(1, (dom - 40) / 60));
      const conviction = Math.max(0, Math.min(1, Math.abs(b - s) / 30));
      const mag = quality * conviction;
      /* Patient only when the DOMINANT side is itself a wait — a ripe
         "100 Steal Buy" paired with the other side's "Wait for Peak" is an
         act-now Strong Buy, not "not yet". */
      const patient = /^Wait/.test((b >= s) ? vB : vS);
      if (patient) {
        signed = dir * Math.min(mag, 0.55); strong = false;
        if (dir > 0) { label = 'Buy the Dip'; hue = 'var(--buy-color)'; liveIdx = 3; }
        else { label = 'Sell the Rip'; hue = 'var(--sell-color)'; liveIdx = 1; }
        sub = `${dir > 0 ? 'Entry' : 'Exit'} score ${dom} · ${tf} · not yet`;
      } else {
        signed = dir * mag;
        if      (signed >=  0.60) { label = 'Strong Buy';  hue = 'var(--buy-color)';  liveIdx = 4; strong = true; }
        else if (signed >=  0.20) { label = 'Buy';         hue = 'var(--buy-color)';  liveIdx = 3; }
        /* No word at all in the middle band. "Neutral" was a non-answer
           dressed as an answer: it occupied the line where Strong Buy or
           Sell would sit, in the same size and weight, while telling a
           reader nothing they could act on. The meter directly below shows
           the needle sitting mid-scale, which says the same thing without
           claiming to be a call — and since the "ANALYST RATING" eyebrow is
           now permanent, dropping the word leaves the block labelled rather
           than blank. */
        else if (signed >  -0.20) { label = '';             hue = 'var(--text-muted)'; liveIdx = 2; }
        else if (signed >  -0.60) { label = 'Sell';        hue = 'var(--sell-color)'; liveIdx = 1; }
        else                      { label = 'Strong Sell'; hue = 'var(--sell-color)'; liveIdx = 0; strong = true; }
        sub = `${dir > 0 ? 'Entry' : 'Exit'} score ${dom} · ${tf}`;
      }
      whyHtml = ratingWhyHtml(gBuy, gSell, tf);
    }
  }
  /* Track runs BUY (left) → SELL (right) to mirror the page layout: Target
     Buy is the left price box, Target Sell the right. signed=+1 (strong
     buy) therefore lands at 0%, signed=-1 at 100%. */
  const needleX = (1 - signed) / 2 * 100, aria = Math.round(signed * 100);
  const segCls = i => 'rg-seg ' + ['rg-ss', 'rg-s', 'rg-n', 'rg-b', 'rg-sb'][i] + (i === liveIdx ? ' is-live' : '');
  const tip = ('Analyst Rating condenses the same 0–100 buy and sell grade — scored against the ' + tf +
    ' price range, so it re-judges when you switch chart timeframes — into one call, Strong Sell to Strong ' +
    'Buy. It points to whichever side (entry or exit) is better graded right now. Advisory only: the Target ' +
    'Buy / Target Sell prices are the actual trade. Tap for the full glossary.').replace(/"/g, '&quot;');
  mountEl.hidden = false;
  const collapsed = ratingCollapsed();
  mountEl.innerHTML =
    '<div class="rg-top"><span class="rg-eyebrow">Analyst Rating</span>' +
      '<span class="pg-help" title="' + tip + '" role="button" aria-label="What does the Analyst Rating mean?">?</span>' +
      '<button type="button" class="rg-toggle calc-caret' + (collapsed ? ' closed' : '') + '" aria-expanded="' + (collapsed ? 'false' : 'true') + '" ' +
        'aria-label="' + (collapsed ? 'Expand' : 'Collapse') + ' Analyst Rating details">' + uiIcon('chev') + '</button></div>' +
    '<div class="rg-label' + (strong ? ' is-strong' : '') + '" style="color:' + hue + '">' + label + '</div>' +
    '<div class="rg-meter' + (muted ? ' is-muted' : '') + '" role="meter" aria-valuemin="-100" aria-valuemax="100" ' +
      'aria-valuenow="' + aria + '" aria-valuetext="' + label + '" aria-label="Analyst rating: ' + label + (sub ? ', ' + sub : '') + '">' +
      '<div class="rg-track">' + [4, 3, 2, 1, 0].map(i => '<span class="' + segCls(i) + '"></span>').join('') + '</div>' +
      '<span class="rg-needle" style="left:' + needleX + '%;--rg-hue:' + hue + '"></span>' +
    '</div>' +
    '<div class="rg-scale"><span class="rg-end rg-end-buy">Buy</span>' +
      '<span class="rg-sub">' + sub + '</span><span class="rg-end rg-end-sell">Sell</span></div>' +
    whyHtml;
  mountEl.classList.toggle('is-collapsed', collapsed);
  /* Same widened target as the other two section headers. Re-wired here
     because the innerHTML above throws the previous row away. The help chip
     and the chevron are skipped — only the row's own space and the
     "Analyst Rating" label toggle it. */
  wireHeaderToggle(mountEl.querySelector('.rg-top'),
                   mountEl.querySelector('.rg-toggle'),
                   '.pg-help, .rg-toggle, button, a');
}

/* Quick-facts strip below the chart: live insta-buy/insta-sell with "…ago"
   freshness, spread, daily volume, buy limit. */
function renderQuickFacts(m, node) {
  const el = document.getElementById('quickFacts'); if (!el) return;
  /* The wrapper carries visibility now — it holds the Refresh button too. */
  const row = document.getElementById('quickFactsRow') || el;
  if (!m || !node) { row.style.display = 'none'; return; }
  const high = node.high ?? node.avgHighPrice ?? 0, low = node.low ?? node.avgLowPrice ?? 0;
  const spread = (high > 0 && low > 0) ? high - low : 0, vol = dailyVolume(m.id);
  /* `tip` lands on the whole cell, so the label and the figure share one
     hover target — the reported behaviour was "hover over the word spread
     AND the spread value", and splitting them would make half the control
     silently inert. */
  const cell = (k, v, extra = '', tip = '') =>
    `<span class="qf-cell"${tip ? ` title="${tip}"` : ''}><span class="qf-k">${k}</span><span class="qf-v">${v}</span>${extra}</span>`;
  /* Insta-buy and Insta-sell used to lead this strip. They are the same two
     numbers the Target boxes print in their captions, a couple of inches
     above — and the two carried DIFFERENT ages, because the boxes were aged
     off the fetch time and these off the prints' own timestamps. Two clocks
     for one fact is worse than either. The prints' timestamps were the
     correct ones, so they moved up to the captions and the duplicate cells
     are gone; Spread, Vol and Limit are unique to this row and stay. */
  const parts = [];
  /* Deliberately says what it is NOT. The spread is the figure people mistake
     for their profit, and the FAQ already has to spend a paragraph on the
     difference — a 2,000gp item with a 40gp spread keeps nothing once the 2%
     tax lands. Naming the tax here is the whole value of the tooltip. */
  if (spread > 0) parts.push(cell('Spread', fmtGp(spread), '',
    'Insta-buy minus insta-sell right now, before tax. Room to work with, not profit — the 2% GE tax comes out of it.'));
  parts.push(cell('Vol', vol ? abbreviateNumber(vol) + '/day' : '—'));
  /* Limit was the third cell. Potential Profit's subline states it in full a
     few inches below — "18,000 units · 4h limit" — and unlike Vol that is
     unconditional, so this was the same fact twice on one screen every time.
     Spread stays: it is the one figure in this row nothing else on the page
     prints, and the FAQ points at it by name. */
  el.innerHTML = parts.join('<span class="qf-sep">·</span>'); row.style.display = '';
  fitQuickFactsRow();
}
/* Spread and Vol get a line of their own when the row cannot hold them. On a
   600M item the 30-Day Range prints two ten-digit numbers and there is simply
   no room left; the strip used to be squeezed until SPREAD sat under the range
   bar and VOL was cut off entirely.

   `flex-wrap: wrap` on the row does the wrapping. All this decides is where
   the strip sits ONCE wrapped: `margin-left: auto` is what parks it at the far
   right of a shared line, and on a line of its own that same margin strands it
   on the right instead of putting it under Fill/VP where the space is.

   So the test is "is it on a different line from Refresh", not "is it
   clipped". Clipping was the first version's signal and it never fired — once
   the row wraps, the strip is never squeezed, so adding flex-wrap destroyed
   the very condition being measured. Comparing line positions asks the
   question that is still true afterwards.

   No feedback loop: auto margins resolve to zero for line-breaking, so
   removing one cannot pull the strip back up onto line one and start the
   toggle oscillating. */
function fitQuickFactsRow() {
  const row = document.getElementById('quickFactsRow');
  const qf = document.getElementById('quickFacts');
  const ref = document.getElementById('btnRefreshPrices');
  if (!row || !qf || !ref) return;
  const wrapped = qf.getBoundingClientRect().top > ref.getBoundingClientRect().top + 4;
  row.classList.toggle('is-stacked', wrapped);
}
/* Watch the ROW, not just the render. renderQuickFacts calls the fit, but the
   30-Day Range meter is moved into this row by placeItemInsight afterwards —
   so at render time the row has not wrapped yet and the answer is always
   "no". Measured before this: at 900x800 the strip was visibly on line two
   while the class was still off. The row's height is what changes when it
   wraps, and toggling a margin does not change that height, so observing it
   cannot feed back. */
let _qfFitRaf = 0;
const _scheduleQfFit = () => {
  if (_qfFitRaf) return;
  _qfFitRaf = requestAnimationFrame(() => { _qfFitRaf = 0; fitQuickFactsRow(); });
};
window.addEventListener('resize', _scheduleQfFit);
if ('ResizeObserver' in window) {
  const _qfRow = document.getElementById('quickFactsRow');
  if (_qfRow) new ResizeObserver(_scheduleQfFit).observe(_qfRow);
}

/* One call every price-render site adds to keep the insights row in sync.
   Guard against a stale async render: setItem is async, so a late call for
   item A can land after the user has switched to B (selected === B). Bail so
   the gauge (which reads the global selected/currentSeries) can't disagree
   with the quick-facts strip (which reads the passed m/node). */
/* 30-day low/high/first/last from the best available source, independent of
   the displayed chart timeframe so the summary is stable. */
function rangeStatsForView(m, v) {
  let src = null;
  if (currentItemSrc) src = seriesForView(v, currentItemSrc, currentItemLowVol);
  else if (overMaxData[String(m.id)] && overMaxFull) src = overMaxFull;
  if (!src || !src.labels || !src.labels.length) return null;
  const win = filterSeries(src, getPeriod(v));
  let lo = Infinity, hi = -Infinity, first = null, last = null;
  for (let i = 0; i < win.labels.length; i++) {
    const L = win.low[i], H = win.high[i];
    if (L != null && L > 0) { if (L < lo) lo = L; if (first == null) first = L; last = L; }
    if (H != null && H > 0) { if (H > hi) hi = H; if (first == null) first = H; last = H; }
  }
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return null;
  return { lo, hi, first, last };
}
function thirtyDayStats(m) { return rangeStatsForView(m, '1m'); }

/* Auto-generated per-item summary sentence + 30-day range meter. Pure text
   (crawlable) with live numbers, refreshed on every price render. */
function renderItemInsight(m, node) {
  const box = document.getElementById('itemInsight');
  if (!box) return;
  if (!m || !node || overMaxData[String(m.id)]) { box.style.display = 'none'; return; }
  const high = node.high ?? node.avgHighPrice ?? 0;   // insta-buy (headline price)
  const low = node.low ?? node.avgLowPrice ?? 0;      // insta-sell
  const stats = thirtyDayStats(m);
  if (!(high > 0) || !stats) { box.style.display = 'none'; return; }

  // position of the live price within its 30-day range (0 = floor, 1 = ceiling)
  const price = high;
  const pos = Math.max(0, Math.min(1, (price - stats.lo) / (stats.hi - stats.lo)));
  document.getElementById('insMarker').style.left = (pos * 100).toFixed(1) + '%';
  const fillEl = document.getElementById('insFill');
  if (fillEl) fillEl.style.width = (pos * 100).toFixed(1) + '%';
  const priceEl = document.getElementById('insPrice');
  if (priceEl) priceEl.textContent = fmtGp(price);
  document.getElementById('insLo').textContent = fmtGp(stats.lo);
  document.getElementById('insHi').textContent = fmtGp(stats.hi);

  /* The bar's screen-reader form. Its position is a CSS offset and its
     zone is a colour, so without this the whole 30-day read is invisible to
     assistive tech — the summary sentence used to be carrying that job. */
  const zone = pos <= 0.25 ? 'near its 30-day low'
    : pos >= 0.75 ? 'near its 30-day high'
    : 'mid 30-day range';
  const meter = document.getElementById('insMeter');
  if (meter) meter.setAttribute('aria-label',
    `${fmtGp(price)} gp, ${zone}. 30-day range ${fmtGp(stats.lo)} to ${fmtGp(stats.hi)} gp.`);
  box.style.display = '';
}

function refreshItemInsights(m, node) {
  if (m && selected && String(m.id) !== String(selected.id)) return;
  renderQuickFacts(m || null, node || null);
  renderItemInsight(m || null, node || null);
  renderRatingGauge(selected, document.getElementById('ratingGauge'));
  /* Live numbers just (re)rendered — sync the SERP surface (title + meta
     description + JSON-LD) so a crawler that executes JS indexes the page
     with the actual price in it, and every 5-min refresh keeps it current. */
  if (!isHomepageDefault && m) { applyTitleBadge(); updateMetaForItem(m); }
}

/* ════════════════════════════════════════════════════════════════════════
   RECOMMENDED-FLIP FINDER
   ════════════════════════════════════════════════════════════════════════ */
function recLiqMult(vol){ return 0.6 + 0.4 * Math.max(0, Math.min(1, (Math.log10(Math.max(1, vol)) - 4) / 3)); }
function recQtyEff(item, vol){
  const limit = item.limit > 0 ? item.limit : REC_NO_LIMIT_QTY;
  const est4h = Math.max(1, Math.floor(vol * (4 / 24) * REC_FILL_SHARE));
  return Math.max(1, Math.min(limit, est4h));
}
/* Cheap pre-score over the bounded scan pool — 0 timeseries calls. Ranks by
   realizable (fill-scaled) gp, not raw margin %, so illiquid mirages sink. */
function recPreScore({ relax = false } = {}) {
  const minVol = relax ? REC_MIN_VOL_RELAX : REC_MIN_VOL;
  const seen = relax ? new Set() : recSeenSet();
  const selId = selected ? String(selected.id) : null;
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (const item of getScanCandidates()) {
    const id = String(item.id);
    if (id === selId || id === recLastId) continue;
    if (seen.has(id)) continue;
    const node = latest?.data?.[id];
    if (!node || !(node.high > 0) || !(node.low > 0) || node.high <= node.low) continue;
    const ageT = now - Math.min(node.highTime || 0, node.lowTime || 0);
    if (!(ageT >= 0) || ageT > REC_MAX_AGE) continue;
    const vol = dailyVolume(item.id);
    if (vol < minVol) continue;
    const gross = node.high - node.low - calculateTax(node.high, item.id);
    if (gross <= 0) continue;
    if (gross / node.low > REC_MAX_MARGIN_PCT) continue;
    const qty = recQtyEff(item, vol);
    out.push({ item, node, vol, preScore: gross * qty * recLiqMult(vol) });
  }
  out.sort((a, b) => b.preScore - a.preScore);
  return out;
}
/* Score parts, kept separate from the total so the card can show its work.
   The number is the only thing on the card with no unit and no label, which
   invites "91 out of what?" — and a generic definition wouldn't answer it,
   because two picks can sit a few points apart for completely different
   reasons. Note the edge term SATURATES at a 3% net edge: an 11.8% edge and
   a flat 3.0% edge both score the full 45, so between two liquid picks the
   gap is almost entirely liquidity, not margin. */
const REC_EDGE_FULL = 0.03;      // net edge that earns the full edge points
function recScoreParts(edgePct, vol, lowConf){
  const base = 20;               // engine already certified viable + reachable
  const edge = Math.max(0, Math.min(1, edgePct / REC_EDGE_FULL)) * 45;
  const liq  = Math.max(0, Math.min(1, (Math.log10(Math.max(1, vol)) - 4) / 3)) * 35;
  const raw  = base + edge + liq;
  const total = Math.round(Math.max(0, Math.min(100, lowConf ? raw * 0.8 : raw)));
  return { base, edge, liq, penalty: lowConf ? raw * 0.2 : 0, lowConf: !!lowConf, total,
           edgeMaxed: edgePct >= REC_EDGE_FULL, liqMaxed: vol >= 1e7 };
}
function recFlipScore(edgePct, vol, lowConf){ return recScoreParts(edgePct, vol, lowConf).total; }
const REC_BANDS = [
  { min: 0,  word: 'Thin Flip',   color: '#FF9F43' },
  { min: 55, word: 'Solid Flip',  color: '#FFD24D' },
  { min: 70, word: 'Strong Flip', color: '#10B981' },
  { min: 85, word: 'Prime Flip',  color: '#4FFF8E' }
];
function recVerdict(s){
  for (let i = REC_BANDS.length - 1; i >= 0; i--) if (s >= REC_BANDS[i].min) return REC_BANDS[i];
  return REC_BANDS[0];
}
/* Popup body for the score. Deliberately shows the live arithmetic instead of
   a definition: it's the only way to answer "why is this one 91 and that one
   100" — and it makes the edge cap visible rather than hiding it, since a
   3% edge and an 11% edge both bank the full 45. */
function flipScoreTip(rec){
  const p = rec.parts, r = n => Math.round(n);
  const row = (k, v, note) =>
    `<div class="fc-tip-row"><span>${k}</span><b>${v}</b></div>`
    + (note ? `<div class="fc-tip-cap">${note}</div>` : '');
  const bands = REC_BANDS.map(b =>
    `<div class="fc-tip-band${b.word === rec.verdict ? ' on' : ''}"${b.word === rec.verdict ? ` style="background:${b.color}"` : ''}>${b.word.replace(' Flip','')}<br>${b.min ? b.min + '+' : '&lt;55'}</div>`).join('');
  return `<div class="fc-tip" id="flipScoreTip" role="tooltip">
    <div class="fc-tip-h" style="color:${rec.color}">${rec.verdict} · ${rec.flipScore}/100</div>
    <div class="fc-tip-sub">How good this specific flip looks right now — not a rating of the item itself.</div>
    ${row('Base (engine-cleared)', '+' + r(p.base))}
    ${row(`Net edge ${(rec.edgePct * 100).toFixed(rec.edgePct < 0.1 ? 2 : 1)}%`, '+' + r(p.edge) + ' / 45',
          p.edgeMaxed ? 'Maxed — anything past a 3% edge scores the same.' : 'Full 45 at a 3% net edge.')}
    ${row(`Liquidity ${abbreviateNumber(rec.vol)}/day`, '+' + r(p.liq) + ' / 35',
          p.liqMaxed ? 'Maxed — 10M+ traded a day.' : 'Full 35 at 10M traded a day.')}
    ${p.lowConf ? row('Thin tape', '−' + r(p.penalty), 'One side hasn\'t traded recently.') : ''}
    <div class="fc-tip-row tot"><span>Score</span><b style="color:${rec.color}">${rec.flipScore}</b></div>
    <div class="fc-tip-bands">${bands}</div>
    <div class="fc-tip-foot">Tap ↻ Next to walk down the ranking — scores fall as the picks get thinner.</div>
  </div>`;
}
/* The third clause used to be a two-way toggle whose false branch — "both
   sides recently traded" — was the ordinary case, so it printed on virtually
   every pick and wrapped the line onto two. A phrase that is true of almost
   everything tells you nothing about the item in front of you.

   Only the warning half survives, and only when it fires. Nothing replaces it
   in the common case: the two facts that are left already vary per item, and
   the rest of the card carries buy/sell, profit, per-4h and daily volume.
   Fill speed and 5D range were the candidates, but hrsToLimit is just the
   per-4h figure restated against volume already shown two rows down, and the
   5D extremes are not computed on this path — inventing a signal here would
   put a number on the card that nothing else validates. */
function recWhy(edgePct, qtyEff, lowConf){
  const bits = [ `${(edgePct * 100).toFixed(edgePct < 0.1 ? 2 : 1)}% net edge`,
                 `${abbreviateNumber(qtyEff)}/4h fillable` ];
  if (lowConf) bits.push('thinner tape — patient bid');
  return bits.join(' · ');
}
function buildRec(c, eng){
  const item = c.item, node = c.node;
  const edge = eng.edge, edgePct = edge / Math.max(1, eng.buy);
  const hasLimit = item.limit > 0, limit = hasLimit ? item.limit : REC_NO_LIMIT_QTY;
  const qtyEff = recQtyEff(item, c.vol);
  const parts = recScoreParts(edgePct, c.vol, eng.lowConf);
  const flipScore = parts.total;
  const v = recVerdict(flipScore);
  const hrsToLimit = Math.max(1, Math.round(limit / Math.max(1, c.vol / 24)));
  return {
    id: String(item.id), item, node, buy: eng.buy, sell: eng.sell, edge, edgePct, lowConf: eng.lowConf,
    hasLimit, limit, qtyEff, hrsToLimit,
    realizable: edge * qtyEff, perLimit: edge * limit,
    /* verdictShort drops the trailing "Flip" — the collapsed summary sits
       directly under a header that already says "Recommended flip", so the
       full "Strong Flip" repeats the word twice in ~40px. The expanded card
       keeps the full phrase, where it stands alone under the score. */
    vol: c.vol, flipScore, parts, verdict: v.word,
    verdictShort: v.word.replace(/\s*Flip$/, ''), color: v.color,
    rankValue: edge * qtyEff * recLiqMult(c.vol) * (eng.lowConf ? 0.8 : 1),
    why: recWhy(edgePct, qtyEff, eng.lowConf), series: null
  };
}
/* Confirm the shortlist with the real engine (<=REC_SHORTLIST timeseries fetches,
   5m first, 1h fallback only when 5m has <8 buckets). HARD GATE on viable. */
async function scanFlips({ relax = false } = {}) {
  const gen = recScanGen;
  const shortlist = recPreScore({ relax }).slice(0, REC_SHORTLIST);
  const confirmed = [];
  await throttleMap(shortlist, async (c) => {
    try {
      const s = { ts5m: seriesFromTS(await loadTSCached('5m', c.item.id)) };
      if (!pickEngineSeries(s)) s.ts1h = seriesFromTS(await loadTSCached('1h', c.item.id));
      const series = pickEngineSeries(s) || s.ts5m;
      const eng = runTradeEngine(c.node.low, c.node.high, series, c.node, c.item.id);
      if (eng.viable) { const rec = buildRec(c, eng); rec.series = series; confirmed.push(rec); }
    } catch (e) {}
  }, SCAN_CONCURRENCY);
  if (gen !== recScanGen) return null;   // universe toggled mid-scan => discard
  confirmed.sort((a, b) => b.rankValue - a.rankValue);
  return confirmed;
}
/* Anti-repeat: seen-set keyed by universe, 3h TTL + 40-item starvation reset. */
function recSeenLoad(){ try { return JSON.parse(localStorage.getItem(REC_SEEN_KEY) || '{}'); } catch (e) { return {}; } }
function recSeenSave(o){ try { localStorage.setItem(REC_SEEN_KEY, JSON.stringify(o)); } catch (e) {} }
function recSeenSet(){
  const store = recSeenLoad();
  if (store.uni !== (membersOn ? 'p2p' : 'f2p')) return new Set();
  const now = Date.now(), out = new Set();
  for (const [id, ts] of Object.entries(store.ids || {})) if (now - ts < REC_SEEN_TTL) out.add(id);
  return out;
}
function markRecSeen(id){
  id = String(id); const uni = membersOn ? 'p2p' : 'f2p';
  let store = recSeenLoad(); if (store.uni !== uni) store = { uni, ids: {} };
  const now = Date.now(); store.ids = store.ids || {};
  for (const k of Object.keys(store.ids)) if (now - store.ids[k] >= REC_SEEN_TTL) delete store.ids[k];
  store.ids[id] = now;
  if (Object.keys(store.ids).length >= REC_SEEN_RESET_N) store.ids = { [id]: now };
  recSeenSave(store); recLastId = id;
}
function flipHost(){ return document.getElementById('flipFinder'); }
function initFlipFinder(){ const b = document.getElementById('btnFindFlip'); if (b) b.onclick = () => findFlip({ advance: false }); }
function renderFlipIdle(){
  const h = flipHost(); if (!h) return;
  h.innerHTML = `<button type="button" id="btnFindFlip" class="find-flip-btn">` +
    `<span class="ff-bolt" aria-hidden="true">${uiIcon('zap')}</span><span class="ff-label">Find me a flip</span></button>`;
  initFlipFinder();
}
function renderFlipState(kind){
  const h = flipHost(); if (!h) return;
  const msg = {
    loading: `<div class="cl-spinner"></div><span>Scanning for a clean, tax-safe flip…</span>`,
    empty: `<span class="ff-msg-txt">Nothing new clears the 2% tax in the top-traded items right now — try again shortly.</span><button class="fc-next" id="btnNextFlip">↻ Try again</button>`,
    moved: `<span class="ff-msg-txt">Prices moved since we found this — grab a fresh flip.</span><button class="fc-next" id="btnNextFlip">↻ Next</button>`,
    offline: `<span class="ff-msg-txt">Couldn't reach live prices. Check your connection.</span><button class="fc-next" id="btnNextFlip">↻ Retry</button>`
  }[kind];
  h.innerHTML = `<div class="flip-card ff-msg">${msg}</div>`;
  wireFlipButtons();
}
function flipCollapsed(){
  try {
    const v = localStorage.getItem(collapseKey('ge_flipCollapsed'));
    if (v === '1') return true;
    if (v === '0') return false;
    /* No explicit preference yet — collapsed, on every layout. This used to
       default open everywhere except the cramped mobile-landscape column;
       it is the tallest block in the sidebar when expanded, so starting it
       open pushed the favorites list down on exactly the first visit where
       a reader has no idea what any of it is yet. Collapsed still shows the
       pick and its score, which is the part worth glancing at. */
    return true;
  } catch (e) { return true; }
}
function setFlipCollapsed(v){ try { localStorage.setItem(collapseKey('ge_flipCollapsed'), v ? '1' : '0'); } catch (e) {} }
function renderFlipCard(rec){
  const h = flipHost(); if (!h) return;
  const collapsed = flipCollapsed();
  h.innerHTML = `
    <div class="flip-card${collapsed ? ' collapsed' : ''}" role="button" tabindex="0" data-id="${rec.id}" aria-label="Open ${rec.item.name} — recommended flip">
      <div class="fc-head">
        <span class="fc-kicker"><span class="fc-kicker-txt">Recommended flip</span></span>
        <div class="fc-head-ctrls">
          <button type="button" class="fc-next" id="btnNextFlip" title="Show another flip">↻ Next</button>
          <button type="button" class="fc-collapse calc-caret${collapsed ? ' closed' : ''}" id="btnFlipCollapse" aria-label="Collapse recommended flip" aria-expanded="${collapsed ? 'false' : 'true'}" title="Collapse / expand">${uiIcon('chev')}</button>
        </div>
      </div>
      <div class="fc-mini">
        <img class="fc-mini-icon" src="${itemIconUrl(rec.id)}" alt="" loading="lazy">
        <span class="fc-mini-name">${rec.item.name}</span>
        <span class="fc-mini-score" style="color:${rec.color}" title="${rec.verdict} — ${rec.flipScore}/100. Expand the card for the breakdown.">${rec.flipScore}<span class="fc-mini-score-k">${rec.verdictShort}</span></span>
      </div>
      <div class="fc-collapsible">
        <div class="fc-body">
          <img class="fc-icon" src="${itemIconUrl(rec.id)}" alt="${rec.item.name} icon" loading="lazy">
          <div class="fc-main">
            <div class="fc-name">${rec.item.name}</div>
            <div class="fc-why">${rec.why}</div>
          </div>
          <div class="fc-gauge">
            <button type="button" class="fc-score-btn" id="btnFlipScore" aria-label="How this flip score is calculated" aria-expanded="false">
              <div class="fc-score" style="color:${rec.color}">${rec.flipScore}</div>
              <div class="fc-verdict" style="color:${rec.color}">${rec.verdict}</div>
              <div class="fc-meter"><span style="width:${rec.flipScore}%;background:${rec.color}"></span></div>
            </button>
            ${flipScoreTip(rec)}
          </div>
        </div>
        <div class="fc-prices">
          <button type="button" class="fc-price buy" data-side="buy" title="Show the buy target line on the chart"><span class="fc-plabel">Buy @</span><span class="fc-pval">${fmtGp(rec.buy)}</span></button>
          <button type="button" class="fc-price sell" data-side="sell" title="Show the sell target line on the chart"><span class="fc-plabel">Sell @</span><span class="fc-pval">${fmtGp(rec.sell)}</span></button>
        </div>
        <div class="fc-stats">
          <div><span class="fc-slabel">Profit</span><span class="fc-sval pos">+${fmtGp(rec.edge)}</span></div>
          <div><span class="fc-slabel">Per 4h</span><span class="fc-sval pos">+${abbreviateNumber(rec.realizable)}</span></div>
          <div><span class="fc-slabel">Daily vol</span><span class="fc-sval">${abbreviateNumber(rec.vol)}</span></div>
        </div>
      </div>
    </div>`;
  wireFlipButtons();
}
/* Dismissal is bound once, not per render — wireFlipButtons runs on every
   Next / 5-min re-validate, so binding here would stack a listener per card.
   It re-queries the live tip each time instead of closing over one. */
(function wireFlipTipDismiss(){
  const close = () => {
    document.querySelectorAll('.fc-tip.open').forEach(t => {
      t.classList.remove('open');
      const b = t.parentElement && t.parentElement.querySelector('.fc-score-btn');
      if (b) b.setAttribute('aria-expanded', 'false');
    });
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.fc-score-btn, .fc-tip')) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  /* Fixed-position popups don't travel with their anchor, so dismiss rather
     than let one hang detached over the page. Capture phase catches the
     sidebar's own scroll, which doesn't bubble. */
  document.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
})();
/* Makes a section header row toggle its section, without swallowing the
   controls that live inside it. Everything interactive in these rows —
   Share, the help chip, Next, the chevron itself — is skipped, so the row
   only reacts to a click on its own dead space and its label. The chevron
   keeps its own handler; this just widens the target around it. */
function wireHeaderToggle(row, chevron, skipSel) {
  if (!row || !chevron || row.dataset.toggleWired) return;
  row.dataset.toggleWired = '1';
  row.classList.add('is-toggle');
  row.addEventListener('click', (ev) => {
    if (ev.target.closest(skipSel)) return;
    chevron.click();
  });
}
function wireFlipButtons(){
  const h = flipHost(); if (!h) return;
  const next = h.querySelector('#btnNextFlip');
  if (next) { next.disabled = recBusy; next.onclick = e => { e.stopPropagation(); track('recommended_flip_next'); findFlip({ advance: true }); }; }
  const card = h.querySelector('.flip-card[data-id]');
  /* Collapse toggle: hides the card body, leaving a one-line summary (name ·
     score · edge). Persisted so it stays collapsed across re-renders (Next,
     the 5-min re-validate) and page loads. */
  const col = h.querySelector('#btnFlipCollapse');
  if (col && card) {
    col.onclick = e => {
      e.stopPropagation();
      const isCollapsed = card.classList.toggle('collapsed');
      col.classList.toggle('closed', isCollapsed);
      col.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      setFlipCollapsed(isCollapsed);
      track('recommended_flip_toggle', { state: isCollapsed ? 'closed' : 'open' });
    };
    wireHeaderToggle(h.querySelector('.fc-head'), col, '#btnNextFlip, .fc-collapse, button, a');
  }
  /* Score explainer. Hover opens it on a mouse; click/tap toggles it, which is
     the only way in on touch. Every handler stops propagation because the whole
     card is a click target that navigates to the item — without that, reading
     the score would yank you onto the item page. */
  const scoreBtn = h.querySelector('#btnFlipScore');
  const tip = h.querySelector('#flipScoreTip');
  if (scoreBtn && tip) {
    /* Right-aligned to the score, below it — flipped above when the viewport
       bottom is closer than the popup is tall, and clamped inside both edges
       so a narrow phone can't push it off-screen. */
    const placeTip = () => {
      const r = scoreBtn.getBoundingClientRect();
      const w = tip.offsetWidth || 230, hgt = tip.offsetHeight || 0;
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      let top = r.bottom + 8;
      if (top + hgt > window.innerHeight - 8) top = r.top - hgt - 8;
      top = Math.max(8, Math.min(top, window.innerHeight - hgt - 8));
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    };
    const setTip = (open) => {
      if (open) placeTip();
      tip.classList.toggle('open', open);
      scoreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    /* A real mouse owns the open state via hover — letting it also toggle on
       click would close what the arriving pointer had just opened, with no way
       back until the pointer left and returned. Touch has no hover, so there
       the click IS the way in. Branch on the actual pointerType that produced
       the click rather than a hover media query: a coarse-pointer device can
       still report hover:hover, and keyboard-fired clicks report no pointer
       type at all, which correctly falls through to toggling. */
    let lastPointer = '';
    scoreBtn.onpointerdown = e => { lastPointer = e.pointerType || ''; };
    scoreBtn.onclick = e => {
      e.stopPropagation();
      if (lastPointer !== 'mouse') setTip(!tip.classList.contains('open'));
      lastPointer = '';
    };
    scoreBtn.onmouseenter = () => { if (matchMedia('(hover: hover)').matches) setTip(true); };
    /* Leaving the gauge (not just the button) so the pointer can travel from
       the number down into the popup without it closing underneath. */
    const gauge = scoreBtn.closest('.fc-gauge');
    if (gauge) gauge.onmouseleave = () => { if (matchMedia('(hover: hover)').matches) setTip(false); };
    tip.onclick = e => e.stopPropagation();
  }
  /* Buy @ / Sell @ drive the chart's target line, exactly like the Target Buy
     and Target Sell boxes above the chart — same activePriceBox state, so the
     two stay in sync and the card's own highlight mirrors the strip's. When
     the card is advertising an item the chart isn't showing, pick the side
     first and then open it, since nothing resets activePriceBox on load. */
  if (card) {
    const cardId = card.getAttribute('data-id');
    h.querySelectorAll('.fc-price[data-side]').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        activePriceBox = el.dataset.side;
        if (!selected || String(selected.id) !== String(cardId)) { openFlip(cardId); return; }
        updateSelection();
        queueDraw();
      };
    });
    updateSelection();   // paint the card's initial highlight from current state
  }
  if (card) {
    const id = card.getAttribute('data-id');
    card.onclick = (e) => { if (e.target.closest('.fc-score-btn, .fc-tip, .fc-price')) return; openFlip(id); };
    card.onkeydown = e => {
      if (e.target.closest && e.target.closest('.fc-score-btn, .fc-tip, .fc-price')) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFlip(id); }
    };
  }
}
function openFlip(id){
  const m = mapping.find(x => String(x.id) === String(id)); if (!m) return;
  setItem._userPicked = false; setItem(m);
  /* Only the stacked mobile layout needs to jump to the chart (the flip card
     lives below it there). On desktop the chart is already on screen and
     scrollIntoView just yanks the whole page down past the header. */
  if (window.innerWidth < 1024) {
    try { document.querySelector('.price-strip')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
  }
}
/* Re-check a buffered rec against the CURRENT live quote (0 API — reuses the
   stored series). Returns a freshly-priced rec if it still clears tax and is
   fillable, else null. */
function revalidateRec(rec){
  const node = latest?.data?.[rec.id];
  if (!node || !(node.low > 0) || !(node.high > 0)) return null;
  const eng = runTradeEngine(node.low, node.high, rec.series, node, rec.item.id);
  if (!eng.viable) return null;
  const fresh = buildRec({ item: rec.item, node, vol: dailyVolume(rec.item.id) }, eng);
  fresh.series = rec.series;
  return fresh;
}
/* ── First-load hand-off to the top recommended flip ──────────────────────
   A brand-new visitor now lands on a chart rather than an interstitial, and
   the best chart to land them on is the item the app itself is recommending.
   That number is not available in time to open on it: the top flip comes out
   of scanFlips(), which fetches a shortlist of timeseries, so waiting for it
   would hold the first paint hostage to several round trips. Instead the
   opening chart is still the biggest 24h mover (instant, already-loaded
   data), and this hands over to the flip the moment the scan lands.

   The guard is "is the app still showing exactly what boot chose", not
   setItem._userPicked — that flag is set to FALSE by nearly every navigation
   in the file (watchlist rows, the flip card, the bank, notifications), so it
   does not mean "the user has not interacted" and using it here would yank
   the chart out from under someone who had already clicked a favourite.
   Comparing the selected id to the one boot set catches every one of those
   paths without depending on what any of them chose to flag.

   Also one-shot and time-boxed: if the scan is slow enough that someone has
   started reading the chart, changing it is worse than not doing it. */
let _flipLandingFrom = null, _flipLandingUntil = 0;
function armFlipLanding(id) {
  _flipLandingFrom = id == null ? null : String(id);
  _flipLandingUntil = Date.now() + 12000;
}
function maybeLandOnFlip(rec) {
  const from = _flipLandingFrom;
  if (!from) return;
  _flipLandingFrom = null;                     // fires at most once, win or lose
  if (Date.now() > _flipLandingUntil) return;  // too late to be a hand-off
  if (!rec || !rec.item) return;
  if (!selected || String(selected.id) !== from) return;  // they moved on
  if (String(rec.id) === from) return;                    // already there
  setItem._userPicked = false;
  /* keepHomepage, same as the boot pick: this is still a bare "/" visit, so
     a crawl of the homepage must keep indexing the brand page rather than
     whichever flip happened to win this minute. */
  setItem(rec.item, { keepHomepage: true });
}
async function findFlip({ advance = false } = {}){
  if (recBusy) return;
  if (advance) {
    /* Walk forward through the pre-scanned look-ahead, re-validating each
       against fresh prices (0 API); show the first that still holds. Only when
       the buffer is exhausted (or every remaining rec went stale) do we scan. */
    while (recIdx + 1 < recBuffer.length) {
      const cand = revalidateRec(recBuffer[++recIdx]);
      if (cand) { recBuffer[recIdx] = cand; markRecSeen(cand.id); renderFlipCard(cand); return; }
    }
  }
  if (recLastWasEmpty && Date.now() - recLastScanAt < REC_SCAN_COOLDOWN) { renderFlipState('empty'); return; }
  recBusy = true; renderFlipState('loading');
  try {
    if (!latest?.data || !mapping.length) { renderFlipState('offline'); return; }
    let buf = await scanFlips();
    if (buf && !buf.length) buf = await scanFlips({ relax: true });
    recLastScanAt = Date.now();
    if (buf === null) { renderFlipIdle(); return; }
    recLastWasEmpty = !buf.length;
    if (!buf.length) { renderFlipState('empty'); return; }
    recBuffer = buf; recIdx = 0; markRecSeen(buf[0].id); renderFlipCard(buf[0]);
    maybeLandOnFlip(buf[0]);
  } catch (e) { renderFlipState('offline'); }
  finally { recBusy = false; const n = flipHost()?.querySelector('#btnNextFlip'); if (n) n.disabled = false; }
}
/* 0-API re-validation of the SHOWN card on the 5-min poll against fresh latest.
   Keeps the look-ahead buffer intact — each tail rec is re-validated when the
   user actually advances to it (see findFlip), so we don't throw away already
   engine-confirmed picks and force a needless re-scan on the next tap. */
function revalidateFlipCard(){
  if (recIdx < 0 || recIdx >= recBuffer.length) return;
  const h = flipHost(); if (!h || !h.querySelector('.flip-card[data-id]')) return;
  const fresh = revalidateRec(recBuffer[recIdx]);
  if (fresh) { recBuffer[recIdx] = fresh; renderFlipCard(fresh); }
  else renderFlipState('moved');
}
function resetFlipFinder(){
  recScanGen++; recBuffer = []; recIdx = -1; recLastId = null; recLastWasEmpty = false; renderFlipIdle();
  findFlip(); // always-open: immediately hunt a rec for the new universe
}
/* Always-open upkeep, called from the 5-min poll: keep a live card on screen.
   If one is showing, re-validate it against fresh prices (0 API calls); if the
   finder is sitting in an empty/moved/error state, quietly retry the scan. */
function ensureFlipCard(){
  const h = flipHost(); if (!h) return;
  if (h.querySelector('.flip-card[data-id]')) revalidateFlipCard();
  else if (!recBusy) findFlip();
}

/* ── Bank of Gielinor ─────────────────────────────────────────────────────
   Bank-tab style asset tracker. Each stack: { itemId, name, qty, cost
   (optional avg cost ea — only used to show appreciation if entered),
   alertPct (optional ± swing threshold for notifications), alertedDir }.
   Live value uses the insta-sell price net of the 2% GE liquidation tax.
   Persisted in localStorage. */
let portfolio = JSON.parse(localStorage.getItem('ge_portfolio') || '[]');
function savePortfolio() { try { localStorage.setItem('ge_portfolio', JSON.stringify(portfolio)); } catch (e) {} }

function pfMetrics(h) {
  const node = latest?.data?.[String(h.itemId)];
  const px = node?.high ?? node?.avgHighPrice ?? node?.low ?? h.cost ?? 0;
  const tax = calculateTax(px, h.itemId);
  const netEach = Math.max(0, px - tax);
  const value = netEach * h.qty;
  const hasCost = h.cost && h.cost > 0;
  const cost = hasCost ? h.cost * h.qty : 0;
  const pl = hasCost ? value - cost : 0;
  const plPct = hasCost && cost > 0 ? (pl / cost) * 100 : 0;
  return { px, value, cost, pl, plPct, hasCost };
}

function renderPortfolio() {
  let totalValue = 0, totalCost = 0, anyCost = false;
  portfolio.forEach(h => { const m = pfMetrics(h); totalValue += m.value; totalCost += m.cost; if (m.hasCost) anyCost = true; });
  const totalPL = totalValue - totalCost;
  const totalPctNum = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;
  const sign = totalPL > 0 ? '+' : '';
  const plCls = totalPL > 0 ? 'bk-totalpl-pos' : (totalPL < 0 ? 'bk-totalpl-neg' : '');
  /* Big "Total Wealth" headline. Growth row only shows when ≥1 stack has a
     cost basis entered — keeps the modal clean for users who just want a
     running bank value with no P&L tracking. */
  const growthRow = anyCost
    ? `<div class="bk-stat"><div class="bk-stat-label">Growth</div><div class="bk-stat-val ${plCls}">${sign}${abbreviateNumber(Math.round(totalPL))} (${sign}${totalPctNum.toFixed(1)}%)</div></div>
       <div class="bk-stat"><div class="bk-stat-label">Cost Basis</div><div class="bk-stat-val">${abbreviateNumber(Math.round(totalCost))}</div></div>`
    : `<div class="bk-stat"><div class="bk-stat-label">Stacks</div><div class="bk-stat-val">${portfolio.length}</div></div>
       <div class="bk-stat"><div class="bk-stat-label">Tip</div><div class="bk-stat-val" style="font-size:11px;color:var(--text-muted)">Add an avg cost to track growth</div></div>`;
  $('#pfStats').innerHTML = `
    <div class="bk-stat headline"><div class="bk-stat-label">Total Wealth</div><div class="bk-stat-val">${abbreviateNumber(Math.round(totalValue))} gp</div></div>
    ${growthRow}
  `;

  const holdingsEl = $('#pfHoldings');
  if (!portfolio.length) {
    holdingsEl.innerHTML = `<div class="bk-row empty">Empty bank. Pick an item, enter how many you hold, and tap Stash. Cost is optional — leave it blank if you just want to watch the bank value go up.</div>`;
    return;
  }
  /* Sort holdings by descending live value so the heaviest stacks sit on top. */
  const indexed = portfolio.map((h, i) => ({ h, i, m: pfMetrics(h) }))
                           .sort((a, b) => b.m.value - a.m.value);
  holdingsEl.innerHTML = indexed.map(({ h, i, m }) => {
    const s = m.pl > 0 ? '+' : '';
    const cls = m.pl > 0 ? 'pos' : (m.pl < 0 ? 'neg' : '');
    const sub = m.hasCost
      ? `${h.qty.toLocaleString()} @ ${abbreviateNumber(h.cost)} cost${h.alertPct ? ` · ±${h.alertPct}%` : ''}`
      : `${h.qty.toLocaleString()} held${h.alertPct ? ` · ±${h.alertPct}%` : ''}`;
    const plCol = m.hasCost
      ? `<span class="bk-pl ${cls}">${s}${m.plPct.toFixed(1)}%</span>`
      : `<span class="bk-pl">—</span>`;
    return `<div class="bk-row" data-idx="${i}">
      <img src="${itemIconUrl(h.itemId)}" alt="${h.name} icon" loading="lazy">
      <div style="overflow:hidden">
        <div class="bk-name">${h.name}</div>
        <div class="bk-sub">${sub}</div>
      </div>
      <span class="bk-val">${abbreviateNumber(Math.round(m.value))}</span>
      ${plCol}
      <button class="bk-del" data-idx="${i}" title="Remove">×</button>
    </div>`;
  }).join('');
  holdingsEl.querySelectorAll('.bk-del').forEach(b => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const idx = parseInt(b.getAttribute('data-idx'), 10);
      if (!Number.isFinite(idx)) return;
      portfolio.splice(idx, 1); savePortfolio(); renderPortfolio();
    };
  });
  /* Tap a row to jump to that item's chart. */
  holdingsEl.querySelectorAll('.bk-row[data-idx]').forEach(r => {
    r.onclick = () => {
      const idx = parseInt(r.getAttribute('data-idx'), 10);
      const h = portfolio[idx]; if (!h) return;
      const m = mapping.find(x => String(x.id) === String(h.itemId));
      if (m) { closePortfolio(); setItem._userPicked = false; setItem(m); }
    };
  });
}

function openPortfolio() {
  if (selected && !overMaxData[String(selected.id)]) {
    $('#pfItemIcon').src = itemIconUrl(selected.id);
    $('#pfItemIcon').alt = `${selected.name} icon`;
    $('#pfItemName').textContent = selected.name;
    const existing = portfolio.find(h => String(h.itemId) === String(selected.id));
    if (existing) {
      $('#pfQty').value = existing.qty.toLocaleString();
      $('#pfCost').value = existing.cost ? existing.cost.toString() : '';
      $('#pfAlert').value = existing.alertPct || '';
    }
  } else {
    $('#pfItemIcon').src = '';
    $('#pfItemName').textContent = 'Select an item first to add it';
  }
  $('#pfHint').textContent = 'Only qty is required — leave cost blank to just track current value of the stack.';
  $('#pfHint').classList.remove('error');
  renderPortfolio();
  $('#portfolioModal').style.display = 'flex';
  rlSync();
}
function closePortfolio() { $('#portfolioModal').style.display = 'none'; rlSync(); }

/* ── RuneLite bridge (PocketGE Flip Tracker plugin) ──────────────────────
   The plugin can serve this session on 127.0.0.1 (opt-in, loopback only —
   see github.com/grant9008/pocketge-flip-tracker). Once the user opts in (the Bank modal's Connect
   toggle), this polls in the BACKGROUND — not gated on that modal being
   open — because the whole point is that the site's own sidebar (Favorites
   in particular) stays live-linked to the plugin, not just a panel buried
   in a modal. Session profit / lifetime / portfolio value / recent flips
   still render inside the Bank modal (that's literally what it's for);
   Recommended Flip is deliberately NOT mirrored here — the sidebar already
   has its own live flip-finder, and showing a second, different
   recommendation from a different engine in a second place was confusing
   rather than useful. Browsers exempt loopback from mixed-content blocking
   (Safari being the holdout), and the plugin answers the CORS +
   Private-Network-Access preflight. */
const RL_BRIDGE_URL = 'http://127.0.0.1:8477';
/* 5s, not 15s. The poll used to only carry background state (profit,
   portfolio, favorites) where a quarter-minute of lag was invisible. It now
   also carries navRequest — the plugin asking THIS tab to open an item
   because you clicked a chart in game — and a click that takes up to
   fifteen seconds to do anything reads as broken. The payload is a loopback
   fetch of already-computed state (the plugin caches its bank composition
   rather than rebuilding it per request), so the extra ticks cost
   essentially nothing. */
const RL_POLL_MS = 5000;
let rlTimer = null;
let rlWanted = (() => { try { return localStorage.getItem('ge_rl_bridge') === '1'; } catch (e) { return false; } })();
let rlConnected = false;
/* Lowercased plugin list name -> { id, itemIds }. The plugin now serves
   ALL its favorite lists (see task #60's bridge protocol update), so
   merging happens per-list, matched by name against whichever local list
   is currently active — there's no single global "the" RuneLite list
   anymore. */
let rlFavoriteListsByName = new Map();
/* Last navRequest.seq we acted on. Starts null rather than 0 deliberately:
   the plugin keeps the most recent request in its payload so a dropped poll
   or a reload can't lose the click, which means the FIRST payload after
   connecting usually carries a stale one from earlier in the session.
   Acting on that would yank the page to some item you looked at an hour ago
   the moment you hit Connect. So the first payload only records the seq —
   navigation starts from the next increment. */
let rlLastNavSeq = null;
function rlMatchedFavIds() {
  const l = rlFavoriteListsByName.get(activeFavList().name.trim().toLowerCase());
  return l ? l.itemIds : [];
}
function rlAgeText(minutes) {
  if (minutes < 60) return minutes + ' min';
  const h = Math.floor(minutes / 60);
  if (h < 24) return h + (h === 1 ? ' hour' : ' hours');
  const d = Math.floor(h / 24);
  return d + (d === 1 ? ' day' : ' days');
}
function rlRenderModal(data) {
  const dot = $('#rlDot'), body = $('#rlBody');
  if (!dot || !body) return;
  if (!rlWanted) {
    dot.classList.remove('on');
    body.innerHTML = `<div class="rl-hint">Flip in-game? Install the <strong>PocketGE Flip Tracker</strong> RuneLite plugin, enable its "Local website bridge", then tap Connect — your live flips, portfolio value, and Favorites appear here (and your Favorites merge straight into the sidebar). Local-only: nothing leaves your computer.</div>`;
    return;
  }
  if (!data) {
    dot.classList.remove('on');
    body.innerHTML = `<div class="rl-hint">Waiting for RuneLite on this computer… Make sure the PocketGE Flip Tracker plugin is on and its <strong>Local website bridge</strong> setting is enabled (port 8477).</div>`;
    return;
  }
  dot.classList.add('on');
  const flips = (data.flips || []).slice(-8).reverse();
  const profit = Number(data.sessionProfit || 0);
  let html = `<div class="rl-profit" style="color:${profit >= 0 ? 'var(--rs-green-deep)' : 'var(--negative)'}">Session flip profit: ${profit >= 0 ? '+' : ''}${abbreviateNumber(profit)} gp</div>`;
  if (data.lifetimeProfit != null) {
    const lt = Number(data.lifetimeProfit);
    html += `<div class="rl-hint" style="margin:-4px 0 8px">Lifetime: ${lt >= 0 ? '+' : ''}${abbreviateNumber(lt)} gp</div>`;
  }
  if (data.portfolioValue != null && Number(data.portfolioValue) > 0) {
    html += `<div class="rl-hint" style="margin:-4px 0 8px">Portfolio value: <strong>${abbreviateNumber(Number(data.portfolioValue))} gp</strong> (cash + bank + inv + equipped + open offers)</div>`;
  }
  /* Liquid gp, shown separately from portfolio value because they answer
     different questions: net worth vs what you could actually put into an
     offer right now. It's also the number the plugin's own advisor sizes
     every buy against, so showing it makes its suggestions legible. */
  if (data.cash != null && Number(data.cash) > 0) {
    html += `<div class="rl-hint" style="margin:-4px 0 8px">Liquid cash: <strong>${abbreviateNumber(Number(data.cash))} gp</strong> (coins + platinum tokens, bank and inventory)</div>`;
  }
  if (data.bankSeen === false) {
    html += `<div class="rl-hint" style="margin:-4px 0 8px">Open your bank once in-game this session so the plugin can include it in your portfolio value — it can't read bank contents until it's been opened.</div>`;
  } else if (data.bankSeenAt) {
    /* "Seen" alone can't tell a bank read ten seconds ago from one read
       three hours and forty trades back — and portfolio value, the bank
       list below and the plugin's own sell suggestions are all exactly that
       stale. Saying so beats presenting an old snapshot as current. */
    const ageMin = Math.max(0, Math.round((Date.now() - Number(data.bankSeenAt)) / 60000));
    if (ageMin >= 5) {
      html += `<div class="rl-hint" style="margin:-4px 0 8px">Bank last read <strong>${rlAgeText(ageMin)}</strong> ago — open your bank in-game to refresh it.</div>`;
    }
  }
  const stacks = Array.isArray(data.bankStacks) ? data.bankStacks : [];
  if (stacks.length) {
    const top = stacks.slice(0, 8);
    const rest = stacks.length - top.length;
    html += `<div class="rl-hint" style="margin:8px 0 4px">Biggest bank stacks</div>`;
    html += top.map(b => `
      <div class="rl-flip" data-rl-item="${String(b.name || '').replace(/"/g, '&quot;')}" title="Open the live chart">
        <span class="rl-name">${escapeHtml(String(b.name || ''))} ×${Number(b.quantity || 0).toLocaleString()}</span>
        <span class="rl-nums">${b.value ? abbreviateNumber(Number(b.value)) + ' gp' : '—'}</span>
      </div>`).join('');
    if (rest > 0) {
      html += `<div class="rl-hint" style="margin:4px 0 0">+ ${rest.toLocaleString()} more ${rest === 1 ? 'stack' : 'stacks'}</div>`;
    }
  }
  html += `<div class="rl-hint" style="margin:-4px 0 8px">★ Any local list whose name matches one of your in-game lists is live-linked in the sidebar</div>`;
  if (!flips.length) {
    html += `<div class="rl-hint" style="margin-top:8px">Connected — waiting for your first completed flip.</div>`;
  } else {
    html += `<div class="rl-hint" style="margin:8px 0 4px">Recent flips</div>`;
    html += flips.map(f => `
      <div class="rl-flip" data-rl-item="${(f.itemName || '').replace(/"/g, '&quot;')}" title="Open the live chart">
        <span class="rl-name">${f.itemName} ×${Number(f.quantity).toLocaleString()}</span>
        <span class="rl-nums">${abbreviateNumber(Math.round(f.buySpent / f.quantity))} → ${abbreviateNumber(Math.round(f.sellGross / f.quantity))}
          <span class="${f.profit >= 0 ? 'pos' : 'neg'}">${f.profit >= 0 ? '+' : ''}${abbreviateNumber(f.profit)}</span></span>
      </div>`).join('');
  }
  body.innerHTML = html;
  body.querySelectorAll('[data-rl-item]').forEach(el => {
    el.onclick = () => {
      const name = el.getAttribute('data-rl-item');
      const item = mapping.find(x => x.name && x.name.toLowerCase() === name.toLowerCase());
      if (item) { closePortfolio(); setItem(item); }
    };
  });
}
function rlApply(data) {
  const wasConnected = rlConnected;
  rlConnected = !!data;
  const beforeMatch = rlMatchedFavIds().join(',');
  const newLists = new Map();
  if (data && Array.isArray(data.favoriteLists)) {
    data.favoriteLists.forEach(l => {
      if (!l || !l.name) return;
      const itemIds = Array.isArray(l.items) ? l.items.map(f => String(f.id)) : [];
      newLists.set(String(l.name).trim().toLowerCase(), { id: l.id, itemIds });
    });
  }
  rlFavoriteListsByName = newLists;
  rlHandleNavRequest(data && data.navRequest);
  rlRenderModal(data);
  if (rlConnected) rlReconcileFavorites();
  // Only re-render the (potentially large) watchlist when something it
  // actually depends on changed, not on every 15s poll tick.
  if (rlMatchedFavIds().join(',') !== beforeMatch || wasConnected !== rlConnected) {
    renderWatchlist();
  }
}
/* The plugin asking this tab to show an item, because a chart was clicked
   in game. It hands the request over instead of launching a browser: "open a
   link" is not "open a new tab" on every desktop — on some it navigates
   whatever tab has focus, so a chart click could take over something else
   entirely. If a PocketGE tab is already polling, it can just navigate
   itself.

   Deduped on the monotonic seq, not on presence: polling is at-least-once
   and the same request stays in the payload until a newer one replaces it. */
function rlHandleNavRequest(nav) {
  if (!nav || typeof nav.seq !== 'number') return;
  if (rlLastNavSeq === null) { rlLastNavSeq = nav.seq; return; } // see rlLastNavSeq
  if (nav.seq <= rlLastNavSeq) return;
  rlLastNavSeq = nav.seq;
  if (!mapping.length) return; // item list still loading; the next tick retries nothing, but neither does it misfire
  /* Match on id when the plugin knew one — names drift between the game and
     the wiki mapping (capitalisation, "(uncharged)" suffixes), ids don't. */
  let item = nav.itemId ? mapping.find(x => String(x.id) === String(nav.itemId)) : null;
  if (!item && nav.query) {
    const q = String(nav.query).trim().toLowerCase();
    item = mapping.find(x => x.name && x.name.toLowerCase() === q);
  }
  if (!item) return;
  closePortfolio();
  setItem(item);
}

/* Push the watchlist's order to the plugin so a drag here lands in game too.
   Sends the FULL order being displayed; the plugin resequences and never
   changes membership, so a list that is a poll out of date can't delete a
   favorite starred in game a second ago. Best-effort like every other write
   here — a dropped post just means the orders differ until the next drag. */
function rlPostOrder() {
  if (!rlWanted || !rlConnected) return;
  const matched = rlFavoriteListsByName.get(activeFavList().name.trim().toLowerCase());
  const body = { action: 'reorder', itemIds: (favorites || []).map(Number).filter(n => n > 0) };
  if (!body.itemIds.length) return;
  if (matched) body.listId = matched.id;
  fetch(RL_BRIDGE_URL + '/favoriteLists', {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => {});
}

/* Favorites built on the website BEFORE the plugin was ever connected never
   reach the plugin on their own — rlPostFavorite() only fires for NEW star
   clicks going forward, so a pre-existing list just silently never merges
   ("it's supposed to match my favorite list, but doesn't"). One-shot per
   page load: once a plugin list with a matching name is seen, push every
   local item that list is missing. Retries every poll (cheap, idempotent)
   until mapping has loaded, since this can race the boot() item-list fetch. */
let rlReconciled = false;
function rlReconcileFavorites() {
  if (rlReconciled || !mapping.length) return;
  rlReconciled = true;
  favoriteLists.forEach(l => {
    const matched = rlFavoriteListsByName.get(l.name.trim().toLowerCase());
    if (!matched) return;
    const have = new Set(matched.itemIds);
    (l.items || []).forEach(idStr => {
      if (have.has(idStr)) return;
      const item = mapping.find(x => String(x.id) === idStr);
      fetch(RL_BRIDGE_URL + '/favorites', {
        method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: Number(idStr), name: item ? item.name : '', remove: false, listId: matched.id })
      }).catch(() => {});
    });
  });
}
/* Push a favorite change TO the plugin so the link works both directions —
   star something here and it's added in-game too, not just the reverse.
   Best-effort: a dropped write just means it stays browser-only until the
   next successful one, same as any other opportunistic sync. When the
   active local list's name matches one of the plugin's lists, target that
   list specifically; otherwise the plugin falls back to whichever list is
   active in-game (same as before multi-list support existed). */
function rlPostFavorite(id, name, remove) {
  if (!rlWanted || !rlConnected) return;
  const matched = rlFavoriteListsByName.get(activeFavList().name.trim().toLowerCase());
  const body = { id: Number(id), name: name || '', remove: !!remove };
  if (matched) body.listId = matched.id;
  fetch(RL_BRIDGE_URL + '/favorites', {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => {});
}
async function rlPoll() {
  try {
    const res = await fetch(RL_BRIDGE_URL + '/flips', { cache: 'no-store', mode: 'cors' });
    if (!res.ok) throw new Error('bridge ' + res.status);
    rlApply(await res.json());
  } catch (e) {
    rlApply(null);
  }
}
/* Background poll whenever opted in — independent of the Bank modal being
   open, since the sidebar link is the whole point now, not just a modal
   panel. */
function rlSync() {
  const btn = $('#rlToggle');
  if (btn) btn.textContent = rlWanted ? 'Disconnect' : 'Connect';
  if (rlWanted) {
    if (!rlTimer) {
      rlRenderModal(null); // "waiting for RuneLite…" immediately; rlPoll() below fills in real data once the fetch settles
      rlPoll();
      rlTimer = setInterval(rlPoll, RL_POLL_MS);
    }
  } else if (rlTimer) {
    clearInterval(rlTimer); rlTimer = null;
    rlApply(null); // clears favorites merge + shows the "install the plugin" hint
  }
}
$('#rlToggle').onclick = () => {
  rlWanted = !rlWanted;
  try { localStorage.setItem('ge_rl_bridge', rlWanted ? '1' : '0'); } catch (e) {}
  rlSync();
};
// Resume the link on page load if the user was previously connected — no
// need to re-open the Bank modal and hit Connect again every visit.
rlSync();

/* Fire notifications when a stack's value crosses its ±% threshold vs cost.
   Only meaningful when a cost basis was entered. One alert per direction
   until the value returns inside the band. */
function firePortfolioAlerts() {
  if (!notifEnabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  let dirty = false;
  portfolio.forEach(h => {
    if (!h.alertPct || h.alertPct <= 0) return;
    if (!h.cost || h.cost <= 0) return;
    const m = pfMetrics(h);
    const up = m.plPct >= h.alertPct;
    const down = m.plPct <= -h.alertPct;
    const dir = up ? 'up' : (down ? 'down' : null);
    if (!dir) { if (h.alertedDir) { h.alertedDir = null; dirty = true; } return; }
    if (h.alertedDir === dir) return;
    const item = mapping.find(x => String(x.id) === String(h.itemId));
    try {
      const n = new Notification(`${up ? '📈' : '📉'} ${h.name} stack ${up ? 'up' : 'down'} ${Math.abs(m.plPct).toFixed(0)}%`, {
        body: `${h.qty.toLocaleString()} held · now worth ${abbreviateNumber(Math.round(m.value))} (${m.pl > 0 ? '+' : ''}${abbreviateNumber(Math.round(m.pl))})`,
        icon: itemIconUrl(h.itemId),
        tag: `pocketge-pf-${h.itemId}`
      });
      n.onclick = () => { try { window.focus(); n.close(); if (item) { setItem._userPicked = false; setItem(item); } } catch (e) {} };
    } catch (e) {}
    h.alertedDir = dir; dirty = true;
  });
  if (dirty) savePortfolio();
}

/* Notification Center — visibility + on/off + Bank threshold edit. The bell
   button opens this modal; nothing is configured per-favorite (favorites
   alert automatically — favoriting an item is itself the opt-in). Bank
   thresholds ARE per-item because they depend on the user's cost basis. */
function openNotifCenter() { renderNotifCenter(); $('#notifCenterModal').style.display = 'flex'; }
function closeNotifCenter() { $('#notifCenterModal').style.display = 'none'; }

function notifPermissionState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

async function setNotifMaster(on) {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (typeof Notification === 'undefined' || (isIOS && !isStandalone)) {
    if (isIOS) alert("To enable alerts on iPhone:\n\n1. Tap the Share button.\n2. Tap 'Add to Home Screen'.\n3. Open PocketGE from the home screen, then re-open this panel.\n\n(Apple only allows notifications from installed web apps.)");
    else alert("This browser does not support notifications. Try Chrome, Firefox, or Edge.");
    return false;
  }
  if (!on) {
    notifEnabled = false;
    localStorage.setItem('ge_notif', '0');
    applyNotifBtn();
    return false;
  }
  let perm = Notification.permission;
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch (e) { perm = 'denied'; }
  }
  if (perm === 'granted') {
    notifEnabled = true;
    localStorage.setItem('ge_notif', '1');
    applyNotifBtn();
    fireFavoriteAlerts();
    return true;
  }
  notifEnabled = false;
  localStorage.setItem('ge_notif', '0');
  applyNotifBtn();
  if (perm === 'denied') alert('Notifications were blocked. Enable them for pocketge.com in your browser settings.');
  return false;
}

function applyNotifBtn() {
  const btn = $("#btnNotif");
  if (!btn) return;
  const granted = notifPermissionState() === 'granted';
  const on = notifEnabled && granted;
  btn.classList.toggle('active', on);
  /* Preserve the desktop "Alerts" label — only swap the bell glyph. */
  const labelEl = btn.querySelector('.icon-label');
  const labelHTML = labelEl ? labelEl.outerHTML : '';
  btn.innerHTML = `<span>${uiIcon(on ? 'bell' : 'bellOff')}</span>${labelHTML}`;
  btn.title = on ? 'Notification Center (alerts ON)' : 'Notification Center (alerts off)';
}

function sendTestNotification() {
  if (!notifEnabled || notifPermissionState() !== 'granted') {
    alert('Turn on notifications first.');
    return;
  }
  try {
    const n = new Notification('🔔 PocketGE test alert', {
      body: 'If you can see this, browser notifications are working. Real alerts fire when a favorite breaks above/below its 24H or 5D extreme, or when a Bank stack crosses its ±% threshold.',
      icon: itemIconUrl(selected?.id || 12389),
      tag: 'pocketge-test'
    });
    n.onclick = () => { try { window.focus(); n.close(); } catch (e) {} };
  } catch (e) { alert('Test notification failed: ' + e.message); }
}

function renderNotifCenter() {
  const body = $('#notifCenterBody');
  if (!body) return;
  const perm = notifPermissionState();
  const masterChecked = notifEnabled && perm === 'granted';
  const permLabel = perm === 'unsupported' ? 'not supported by this browser'
                  : perm === 'granted' ? 'granted ✓'
                  : perm === 'denied' ? 'blocked — fix in browser settings'
                  : 'not yet requested';
  const permCls = perm === 'granted' ? 'granted' : perm === 'denied' ? 'denied' : '';

  const favItems = favorites
    .map(id => mapping.find(m => String(m.id) === String(id)))
    .filter(m => m && (membersOn || !m.members));
  const favHTML = favItems.length
    ? `<div class="nc-list">${favItems.map(m => `
        <div class="nc-row">
          <img src="${itemIconUrl(m.id)}" alt="${m.name} icon">
          <div class="nc-row-name-stack">
            <span class="nc-row-name">${m.name}</span>
            <span class="nc-row-caption">24H break + 5D break (auto)</span>
          </div>
        </div>`).join('')}</div>`
    : `<div class="nc-empty">No favorites yet — star an item from the search bar to start tracking it.</div>`;

  const bankItems = portfolio.filter(h => h && h.itemId);
  const bankHTML = bankItems.length
    ? `<div class="nc-list">${bankItems.map(h => {
        const pct = Number(h.alertPct) > 0 ? Number(h.alertPct) : 0;
        const caption = h.cost > 0
          ? (pct > 0 ? `Alerts when PnL crosses ±${pct}% of cost` : 'No alert — set ±% to arm')
          : 'No cost basis — alerts need a cost ea to compare against';
        return `
          <div class="nc-row" data-bk-id="${h.itemId}">
            <img src="${itemIconUrl(h.itemId)}" alt="${h.name} icon">
            <div class="nc-row-name-stack">
              <span class="nc-row-name">${h.name}</span>
              <span class="nc-row-caption">${caption}</span>
            </div>
            <input type="number" class="nc-pct-input" data-bk-pct="${h.itemId}" value="${pct || ''}" placeholder="0" min="0" max="999" ${h.cost > 0 ? '' : 'disabled'}>
            <span class="nc-pct-suffix">%</span>
          </div>`;
      }).join('')}</div>`
    : `<div class="nc-empty">No Bank stacks yet — add items via the 🪙 Bank button to set per-stack alerts.</div>`;

  body.innerHTML = `
    <div class="nc-section">
      <div class="nc-master">
        <div class="nc-master-row">
          <div>
            <div class="nc-master-label">Browser notifications</div>
            <div class="nc-master-state ${permCls}">Permission: ${permLabel}</div>
          </div>
          <label class="nc-toggle">
            <input type="checkbox" id="ncMasterToggle" ${masterChecked ? 'checked' : ''} ${perm === 'unsupported' ? 'disabled' : ''}>
            <span class="nc-toggle-slider"></span>
          </label>
        </div>
        <button type="button" class="nc-test-btn" id="ncTestBtn" ${masterChecked ? '' : 'disabled'}>Send test notification</button>
      </div>
    </div>

    <div class="nc-section">
      <div class="nc-section-title">Favorites Alerts</div>
      <p class="nc-section-desc">Every favorite below alerts you automatically when its live price breaks above its 24H high (or 5D high — flagged separately) or below its 24H/5D low. Favoriting an item is the opt-in; remove from favorites to stop alerting.</p>
      ${favHTML}
    </div>

    <div class="nc-section">
      <div class="nc-section-title">Bank Stacks Alerts</div>
      <p class="nc-section-desc">Per-stack threshold against your cost basis. Edit the ± % inline — set to 0 to mute that stack. Stacks without a cost ea can't alert (nothing to compare against).</p>
      ${bankHTML}
    </div>
  `;

  $('#ncMasterToggle').onchange = async (ev) => {
    await setNotifMaster(ev.target.checked);
    renderNotifCenter();
  };
  $('#ncTestBtn').onclick = sendTestNotification;
  body.querySelectorAll('input[data-bk-pct]').forEach(inp => {
    inp.onchange = () => {
      const id = inp.getAttribute('data-bk-pct');
      const h = portfolio.find(x => String(x.itemId) === String(id));
      if (!h) return;
      const raw = parseFloat(inp.value);
      h.alertPct = isNaN(raw) || raw < 0 ? 0 : Math.min(999, raw);
      h.alertedDir = null; // re-arm: threshold changed
      savePortfolio();
      renderNotifCenter();
    };
  });
}

/* The price axis's auto-fit, before yScale/yOffset are applied. Shared with
   the box-zoom, which has to know what the axis WOULD show for a candidate
   window in order to solve for the scale/offset that frame the dragged
   rectangle — if the two ever computed the buffer differently, a box zoom
   would land slightly off the box you drew. */
/* How far outside the plotted data a target may sit and still pull the y-range
   out to meet it. One definition, used by both the live chart and the share
   card, so a card can never draw a level the page refused to.

   The first cut of this was half the data span or 2% of price. Measured on a
   real 5D window it was 17.5 gp against a Swing Buy sitting 18 gp under the
   floor — a completely ordinary target, rejected by half a gp, and rejection
   means the line silently is not drawn. A swing buy is anchored BELOW every
   visible print by construction, so "just outside the data" is its normal
   position, not an anomaly.

   A full data span (or 8% of price, whichever is larger) covers that with
   room to spare while still rejecting what the bound is actually for: a
   stale or hand-typed level far from anything trading, which would squash
   the whole window into a sliver to reach. */
function targetFitSlack(dMin, dMax) {
  return Math.max((dMax - dMin) * 1.0, dMax * 0.08);
}
function fitPriceRange(vals) {
  let vmin = Math.min(...vals), vmax = Math.max(...vals);
  if (vmin === vmax) { vmin -= 1; vmax += 1; }
  const buffer = (vmax - vmin) * 0.05;
  return [vmin - buffer, vmax + buffer];
}

/* Scatter opacity. Sits here rather than inline so the "prints are level 4
   of the hierarchy" decision has one place to live. */
/* Scatter opacity, ramped by age across the visible window: the newest print
   is the one you're about to trade against, the oldest is context. A flat
   0.62 for everything went too far the other way from the original wall of
   confetti — the prints ended up about as quiet as the volume bars, which
   are two tiers below them. Recent trades read at full strength and the
   window's left edge sits at 0.40 — the first attempt used 0.80, and a
   1.25x spread across a whole screen is invisible: it just read as "all the
   same". 2.5x is a fade you can actually see, which is the point. The
   oldest prints are a day (or five years) behind the price you're about to
   trade at; they're context, and they now look like it. */
/* ── Chart view toggles ──────────────────────────────────────────────────
   Three independent visibility switches, not a mode enum: every one of them
   only decides whether a layer gets drawn. "Dots off" is what produces the
   line view — the connecting thread is already drawn faintly under the
   scatter, so turning the dots off and bringing that thread up to full
   strength IS the line chart, with no second rendering path to keep in sync.
   Stored globally rather than per layout (unlike the collapse prefs): this
   is a reading preference about the data, and it does not change meaning
   between a phone and a monitor.
   First-load config is dots ON, fill OFF, profile ON. The fill is the one
   that starts off: it is the biggest single block of colour on the chart,
   and without it the scatter and the trend line both read sharper on a
   first look. The profile starts on because it is the part nobody would
   think to go looking for. */
let chartFillOn = false, chartVProfOn = true;
(function loadChartPrefs() {
  try {
    const g = (k, d) => { const v = localStorage.getItem(k); return v === null ? d : v === '1'; };
    chartFillOn  = g('ge_chartFill', false);
    chartVProfOn = g('ge_chartVProf', true);
    /* The line view is gone (see the removed #ctDots button). Anyone who
       turned dots OFF has ge_chartDots='0' saved and would otherwise be
       stuck staring at a chart with no price series at all, so clear the
       key rather than leave a dead preference behind. */
    localStorage.removeItem('ge_chartDots');
  } catch (e) {}
})();
function wireChartTools() {
  const defs = [
    ['ctFill',  () => chartFillOn,  v => { chartFillOn  = v; }, 'ge_chartFill'],
    ['ctVol',   () => chartVProfOn, v => { chartVProfOn = v; }, 'ge_chartVProf'],
  ];
  for (const [id, get, set, key] of defs) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.setAttribute('aria-pressed', get() ? 'true' : 'false');
    btn.onclick = () => {
      const next = !get();
      set(next);
      btn.setAttribute('aria-pressed', next ? 'true' : 'false');
      try { localStorage.setItem(key, next ? '1' : '0'); } catch (e) {}
      queueDraw();
    };
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireChartTools);
else wireChartTools();

const DOT_ALPHA_OLD = 0.40;
const DOT_ALPHA_NEW = 1.0;
const dotAlphaAt = (i, n) => n > 1
  ? DOT_ALPHA_OLD + (DOT_ALPHA_NEW - DOT_ALPHA_OLD) * (i / (n - 1))
  : DOT_ALPHA_NEW;

function drawChart(series) {
  /* Draw in the exact space the bitmap was sized for (see resizeCanvas) —
     re-measuring the DOM here can disagree with a not-yet-resynced bitmap. */
  const W = chartCssW || canvas.clientWidth, H = chartCssH || canvas.clientHeight;
  /* Inner chart padding (y0 = top, x0 = left for y-axis labels, 15 = right,
     20 = bottom for x-axis labels). The top pad only needs to clear the
     target-price pill (16px, and it flips below its line when cramped) and
     the extreme-point orbs — the price boxes that once overlaid the chart
     top are gone, so anything more is dead space. The Target pill is 16px
     tall and can flip below its line when cramped, so 14-22px is plenty. */
  const y0 = Math.max(14, Math.min(22, Math.round(H * 0.035)));
  /* Axis column width; on portrait phones it moves to the RIGHT edge so the
     labels (and the drag-to-scale strip) sit under the thumb. */
  const axisW = W < 480 ? 38 : 45;
  const yRight = yAxisOnRight();
  const x0 = yRight ? 8 : axisW;
  const w = yRight ? (W - 8 - axisW) : (W - axisW - 15);
  const h = H - y0 - 20;
  ctx.clearRect(0, 0, W, H);

  if (!series || !series.labels.length) {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim();
    ctx.font = "13px BlinkMacSystemFont, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("No trade data for this timeframe — try a longer one.", W / 2, H / 2);
    return;
  }

  /* Real data is about to paint — retire the loading skeleton (first draw). */
  const clEl = document.getElementById('chartLoading');
  if (clEl && !clEl.classList.contains('hidden')) clEl.classList.add('hidden');

  const n = series.labels.length;
  const win = Math.max(20, Math.floor(n / zoom));
  offset = Math.max(0, Math.min(n - win, offset));
  const start = offset, end = start + win;
  const L = series.labels.slice(start, end);
  const LO = series.low.slice(start, end), HI = series.high.slice(start, end);
  const LOWVOL = series.lowVol.slice(start, end), HIGHVOL = series.highVol.slice(start, end);
  const VO = LOWVOL.map((lv, i) => lv + HIGHVOL[i]);
  const vals = [...LO, ...HI].filter(v => v != null);
  if (!vals.length) return;

  /* The active target has to be INSIDE the y-range, because the target line
     is clipped to the plot and simply vanishes when it is not — which is a
     silent failure in the one place the chart cannot afford one. A Swing Buy
     sits near the window's floor by construction, so on a falling item it
     lands just under the lowest visible print: at 5D on a -5% day the axis
     ran 386-420 with the target at 381, and the user saw a highlighted
     SWING BUY 381 box with no line anywhere on the chart and nothing saying
     why. The number the whole page is built around was the one thing not
     drawn.

     Bounded on purpose. The target joins the data in setting the range only
     while it is within half the data's own span of it; past that the chart
     would squash several days of price into a sliver to reach a level that
     is nowhere near trading, so the range stays put and the line gets an
     edge marker instead (see the activePrice block further down). Nudging a
     target with the +/- buttons moves it a gp at a time and will never
     approach that limit; a stale or hand-typed outlier can. */
  const _tgt = activePriceBox === 'buy' ? recommendedBuy : recommendedSell;
  if (_tgt != null && isFinite(_tgt)) {
    const dMin = Math.min(...vals), dMax = Math.max(...vals);
    const slack = targetFitSlack(dMin, dMax);
    if (_tgt >= dMin - slack && _tgt <= dMax + slack) vals.push(_tgt);
  }
  let [vmin, vmax] = fitPriceRange(vals);
  /* Manual axis scale (drag the price axis): stretch/squash the visible
     range around its midpoint. yScale > 1 flattens, < 1 amplifies. */
  if (yScale !== 1) {
    const midV = (vmin + vmax) / 2, halfV = (vmax - vmin) / 2 * yScale;
    vmin = midV - halfV; vmax = midV + halfV;
  }
  /* Then slide the whole window (drag the plot up/down). Applied after the
     scale so the pan is measured in the range you're actually looking at. */
  if (yOffset !== 0) {
    const shift = (vmax - vmin) * yOffset;
    vmin += shift; vmax += shift;
  }

  /* Fixed 12px of breathing room after the last point (enough for its 7px
     orb + ring) — a percentage margin turned into a ~70px dead gutter on
     wide charts. X-label density follows pixel width for the same reason
     a fixed count either crowds narrow charts or starves wide ones. */
  const dataW = w - 12;
  const linesX = Math.max(3, Math.min(9, Math.round(dataW / 170), L.length));
  const xStep = Math.max(1, Math.floor(L.length / linesX));
  const stepX = dataW / Math.max(1, (L.length - 1));

  /* price chart occupies the top 84%, volume bars the bottom 16%. The y-axis
     gridlines/labels must use h_price (not h) so the labels line up with where
     prices are actually plotted. */
  /* Below ~290px of plot the volume pane renders under 46px tall — too short
     to read as a chart of its own, while still taking a sixth of an already
     cramped price area. In landscape on a phone that left the price pane at
     ~195px, half the viewport. Under that threshold volume moves BEHIND the
     price as a translucent underlay instead: same information, none of the
     height cost, which is what TradingView does on compact layouts. Roomier
     plots keep the dedicated pane, where it reads better. */
  /* On a touch device the dedicated pane keeps a smaller share. Measured on
     a 390x844 phone the plot is 403px and the pane took 64 of them; the
     volume strip's job is comparative — which bars are taller than their
     neighbours — and that reads fine at 48px, while those 16px go to the
     part people actually came for. Desktop keeps 16%: it has 508px of plot
     and no reason to economise.
     Phone LANDSCAPE needs nothing here — at 252px it is already under the
     290px threshold and volume is drawn as an underlay, so the price pane
     is at 100% either way. This only moves portrait. */
  const volOverlay = h < 290;
  const volFrac = _coarseMQ.matches ? 0.12 : 0.16;
  const h_price = volOverlay ? h : h * (1 - volFrac);
  const h_vol   = volOverlay ? h * 0.28 : h * volFrac;
  const y0_vol  = volOverlay ? y0 + h - h_vol : y0 + h_price;

  chartData = { L, LO, HI, VO, vmin, vmax, stepX, dataW, x0, y0, h, H, W, win, n, h_price, axisW, yRight };

  let viewMaxHigh = -Infinity, viewMinLow = Infinity, viewMaxIdx = -1, viewMinIdx = -1;
  for (let i = 0; i < L.length; i++) {
    if (HI[i] != null && HI[i] > viewMaxHigh) { viewMaxHigh = HI[i]; viewMaxIdx = i; }
    if (LO[i] != null && LO[i] < viewMinLow) { viewMinLow = LO[i]; viewMinIdx = i; }
  }
  const recStart = Math.max(0, Math.floor(L.length * 0.75));
  let recHiVal = -Infinity, recHiIdx = -1, recLoVal = Infinity, recLoIdx = -1;
  for (let i = recStart; i < L.length; i++) {
    if (HI[i] != null && HI[i] > recHiVal) { recHiVal = HI[i]; recHiIdx = i; }
    if (LO[i] != null && LO[i] < recLoVal) { recLoVal = LO[i]; recLoIdx = i; }
  }
  chartData.markers = [viewMaxIdx, viewMinIdx, recHiIdx, recLoIdx].filter(i => i >= 0);
  /* Label each special marker so the tooltip can name it ("Period High",
     "Recent Low", etc.) when the user taps/hovers an orb. Period extremes
     (solid white-centre dots) take precedence over recent extremes (hollow
     rings) if they happen to land on the same point. */
  chartData.markerLabels = {};
  if (recHiIdx >= 0) chartData.markerLabels[recHiIdx] = { text: 'Recent High', color: 'var(--sell-color)', shape: 'hollow' };
  if (recLoIdx >= 0) chartData.markerLabels[recLoIdx] = { text: 'Recent Low', color: 'var(--buy-color)', shape: 'hollow' };
  if (viewMaxIdx >= 0) chartData.markerLabels[viewMaxIdx] = { text: 'Period High', color: 'var(--sell-color)', shape: 'solid' };
  if (viewMinIdx >= 0) chartData.markerLabels[viewMinIdx] = { text: 'Period Low', color: 'var(--buy-color)', shape: 'solid' };

  ctx.lineWidth = 1;
  /* Round y-axis ticks (2,600 / 2,700 …) instead of raw data-derived values
     so prices anchor on human numbers. */
  const axisFontPx = W >= 800 ? 12 : 10;
  ctx.font = `${axisFontPx}px BlinkMacSystemFont, sans-serif`; ctx.textAlign = yRight ? "left" : "right"; ctx.textBaseline = "middle";
  const mutedTickCol = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim();
  /* Tick density follows the plot's pixel height (one label per ~60px) so a
     tall desktop chart gets more price levels instead of 5 labels floating
     in empty space, while short mobile charts stay uncluttered. */
  /* Target ~1 label per 40 px of plot height (was 60). Combined with the
     snap-down step, a 500-px tall desktop chart gets ~12 labels instead
     of 7, and a 300-px mobile chart still stays uncluttered at ~7. */
  const yTicks = niceTicks(vmin, vmax, Math.max(5, Math.min(14, Math.round(h_price / 40))));
  /* The gap between gridlines is what decides how many decimals a label needs
     to stay distinct from its neighbour — see fmtYAxis. */
  const yTickStep = yTicks.length > 1 ? Math.abs(yTicks[1] - yTicks[0]) : 0;
  for (const v of yTicks) {
    if (v < vmin || v > vmax) continue;
    const y = ypx(v, vmin, vmax, y0, h_price);
    ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); ctx.stroke();
    ctx.fillStyle = mutedTickCol;
    ctx.fillText(fmtYAxis(v, yTickStep), Math.round(yRight ? x0 + w + 6 : x0 - 6), Math.round(y));
  }

  /* x-axis label granularity adapts to the visible time span: intraday → time,
     up to ~6 months → month/day, up to ~2 years → month/year, longer → year. */
  const spanSec = L.length > 1 ? (L[L.length - 1] - L[0]) : 0;
  const mutedCol = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim();
  const fmtAxis = (t) => {
    const d = new Date(t * 1000);
    if (spanSec <= 2 * 86400) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (spanSec <= 180 * 86400) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
  };
  ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = mutedCol;
  /* Gridlines are drawn as we go, but labels are gathered and drawn after, so
     each one can be measured against the canvas and its neighbour.
     Centred text over a tick sitting at the plot's left edge runs half off the
     canvas — x0 is only 8px on the y-axis-right layout, so anything wider than
     16px lost its left half. That clipped the FIRST label on every timeframe:
     "2021" showed as "021", "Aug 25" as "ug 25", "10:35 AM" as "35 AM". */
  const axisLabels = [];
  if (spanSec > 730 * 86400) {
    /* multi-year span: put one tick + label at the first point of each calendar
       year so the year labels line up with the actual year boundaries. */
    const startsOnYearBoundary = (() => {
      const d = new Date(L[0] * 1000);
      return d.getMonth() === 0 && d.getDate() <= 15;
    })();
    let lastYear = null;
    for (let i = 0; i < L.length; i++) {
      const yr = new Date(L[i] * 1000).getFullYear();
      if (yr === lastYear) continue;
      lastYear = yr;
      const x = x0 + i * stepX;
      ctx.strokeStyle = "rgba(255,255,255,0.03)"; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h); ctx.stroke();
      /* i === 0 is wherever the series happens to start, which for a 5Y window
         is mid-year — labelling it plants a year marker a fraction of a year
         from the next one, and that uneven first gap is what made the 5Y axis
         look mis-spaced. Every other label is a real January boundary, so
         dropping this one leaves them evenly spaced. Kept when the window
         genuinely does open on a year boundary. */
      if (i > 0 || startsOnYearBoundary) axisLabels.push({ x, text: String(yr) });
    }
  } else {
    let lastAxisLabel = null;
    for (let i = 0; i < L.length; i += xStep) {
      const x = x0 + i * stepX;
      ctx.strokeStyle = "rgba(255,255,255,0.03)"; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h); ctx.stroke();
      const dateStr = fmtAxis(L[i]);
      if (dateStr !== lastAxisLabel) { axisLabels.push({ x, text: dateStr }); lastAxisLabel = dateStr; }
    }
  }
  const axisLabelY = Math.round(y0 + h + 4);
  let prevLabelRight = -Infinity;
  for (const lab of axisLabels) {
    const half = ctx.measureText(lab.text).width / 2;
    const cx = Math.min(Math.max(lab.x, half + 2), W - half - 2);
    /* Nudging a label inward can push it into its neighbour; skip rather than
       overprint. Only the edge labels ever move, so this rarely fires. */
    if (cx - half < prevLabelRight + 6) continue;
    ctx.fillText(lab.text, Math.round(cx), axisLabelY);
    prevLabelRight = cx + half;
  }

  const buyColor = getComputedStyle(document.documentElement).getPropertyValue('--buy-color').trim();
  const sellColor = getComputedStyle(document.documentElement).getPropertyValue('--sell-color').trim();

  /* Long-range historical data (1Y / 5Y) is a single daily price — insta-buy
     and insta-sell are equal — so the two-tone buy/sell scheme is meaningless
     and the gold dots simply paint over the teal, leaving one misleading
     color. Detect that and render both series in a neutral "price" color so
     the chart honestly reads as historical price rather than all-buy. */
  let bothCount = 0, eqCount = 0;
  for (let i = 0; i < L.length; i++) {
    if (LO[i] != null && HI[i] != null) { bothCount++; if (Math.abs(HI[i] - LO[i]) < 1e-9) eqCount++; }
  }
  const singlePrice = bothCount > 0 && eqCount / bothCount > 0.9;

  /* Aggregated two-tone volume bars. Painting one thin bar per data point
     turned the strip into a dense noise band on 5D/1M/6M; grouping into
     ~14px-wide chunks (~60 bars max) makes each bar a readable "period"
     instead. Split by side: LOWVOL (traded at the low price = insta-sells)
     stacks at the bottom in gold, HIGHVOL (traded at the high price =
     insta-buys) stacks above in teal — so the bar shows both total volume
     and which side drove it. Colors match the price dots directly above
     so the eye reads them as the same series, not as new information.
     Hoisted into a function so it can run either BEFORE the price series
     (overlay mode, so the bars sit behind it) or after (paned mode). */
  function drawVolumeBars(alpha) {
    /* Aim for ~14px between bars. groupSize = ceil(14/stepX): if points are
       already ≥14 px apart (short views), no aggregation; on 6M/1Y where
       stepX shrinks to 2–3 px, groups of 5–7 points become one chunky bar. */
    const targetBarPx = 14;
    const groupSize = Math.max(1, Math.round(targetBarPx / Math.max(0.5, stepX)));
    const groups = [];
    for (let i = 0; i < L.length; i += groupSize) {
      let sumLow = 0, sumHigh = 0, count = 0, jEnd = Math.min(i + groupSize, L.length);
      for (let j = i; j < jEnd; j++) {
        if (LOWVOL[j] != null) sumLow += LOWVOL[j];
        if (HIGHVOL[j] != null) sumHigh += HIGHVOL[j];
        if (LOWVOL[j] != null || HIGHVOL[j] != null) count++;
      }
      if (count === 0) continue;
      const cx = x0 + (i + (jEnd - i - 1) / 2) * stepX;
      groups.push({ cx, sumLow, sumHigh });
    }
    if (!groups.length) return;
    const maxGroupVol = Math.max(1, ...groups.map(g => g.sumLow + g.sumHigh));
    const groupPx = groupSize * stepX;
    const barWidth = Math.max(2, groupPx * 0.72);
    const gapPx = 1; // hairline gap between the two-side stack, so they read as separate
    const gold = `rgba(229, 184, 66, ${alpha})`, teal = `rgba(38, 169, 171, ${alpha})`;
    for (const g of groups) {
      const totalH = ((g.sumLow + g.sumHigh) / maxGroupVol) * h_vol;
      if (totalH < 0.5) continue;
      const lowH = (g.sumLow / maxGroupVol) * h_vol;
      const highH = (g.sumHigh / maxGroupVol) * h_vol;
      const x = g.cx - barWidth / 2;
      const baseY = y0_vol + h_vol;
      if (singlePrice) {
        /* Single-price historical (5Y): the "insta-sell / insta-buy" split
           is meaningless, so paint one unified teal bar matching the price
           line/area above. Prevents the all-gold band that looked broken. */
        ctx.fillStyle = teal;
        ctx.fillRect(x, baseY - Math.max(lowH, highH, totalH), barWidth, Math.max(lowH, highH, totalH));
      } else {
        /* Insta-sells (gold) at the bottom, insta-buys (teal) above — same
           gold/teal identity as the price dots the volume corresponds to. */
        if (lowH > 0.3) {
          ctx.fillStyle = gold;
          ctx.fillRect(x, baseY - lowH, barWidth, lowH);
        }
        if (highH > 0.3) {
          const stackedY = baseY - lowH - (lowH > 0.3 ? gapPx : 0) - highH;
          ctx.fillStyle = teal;
          ctx.fillRect(x, stackedY, barWidth, highH);
        }
      }
    }
  }
  /* Overlay mode paints them first and faint, so they read as background
     texture the price line sits on top of rather than a second series
     competing with it. */
  if (volOverlay) drawVolumeBars(0.16);

  /* With a manual y-scale < 1 the data range exceeds the plot — clip every
     price layer to the price area so amplified swings can't paint over the
     volume strip or the axis labels. */
  ctx.save();
  ctx.beginPath(); ctx.rect(x0 - 1, y0 - 9, w + 2, h_price + 12); ctx.clip();

  /* ── Volume profile ────────────────────────────────────────────────────
     How much volume traded at each PRICE, rather than at each moment — the
     volume strip below already answers "when". Buckets the visible window by
     price level and draws one horizontal bar per bucket, anchored to
     whichever edge the y-axis is on so it reads as an extension of the price
     scale rather than a second chart floating in the plot.
     Deliberately neutral white, not gold or teal. Every other colour on this
     chart means buy-side, sell-side or profit, and this bar means none of
     those — it is the same volume counted from both sides. Capped at a fifth
     of the plot width and drawn before everything else inside the clip, so
     it stays behind the price data rather than competing with it.
     The one bar that gets extra weight is the busiest level, which is the
     question people actually open this for: where did the trading happen. */
  if (chartVProfOn && vmax > vmin) {
    const NB = Math.max(12, Math.min(30, Math.round(h_price / 12)));
    const buckets = new Array(NB).fill(0);
    const put = (price, vol) => {
      if (price == null || !(vol > 0)) return;
      const t = (price - vmin) / (vmax - vmin);
      if (t < 0 || t > 1) return;
      buckets[Math.min(NB - 1, Math.floor(t * NB))] += vol;
    };
    for (let i = 0; i < L.length; i++) { put(HI[i], HIGHVOL[i]); put(LO[i], LOWVOL[i]); }
    const maxV = Math.max(...buckets);
    if (maxV > 0) {
      /* 15% of the plot, down from 20%. The profile is context for the
         price data, and at a fifth of the width the longest bars were
         reaching far enough in to look like a second chart. */
      const maxLen = w * 0.15;
      const bandH = h_price / NB;
      /* The real reason this read as a solid wedge rather than a profile,
         and it was not the fill alpha. At bandH-1 the bars covered ~93% of
         their band vertically — on a 440px pane that is 30 bars of ~14px
         separated by a single pixel, which the eye merges into one mass no
         matter how translucent each one is. At 72% they read as separate
         rungs, and the gaps let the gridlines through, which is most of
         what makes it feel like a layer behind the chart. */
      const barH = Math.max(1, Math.min(bandH - 3, bandH * 0.72));
      const poc = buckets.indexOf(maxV);
      ctx.save();
      /* ── Point of Control, extended across the plot ────────────────────
         The busiest price level was already marked inside the profile, but
         only inside it — the profile occupies the right-hand 15% of the
         plot, so the one number people open a volume profile FOR was
         readable in a strip and nowhere else. You could see that a level
         was busiest without being able to see where the last three days of
         price sat relative to it, which is the entire use of knowing.
         Extending it turns it into what TradingView calls the POC line: a
         reference the price is measured against rather than a fact about
         the profile.

         Drawn as a BAND, not a hairline, because that is what the number
         honestly is. The profile buckets prices — the POC is a range one
         bucket tall, not an exact gp value — so a 1px line would claim a
         precision the calculation does not have. The band is the bucket,
         at the same height as its own bar so the two read as one object.

         Neutral grey at very low alpha, for the same reason the profile is
         white: gold means buy, teal means sell, green means profit, and
         this is volume counted from both sides, so it must not borrow any
         of them. It sits behind everything inside the price clip — the
         hairline centre is the only part with enough contrast to find, and
         at 0.20 it is still below the gridline-to-data step, so scanning
         the dots never has to compete with it. */
      {
        const pocTop = y0 + h_price - (poc + 1) * bandH + (bandH - barH) / 2;
        const pocMid = Math.round(y0 + h_price - (poc + 0.5) * bandH);
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        ctx.fillRect(x0, pocTop, w, barH);
        /* Integer y and a 1px fillRect rather than a stroke: a stroked line
           at a half-pixel offset renders as two grey rows on a HiDPI canvas,
           which at this alpha reads as a smudge instead of a level. */
        ctx.fillStyle = 'rgba(255,255,255,0.20)';
        ctx.fillRect(x0, pocMid, w, 1);
        /* Deliberately unlabelled. A "POC" tag was the one piece of jargon on
           a chart that otherwise names things in plain words, and it sat in
           the plot as a fourth text object competing with the Target badge,
           the axis and the legend. The line already reads as a level, and it
           visibly meets the longest bar in the profile — which is the
           explanation, drawn rather than written. */
      }
      /* One fill weight for every bar, including the busiest. The POC used
         to be a heavier BLOCK (0.16 against 0.06), which is what made the
         profile read as slabs sitting on the chart instead of a layer behind
         it — a filled rectangle gains weight with its whole area, so the
         moment you raise its alpha to mark it you have also made it the
         densest object in the plot. The mark moved to the bar's leading
         EDGE, which is one pixel wide: it can run bright enough to find at a
         glance without adding any mass.
         The leading edge is the end pointing INTO the plot, which flips with
         the y-axis. On portrait the axis is on the right and bars grow
         leftward, so the sharp end is their left one. */
      const EDGE = 'rgba(255,255,255,0.22)', EDGE_POC = 'rgba(255,255,255,0.55)';
      for (let k = 0; k < NB; k++) {
        if (buckets[k] <= 0) continue;
        const len = (buckets[k] / maxV) * maxLen;
        if (len < 0.5) continue;
        /* Bucket 0 is the BOTTOM of the price range, and y grows downward. */
        const yTop = y0 + h_price - (k + 1) * bandH;
        const bx = yRight ? (x0 + w - len) : x0;
        const by = yTop + (bandH - barH) / 2;
        /* The busiest level keeps the 0.08 fill; every other bar drops to
           0.05, so the profile reads as one lit rung against a field of
           context rather than a uniform comb. The edges below still give
           every bar a definite end, which is what stops the lighter fill
           reading as unfinished. */
        ctx.fillStyle = k === poc ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.05)';
        ctx.fillRect(bx, by, len, barH);
        ctx.fillStyle = k === poc ? EDGE_POC : EDGE;
        ctx.fillRect(yRight ? bx : bx + len - 1, by, 1, barH);
        /* The point of control gets closed off top and bottom too, so it
           reads as one outlined level rather than just a brighter tip. */
        if (k === poc) {
          ctx.fillStyle = 'rgba(255,255,255,0.30)';
          ctx.fillRect(bx, by, len, 1);
          ctx.fillRect(bx, by + barH - 1, len, 1);
        }
      }
      ctx.restore();
    }
  }
  /* Spread band — a soft translucent fill between the buy-low envelope and
     the sell-high envelope, giving the chart a modern "channel" feel without
     adding noise. Each consecutive pair of points contributes a slim
     quadrilateral; gaps in the data cleanly skip. Drawn first so dots and
     markers paint on top. */
  if (chartFillOn) {
    ctx.save();
    /* The band between buy-low and sell-high IS the margin, drawn over time —
       the app's hero metric. Kept subtle but actually visible now (was 0.07,
       basically invisible). Switchable from the toolbar because on a sharp
       move this column gets tall, and some readers would rather see the
       gridlines through it. */
    ctx.fillStyle = "rgba(38, 169, 171, 0.13)";
    let segStart = -1;
    for (let i = 0; i <= L.length; i++) {
      const valid = i < L.length && LO[i] != null && HI[i] != null;
      if (valid && segStart < 0) segStart = i;
      if ((!valid || i === L.length) && segStart >= 0 && i - segStart >= 2) {
        ctx.beginPath();
        const xs = (k) => x0 + k * stepX;
        ctx.moveTo(xs(segStart), ypx(HI[segStart], vmin, vmax, y0, h_price));
        for (let k = segStart + 1; k < i; k++) ctx.lineTo(xs(k), ypx(HI[k], vmin, vmax, y0, h_price));
        for (let k = i - 1; k >= segStart; k--) ctx.lineTo(xs(k), ypx(LO[k], vmin, vmax, y0, h_price));
        ctx.closePath();
        ctx.fill();
        segStart = -1;
      } else if (!valid) {
        segStart = -1;
      }
    }
    ctx.restore();
  }

  /* Wall lines were removed — they re-stated signals the chart already
     showed (the Target line marks where to act; the EMA shows trend; dot
     density already reveals clusters as flat tops/bottoms; period high/low
     markers flag the extremes). They also required constant gating against
     stale clusters and contradiction with the target. Net: decoration, not
     signal. The findVolumeWall helper is kept in case we ever want to bring
     back a more focused "highlight the actual cluster prints" treatment, but
     nothing on the chart uses it right now. */

  /* Dots-only scatter (no connecting line — that was scribbling on dense 1D
     charts). The volume needles above carry the "where did big trades happen"
     signal; here we just plot every print clean and small. */
  /* drawLineSeries lived here — the line view's renderer. Deleted with the
     toggle rather than left dead: nothing else called it, and keeping a
     working implementation of a view we removed on purpose invites it back. */
  function drawSeries(arr, color, isHigh) {
    /* Radius is tied to the SPACING between prints, tightly clamped.
       Blobbing is a density problem and a fixed radius cannot solve it: at
       1D the points sit ~3.3px apart, so a 2.5px radius draws 5px-wide dots
       that overlap by 1.7px each and fuse into one solid ribbon — worst on
       the teal highs, which cluster tighter than the lows. Sizing at 0.42x
       the spacing keeps the diameter just inside the gap, so dense stretches
       read as separate prints again.
       The clamp is what keeps this honest: an earlier version scaled freely
       and ran 1.8px on 1D against 3.5px on 6M, which looked like a different
       chart per timeframe. 1.5-2.4 is a narrow enough band that switching
       timeframes doesn't read as a style change, while still giving zoomed-in
       views the bigger, easier targets they have room for. */
    const dotR = Math.max(1.5, Math.min(2.4, stepX * 0.42));
    /* Alpha ramps with recency (see dotAlphaAt) so the busy left-hand history
       recedes without the tradeable right-hand edge having to. */
    ctx.save();
    ctx.fillStyle = color;
    const n = arr.length;
    for (let i = 0; i < n; i++) {
      if (arr[i] == null) continue;
      ctx.globalAlpha = dotAlphaAt(i, n);
      const x = x0 + i * stepX, y = ypx(arr[i], vmin, vmax, y0, h_price);
      ctx.beginPath(); ctx.arc(x, y, dotR, 0, Math.PI * 2); ctx.fill();
    }
    /* Period extremes after the scatter and at full strength — a tier up the
       hierarchy, so they opt out of the ramp entirely. Drawn here rather
       than inside the loop so the loop stays one job. */
    const extIdx = isHigh ? viewMaxIdx : viewMinIdx;
    if (extIdx >= 0 && arr[extIdx] != null) {
      const x = x0 + extIdx * stepX, y = ypx(arr[extIdx], vmin, vmax, y0, h_price);
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = color; ctx.globalAlpha = 0.9; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.globalAlpha = 1; ctx.fill();
    }
    ctx.restore();
  }
  /* Single-price historical (1Y/5Y where buy === sell daily) → SAME visual
     language as the intraday scatter, so switching timeframes doesn't feel
     like landing on a different product: teal dots at the regular dot size
     (sampled to the same on-screen cadence — daily points at 0.5 px apart
     would smear into a rope), a faint teal thread underneath carrying every
     spike between sampled dots, the usual soft band-tone underfill, and the
     shared white EMA trend on top. Period high/low halos anchor extremes. */
  if (singlePrice) {
    const xs = (k) => x0 + k * stepX;
    ctx.save();
    /* Underfill at the SAME tone as the spread band on intraday views
       (0.13 → fade), not the heavy 0.28 area fill that read off-brand. */
    const grad = ctx.createLinearGradient(0, y0, 0, y0 + h_price);
    /* Halved. On a sharp move the band between lows and highs gets tall, and
       at 0.13 that column read as a solid teal wall that swallowed the dots
       and gridlines behind it — the fill is meant to say "this is the traded
       band", not to hide what's inside it. */
    grad.addColorStop(0, chartFillOn ? 'rgba(38, 169, 171, 0.065)' : 'rgba(0,0,0,0)');
    grad.addColorStop(1, chartFillOn ? 'rgba(38, 169, 171, 0.005)' : 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    let started = false, firstX = 0, lastX = 0;
    for (let i = 0; i < HI.length; i++) {
      if (HI[i] == null) continue;
      const x = xs(i), y = ypx(HI[i], vmin, vmax, y0, h_price);
      if (!started) { ctx.moveTo(x, y0 + h_price); ctx.lineTo(x, y); started = true; firstX = x; }
      else ctx.lineTo(x, y);
      lastX = x;
    }
    if (started) {
      ctx.lineTo(lastX, y0 + h_price);
      ctx.lineTo(firstX, y0 + h_price);
      ctx.closePath();
      ctx.fill();
    }
    /* Faint thread through every print — keeps spikes honest between the
       sampled dots without reading as a bold "line chart" line. */
    ctx.strokeStyle = 'rgba(38, 169, 171, 0.35)'; ctx.lineWidth = 1; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    started = false;
    for (let i = 0; i < HI.length; i++) {
      if (HI[i] == null) { started = false; continue; }
      const x = xs(i), y = ypx(HI[i], vmin, vmax, y0, h_price);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    /* Dots at the familiar size/color, one per ~4.5 px of track — and the
       same recency ramp as the intraday scatter, so 1Y/5Y don't read louder
       or quieter than the timeframes either side of them. */
    const idxStep = Math.max(1, Math.round(4.5 / Math.max(0.1, stepX)));
    ctx.fillStyle = sellColor;
    for (let i = 0; i < HI.length; i += idxStep) {
      if (HI[i] == null) continue;
      ctx.globalAlpha = dotAlphaAt(i, HI.length);
      ctx.beginPath(); ctx.arc(xs(i), ypx(HI[i], vmin, vmax, y0, h_price), 2.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    /* Period high / low halos — drawn as standalone marks instead of
       riding on the (now-absent) dot scatter, so the extremes still stand
       out against the line. */
    const drawHalo = (idx, halo) => {
      if (idx < 0 || HI[idx] == null) return;
      const x = xs(idx), y = ypx(HI[idx], vmin, vmax, y0, h_price);
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = halo; ctx.globalAlpha = 0.9; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.globalAlpha = 1; ctx.fill();
      ctx.restore();
    };
    drawHalo(viewMaxIdx, sellColor);
    drawHalo(viewMinIdx, buyColor);
  } else {
    drawSeries(HI, sellColor, true);
    drawSeries(LO, buyColor, false);
  }

  /* Smoothed mid-price trend line (EMA over (buy+sell)/2). Replaces the old
     straight linear-regression line — it shows the actual SHAPE of the move,
     not just net drift, while a single smoothed curve avoids the "scribble"
     that a raw connecting line caused on dense intraday data. Drawn on top of
     the dots so the eye can follow the trend at a glance. The EMA carries
     across small data gaps but the drawn line lifts the pen over them. */
  if (L.length > 2) {
    const period = Math.max(2, Math.round(L.length * 0.08));
    const k = 2 / (period + 1);
    let ema = null;
    const smooth = new Array(L.length).fill(null);
    /* Why 1D looked chopped into pieces: a bucket needed BOTH an insta-buy
       and an insta-sell print to contribute, and on a 5-minute grid most
       buckets have one side or neither. Every one-sided bucket produced a
       null, the drawn path lifts the pen at nulls, and the "trend line" came
       out as a few dozen disconnected strokes. The data was not gappy — the
       requirement was.

       Each side is carried forward instead. A bucket with only a low keeps
       the last known high, so the mid moves by half the change rather than
       collapsing onto whichever side happened to print, which is what taking
       the available side alone would have done: that trades pen-lifts for
       vertical steps and looks worse.

       Genuinely dead stretches must still break the line — bridging four
       hours of no trading with a straight run is a lie about the data — so
       the carry expires after a run of missing buckets proportional to the
       window (2%, floor 3). Past that the pen lifts, which is the behaviour
       the gap rule was always meant to have. */
    const CARRY_MAX = Math.max(3, Math.round(L.length * 0.02));
    let lastLo = null, lastHi = null, missRun = 0;
    for (let i = 0; i < L.length; i++) {
      const hasLo = LO[i] != null, hasHi = HI[i] != null;
      if (hasLo) lastLo = LO[i];
      if (hasHi) lastHi = HI[i];
      if (!hasLo && !hasHi) {
        if (++missRun > CARRY_MAX) { lastLo = lastHi = null; ema = null; }
        continue;
      }
      missRun = 0;
      if (lastLo == null || lastHi == null) continue;  // nothing to average yet
      const mid = (lastLo + lastHi) / 2;
      ema = ema == null ? mid : mid * k + ema * (1 - k);
      smooth[i] = ema;
    }
    ctx.save();
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    /* Traced twice: a dark casing first, then the light line over it. The
       cartographer's trick for a line crossing busy ground — it separates
       the trend from the dots it runs through without making the stroke
       itself any heavier. */
    const trendPath = () => {
      ctx.beginPath();
      let st = false;
      for (let i = 0; i < L.length; i++) {
        if (smooth[i] == null) { st = false; continue; }
        const x = x0 + i * stepX, y = ypx(smooth[i], vmin, vmax, y0, h_price);
        if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y);
      }
    };
    trendPath();
    ctx.strokeStyle = "rgba(8,10,14,0.55)"; ctx.lineWidth = 4; ctx.stroke();
    /* The page's own text colour, not near-white. Measured against every
       other near-opaque mark on the canvas, rgb(250,248,243) came to a
       relative luminance of 0.94, against 0.513 for the gold prints and
       0.317 for the teal — the trend line was not merely the brightest
       thing on the chart, it was almost twice the brightest thing, which is
       what makes it flare on an OLED in a dark room.
       #D9D3C7 is --text-main, so the line now sits at the same weight as the
       page's brightest TEXT rather than above it: luminance 0.657, still
       comfortably clear of the gold prints it has to be read over, and no
       longer the first thing the eye lands on. The dark casing underneath
       stays — that is what separates it from the scatter, and it lets the
       stroke itself be quieter without losing the path. */
    /* Same left-to-right recency ramp the scatter uses, so the line recedes
       into the history exactly as the dots around it do instead of staying at
       full strength across a field that is fading underneath it.
       A canvas gradient across the plot's x-range, with the SAME
       DOT_ALPHA_OLD -> DOT_ALPHA_NEW stops, multiplied by the stroke's own
       0.90 so the right-hand edge lands where it did before rather than
       getting brighter. Built from x0..x0+w, the plot area, not 0..W — keyed
       to the full canvas the ramp would finish early and leave the newest
       prints on a flat maximum. */
    {
      const _g = ctx.createLinearGradient(x0, 0, x0 + w, 0);
      const _a = v => "rgba(217,211,199," + (v * 0.90).toFixed(3) + ")";
      _g.addColorStop(0, _a(DOT_ALPHA_OLD));
      _g.addColorStop(1, _a(DOT_ALPHA_NEW));
      ctx.strokeStyle = _g;
    }
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < L.length; i++) {
      if (smooth[i] == null) { started = false; continue; }
      const x = x0 + i * stepX, y = ypx(smooth[i], vmin, vmax, y0, h_price);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function ring(i, arr, color) {
    if (i < 0 || arr[i] == null) return;
    const x = x0 + i * stepX, y = ypx(arr[i], vmin, vmax, y0, h_price);
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke(); ctx.restore();
  }
  {
    /* All four markers follow ONE consistent scheme on every view, including
       5Y/1Y: green = a HIGH, gold = a LOW; solid white-centre dot = a PERIOD
       extreme, hollow ring = a RECENT extreme. (Previously the recent rings
       went neutral white on single-price views while the period dots stayed
       teal/gold — which read as three random colors.) */
    ring(recHiIdx, HI, sellColor);
    ring(recLoIdx, LO, buyColor);
    ctx.restore(); // end price-area clip

    /* Paned mode only — in overlay mode these were already painted underneath
       the price series, before the clip opened. */
    if (!volOverlay) {
      /* Dropped again alongside the dots' brightening: bars carry far more
         area than a 2.5px dot, so matching alpha would leave volume reading
         as the heavier layer even though it sits two tiers lower. */
      drawVolumeBars(0.34);
      /* Hairline between the price plot and the volume strip. Without it the
         two panes share an edge and the tallest bars read as part of the
         price area. */
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, Math.round(y0 + h_price) + 0.5);
      ctx.lineTo(x0 + w, Math.round(y0 + h_price) + 0.5); ctx.stroke();
      ctx.restore();
    }
  }

  const activePrice = activePriceBox === 'buy' ? recommendedBuy : recommendedSell;
  if (activePrice != null) {
    const py = ypx(activePrice, vmin, vmax, y0, h_price);
    if (py >= y0 && py <= y0 + h_price) {
      const col = activePriceBox === 'buy' ? buyColor : sellColor;
      ctx.save();
      /* The line stays a hairline dash — it spans the whole plot, so any
         extra weight turns it into a stripe across the data. The contrast
         goes into the BADGE instead, which is small and fixed. */
      ctx.setLineDash([4, 4]); ctx.strokeStyle = col; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x0, py); ctx.lineTo(x0 + w, py); ctx.stroke();
      ctx.setLineDash([]);
      /* The badge used to stack three devices to say one thing: a
         near-opaque plate, a full-perimeter stroke in the accent colour AND
         a colour-coded spine down the leading edge, with the text left white
         because the colour was already spoken for twice. Together they made
         the heaviest object on a chart whose whole hierarchy is built out of
         hairlines and 2px dots.
         One device now. The plate stays — it has a real job, keeping the
         label legible over the scatter — but it loses the stroke and the
         spine, softens its corners, and drops from 0.96 to 0.90 so it sits
         INTO the chart rather than on top of it. The tie back to the dashed
         line is carried by colouring the price itself, which is what the
         spine and the stroke were both standing in for.
         "Target" also stops competing with its own number: 9px in the
         accent at 62% against the price at bold 10.5px, so the label reads
         as an annotation rather than a UI chip. Net footprint is smaller in
         both directions — 17px tall to 15, and narrower despite the same
         words, since the spine and both strokes are gone. */
      const word = 'Target', price = fmtGp(activePrice);
      const wordFont = "9px BlinkMacSystemFont, sans-serif";
      const priceFont = "bold 10.5px BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.font = wordFont; const wordW = ctx.measureText(word).width;
      ctx.font = priceFont; const priceW = ctx.measureText(price).width;
      const padX = 5.5, gapW = 4, bh = 15, bx = x0 + 4;
      const bw = padX * 2 + wordW + gapW + priceW;
      let cy = py - bh / 2 - 3;
      if (cy - bh / 2 < y0 + 1) cy = py + bh / 2 + 3;
      const by = cy - bh / 2;
      /* The chart's OWN surface colour (--bg-chart #131110), not the darker
         #080A0E this was. A plate darker than the background it sits on is
         an object laid over the chart; a plate that matches it is a clearing
         in the data. Against empty plot area its edges now disappear
         entirely — it only becomes visible where it actually has a job,
         covering dots and gridlines so the label stays readable. 0.92 rather
         than fully opaque so the densest scatter still ghosts through
         faintly and the badge never looks punched out. */
      ctx.fillStyle = "rgba(19,17,16,0.92)";
      roundRectPath(ctx, bx, by, bw, bh, 3); ctx.fill();
      const tx = Math.round(bx + padX), tyc = Math.round(cy);
      ctx.font = wordFont; ctx.globalAlpha = 0.62; ctx.fillStyle = col;
      ctx.fillText(word, tx, tyc); ctx.globalAlpha = 1;
      ctx.font = priceFont; ctx.fillStyle = col;
      ctx.fillText(price, Math.round(tx + wordW + gapW), tyc);
      ctx.restore();
    } else {
      /* Target is off-scale — only reachable when it sits further from the
         data than the range-fit above is willing to stretch. Previously this
         branch did not exist and the line simply was not drawn, so the chart
         said nothing at all about the number in the highlighted box. Say
         which way it went instead: a badge pinned to the edge it went past,
         with an arrow, so "no line" never again means "no information". */
      const col = activePriceBox === 'buy' ? buyColor : sellColor;
      const below = py > y0 + h_price;
      ctx.save();
      const word = below ? 'Target ↓' : 'Target ↑', price = fmtGp(activePrice);
      const wordFont = "9px BlinkMacSystemFont, sans-serif";
      const priceFont = "bold 10.5px BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.font = wordFont; const wordW = ctx.measureText(word).width;
      ctx.font = priceFont; const priceW = ctx.measureText(price).width;
      const padX = 5.5, gapW = 4, bh = 15, bx = x0 + 4;
      const bw = padX * 2 + wordW + gapW + priceW;
      const cy = below ? (y0 + h_price - bh / 2 - 2) : (y0 + bh / 2 + 2);
      ctx.fillStyle = "rgba(19,17,16,0.92)";
      roundRectPath(ctx, bx, cy - bh / 2, bw, bh, 3); ctx.fill();
      const tx = Math.round(bx + padX), tyc = Math.round(cy);
      ctx.font = wordFont; ctx.globalAlpha = 0.62; ctx.fillStyle = col;
      ctx.fillText(word, tx, tyc); ctx.globalAlpha = 1;
      ctx.font = priceFont; ctx.fillStyle = col;
      ctx.fillText(price, Math.round(tx + wordW + gapW), tyc);
      ctx.restore();
    }
  }

  if (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < L.length) {
    const hx = x0 + hoverIdx * stepX;
    ctx.save(); ctx.beginPath(); ctx.moveTo(hx, y0); ctx.lineTo(hx, y0 + h);
    ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.restore();

    /* TradingView-style crosshair: a horizontal line follows the raw cursor
       row (not snapped to a data value) with the price it corresponds to
       shown in a label docked to the y-axis, and the hovered column's date
       shown in a matching label docked to the x-axis. */
    if (hoverY != null && hoverY >= y0 && hoverY <= y0 + h_price) {
      ctx.save();
      ctx.beginPath(); ctx.moveTo(x0, hoverY); ctx.lineTo(x0 + w, hoverY);
      ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.setLineDash([4, 4]); ctx.stroke();
      ctx.restore();

      const hoverVal = vmin + (1 - (hoverY - y0) / h_price) * (vmax - vmin);
      const priceLabel = fmtYAxis(hoverVal);
      ctx.save();
      ctx.font = `bold ${axisFontPx}px BlinkMacSystemFont, sans-serif`;
      const padX = 5, bh = 16, tw = ctx.measureText(priceLabel).width;
      const bx = yRight ? (x0 + w + 2) : (x0 - 2 - (tw + padX * 2));
      ctx.fillStyle = "rgba(244,241,232,0.97)";
      ctx.fillRect(bx, hoverY - bh / 2, tw + padX * 2, bh);
      ctx.strokeStyle = "rgba(10,9,8,0.9)"; ctx.lineWidth = 1;
      ctx.strokeRect(bx - 0.5, hoverY - bh / 2 - 0.5, tw + padX * 2 + 1, bh + 1);
      ctx.fillStyle = "#0B0E14"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(priceLabel, Math.round(bx + padX), Math.round(hoverY));
      ctx.restore();
    }

    const dCross = new Date(L[hoverIdx] * 1000);
    const timeLabel = spanSec <= 2 * 86400
      ? dCross.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : `${dCross.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${dCross.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    ctx.save();
    ctx.font = `bold ${axisFontPx}px BlinkMacSystemFont, sans-serif`;
    const padX2 = 5, bh2 = 16, tw2 = ctx.measureText(timeLabel).width;
    const bx2 = Math.max(x0, Math.min(x0 + w - (tw2 + padX2 * 2), hx - tw2 / 2 - padX2));
    const by2 = y0 + h + 2;
    /* The pill lands in the x-axis strip, on top of whichever fixed label
       happens to be under the cursor — cream on cream, so the two ran
       together into one unreadable smear. A dark ring separates it and
       makes it read as a chip floating above the row. */
    ctx.fillStyle = "rgba(244,241,232,0.97)";
    ctx.fillRect(bx2, by2, tw2 + padX2 * 2, bh2);
    ctx.strokeStyle = "rgba(10,9,8,0.9)"; ctx.lineWidth = 1;
    ctx.strokeRect(bx2 - 0.5, by2 - 0.5, tw2 + padX2 * 2 + 1, bh2 + 1);
    ctx.fillStyle = "#0B0E14"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(timeLabel, Math.round(bx2 + padX2), Math.round(by2 + bh2 / 2));
    ctx.restore();
  }

  /* sticky tap/click selection */
  if (selectedAbsIdx != null) {
    const sLocal = selectedAbsIdx - start;
    if (sLocal >= 0 && sLocal < L.length) {
      const sx = x0 + sLocal * stepX;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(sx, y0); ctx.lineTo(sx, y0 + h);
      ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1.5; ctx.setLineDash([2, 3]); ctx.stroke();
      ctx.setLineDash([]);
      [[LO[sLocal], buyColor], [HI[sLocal], sellColor]].forEach(([val, col]) => {
        if (val == null) return;
        const y = ypx(val, vmin, vmax, y0, h_price);
        ctx.beginPath(); ctx.arc(sx, y, 7, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
        ctx.beginPath(); ctx.arc(sx, y, 7, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke();
      });
      ctx.restore();
    }
  }

  /* Zoom-box selection, drawn last so it sits over everything. Rendered
     inside drawChart rather than as a DOM overlay so it can't drift from
     the plot during a resize or a redraw. */
  if (zoomBox) {
    const bx = Math.min(zoomBox.ax, zoomBox.bx), bw = Math.abs(zoomBox.bx - zoomBox.ax);
    const by = Math.min(zoomBox.ay, zoomBox.by), bh2 = Math.abs(zoomBox.by - zoomBox.ay);
    ctx.save();
    ctx.fillStyle = 'rgba(201,166,77,0.14)';
    ctx.fillRect(bx, by, bw, bh2);
    ctx.strokeStyle = 'rgba(201,166,77,0.85)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh2);
    ctx.restore();
    /* Below the drag threshold the release is treated as a click, so say so
       rather than letting someone twitch the mouse and wonder why nothing
       zoomed. */
    if (bw < ZOOM_BOX_MIN && bh2 < ZOOM_BOX_MIN) {
      ctx.save();
      ctx.font = `bold ${axisFontPx}px BlinkMacSystemFont, sans-serif`;
      ctx.fillStyle = 'rgba(201,166,77,0.9)';
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText('drag to zoom', bx + 6, by - 3);
      ctx.restore();
    }
  }
}

function showTipFor(local, clientX, clientY) {
  const { L, LO, HI, VO } = chartData;
  if (!L || local < 0 || local >= L.length) { tip.style.display = "none"; return; }
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left, my = clientY - rect.top;
  /* When the point has no buy/sell distinction (historical daily data where
     low === high), collapse the tooltip to a single "Price" line instead of
     showing "Buy: 5,662" and "Sell: 5,662" as if they were two separate
     numbers — that read as redundant / broken on 5Y views. */
  const lo = LO[local], hi = HI[local];
  const same = lo != null && hi != null && Math.abs(hi - lo) < 1e-9;
  const priceRows = same
    ? `<span style="color:#C2CBDC">Price: ${fmtGp(hi)}</span><br/>`
    : `<span style="color:var(--buy-color)">Buy: ${fmtGp(lo)}</span><br/>
       <span style="color:var(--sell-color)">Sell: ${fmtGp(hi)}</span><br/>`;
  /* If this point is one of the special orbs, name it at the top of the
     tooltip ("● Period High" / "○ Recent Low") with a glyph matching the
     marker (solid dot for period extremes, hollow ring for recent ones). */
  const ml = chartData.markerLabels && chartData.markerLabels[local];
  const markerRow = ml
    ? `<span class="tip-marker" style="color:${ml.color}">${ml.shape === 'hollow' ? '◯' : '●'} ${ml.text}</span><br/>`
    : '';
  tip.innerHTML = `<strong>${new Date(L[local] * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong>
    ${markerRow}${priceRows}
    <span style="color:var(--text-muted)">Volume: ${fmtNum(VO[local])}</span>`;
  tip.style.display = "block";
  let tipX = mx + 15, tipY = my + 15;
  if (tipX + tip.offsetWidth > rect.width - 5) tipX = mx - tip.offsetWidth - 15;
  if (tipY + tip.offsetHeight > rect.height - 5) tipY = my - tip.offsetHeight - 15;
  tip.style.left = tipX + "px"; tip.style.top = tipY + "px";
}

function localFromClientX(clientX) {
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left;
  const { x0, stepX, L } = chartData;
  if (!L || !L.length) return -1;
  return Math.max(0, Math.min(L.length - 1, Math.round((mx - x0) / stepX)));
}

function selectAt(clientX, clientY) {
  let local = localFromClientX(clientX);
  if (local < 0) return;
  /* snap to a nearby highlighted marker (period/recent high & low) so the dots
     are easier to tap precisely. */
  const markers = chartData.markers;
  if (markers && markers.length) {
    let best = -1, bestDist = 2.5;
    for (const mi of markers) { const d = Math.abs(mi - local); if (d < bestDist) { bestDist = d; best = mi; } }
    if (best >= 0) local = best;
  }
  selectedAbsIdx = offset + local;
  hoverIdx = local;
  showTipFor(local, clientX, clientY);
  queueDraw();
}

const handleTooltip = (clientX, clientY) => {
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left, my = clientY - rect.top;
  const { x0, dataW, L, y0, H } = chartData;
  if (!L || mx < x0 || mx > x0 + dataW || my < y0 || my > H) { tip.style.display = "none"; if (hoverIdx !== null) { hoverIdx = null; hoverY = null; queueDraw(); } return; }
  const newIdx = localFromClientX(clientX);
  /* Redraw on every move (not just when the hovered column changes) so the
     crosshair's horizontal line tracks the cursor smoothly instead of
     jumping in column-sized steps. */
  hoverIdx = newIdx; hoverY = my;
  queueDraw();
  showTipFor(newIdx, clientX, clientY);
};

/* ── TradingView-style price-axis drag-to-scale ──────────────────────────
   Grabbing the y-axis label column and dragging vertically stretches or
   squashes the price scale: drag DOWN widens the range (chart flattens),
   drag UP narrows it (swings amplify). Double-tap / double-click the axis
   resets to auto-fit. Works on the right-edge axis (portrait phones) and
   the left axis (desktop). */
function inYAxisZone(clientX) {
  if (!chartData.W) return false;
  const x = clientX - canvas.getBoundingClientRect().left;
  return chartData.yRight ? x >= chartData.W - chartData.axisW : x <= chartData.x0;
}
function applyYScaleDrag(dy) {
  yScale = Math.max(0.15, Math.min(12, yScale * Math.exp(dy / 150)));
  queueDraw();
}
/* Vertical pan on the plot itself. Content follows the finger: drag down and
   the prices you're looking at rise, the way dragging a map works. Zooming
   the time axis re-fits the price axis to just the visible points, which is
   what leaves a Target Buy or Sell line stranded off the top or bottom —
   before this there was no way to reach it short of zooming back out.
   Clamped to two viewport heights either way so the data can't be flung
   somewhere you'd have to hunt for it. */
function applyYPan(dy) {
  const hp = chartData.h_price;
  if (!hp) return;
  yOffset = Math.max(-2, Math.min(2, yOffset + dy / hp));
  queueDraw();
}
/* Same idea, the other axis: grabbing the date strip along the bottom and
   dragging horizontally zooms time in/out — drag RIGHT zooms in (narrower
   window, matching the wheel-zoom direction), drag LEFT zooms out. Reuses
   the wheel-zoom's "stay anchored to the most recent data" behavior rather
   than leaving offset fixed, so this drag can't walk the view backward in
   time the way the old wheel handler used to. Double-click resets to the
   full/latest view. Checked after inYAxisZone in the bottom-right corner
   where both bands technically overlap — the price-scale drag wins there,
   matching where a user's eye reads that corner as "the price axis". */
function inXAxisZone(clientY) {
  if (!chartData.H) return false;
  const y = clientY - canvas.getBoundingClientRect().top;
  return y >= chartData.y0 + chartData.h;
}
/* Pin the visible window to the most recent data after any zoom change.
   Without this the window's START stays fixed while its width changes, so
   zooming visibly walks the range backwards in time and you have to drag
   back to "now" — which is exactly how pinch-zoom behaved on mobile, since
   it changed zoom without ever re-anchoring. Shared by all three zoom
   entry points (wheel, x-axis drag, pinch) so they can't drift apart. */
function anchorZoomToLatest() {
  const n = chartData.n;
  if (n) offset = Math.max(0, n - Math.max(20, Math.floor(n / zoom)));
}
function applyXScaleDrag(dx) {
  zoom = Math.max(1, Math.min(20, zoom * Math.exp(dx / 150)));
  anchorZoomToLatest();
  queueDraw();
}
/* ── Shift-drag box zoom ─────────────────────────────────────────────────
   Plain drag is already pan, and pan is worth keeping on the primary
   button, so the zoom box takes the modifier — the same chord Highcharts,
   Plotly and most desktop graphics tools use, and the one a trader coming
   from another charting site tries first. Both axes are applied: the box
   you draw is the view you get, because a rectangle that only honoured its
   width would read as a bug.

   Touch is deliberately excluded — pinch already covers zoom there, and a
   drag gesture is spoken for by pan. */
const ZOOM_BOX_MIN = 8;   // px; below this on BOTH axes the release is a click
let zoomBox = null;

/* Turn a pixel rectangle into zoom/offset (time) plus yScale/yOffset
   (price). The price half has to be solved rather than assigned: the axis
   auto-fits the NEW window first, and yScale/yOffset are expressed relative
   to that fit, which isn't known until the window is chosen. */
function applyZoomBox(box) {
  const { x0, stepX, n, h_price, y0, vmin, vmax } = chartData;
  if (!n || !stepX) return;

  /* Clamp to the price pane. A box dragged down into the volume strip (or
     off the plot entirely) would otherwise extrapolate past the axis and
     ask for a price range that was never on screen. */
  const clampX = (v) => Math.max(x0, Math.min(x0 + chartData.dataW, v));
  const clampY = (v) => Math.max(y0, Math.min(y0 + h_price, v));
  const ax = clampX(Math.min(box.ax, box.bx)), bx = clampX(Math.max(box.ax, box.bx));
  const ay = clampY(Math.min(box.ay, box.by)), by = clampY(Math.max(box.ay, box.by));

  // ── time ──
  if (bx - ax >= ZOOM_BOX_MIN) {
    const a0 = Math.max(0, Math.round(offset + (ax - x0) / stepX));
    const a1 = Math.min(n, Math.round(offset + (bx - x0) / stepX));
    const wantWin = Math.max(20, a1 - a0);
    zoom = Math.max(1, Math.min(20, n / wantWin));
    const win = Math.max(20, Math.floor(n / zoom));
    offset = Math.max(0, Math.min(n - win, a0));
  }

  // ── price ──
  if (by - ay >= ZOOM_BOX_MIN) {
    /* Pixels -> prices under the CURRENT transform, before it's replaced. */
    const pxToVal = (py) => vmin + (1 - (py - y0) / h_price) * (vmax - vmin);
    const tMax = pxToVal(ay), tMin = pxToVal(by);

    /* What the axis will auto-fit to for the window just chosen. */
    const win = Math.max(20, Math.floor(n / zoom));
    const vals = [...currentSeries.low.slice(offset, offset + win),
                  ...currentSeries.high.slice(offset, offset + win)].filter(v => v != null);
    if (vals.length) {
      const [b0, b1] = fitPriceRange(vals);
      const span = b1 - b0;
      if (span > 0) {
        yScale = Math.max(0.15, Math.min(12, (tMax - tMin) / span));
        const shown = span * yScale;
        yOffset = Math.max(-2, Math.min(2, ((tMin + tMax) / 2 - (b0 + b1) / 2) / shown));
      }
    }
  }
  queueDraw();
}

/* True whenever the view has been moved off its default in any way, which
   is what the Reset chip keys off. */
function chartViewDirty() {
  return zoom !== 1 || offset !== 0 || yScale !== 1 || yOffset !== 0;
}
function resetChartView() {
  zoom = 1; offset = 0; yScale = 1; yOffset = 0;
  zoomBox = null;
  queueDraw();
  syncChartReset();
}
/* Anything the user has moved off its default and might want back: the chart
   view, and a target price nudged with the - / + buttons. Both are "you have
   changed the picture", which is what arms the refresh button. */
function viewIsDirty() {
  return chartViewDirty() || buyOverridden || sellOverridden;
}
function syncChartReset() {
  const b = document.getElementById('btnRefreshPrices');
  if (!b) return;
  const dirty = viewIsDirty();
  b.classList.toggle('is-dirty', dirty);
  const t = dirty
    ? 'Reset the chart view and target prices, and refresh'
    : 'Refresh live prices now';
  b.setAttribute('title', t);
  b.setAttribute('aria-label', t);
  /* The word follows the job. Leaving it on "Refresh" while the button is
     gold and about to undo a zoom would make the label the least accurate
     thing on the row.
     "Reset", not "Reset view": one word is enough on a button that is already
     gold and already carries a title spelling out exactly what gets reset.
     It does not make the button width-stable — measured, "Refresh" is 81px
     and "Reset" 70 — but 11px narrower beats "Reset view" widening it by
     ~30, and the 30-Day Range meter beside it flexes, so the slack is
     absorbed rather than shunting the figures at the end of the row. */
  const lbl = document.getElementById('refreshLabel');
  if (lbl) lbl.textContent = dirty ? 'Reset' : 'Refresh';
}
/* Put the hand-nudged targets back on the engine's own numbers. Done from
   the CURRENT latest snapshot so the boxes correct the instant you click,
   rather than after the network round trip. */
function restoreEngineTargets() {
  if (!selected || overMaxData[String(selected.id)]) return;
  buyOverridden = false; sellOverridden = false;
  const node = latest?.data?.[String(selected.id)];
  if (!node) return;
  const targets = computeViewTargets(node, selected.id);
  if (targets) {
    recommendedBuy = targets.buy; recommendedSell = targets.sell;
    applyTargetPriceChange();
  }
}

let isDragging = false, startXMouse = 0, startYMouse = 0, mouseMoved = false;
let axisDragging = false, axisLastY = 0;
let xAxisDragging = false, xAxisLastX = 0;
canvas.addEventListener('mousedown', ev => {
  if (inYAxisZone(ev.clientX)) { axisDragging = true; axisLastY = ev.clientY; return; }
  if (inXAxisZone(ev.clientY)) { xAxisDragging = true; xAxisLastX = ev.clientX; return; }
  if (ev.shiftKey) {
    const r = canvas.getBoundingClientRect();
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    zoomBox = { ax: px, ay: py, bx: px, by: py };
    /* Stops the browser turning a shift-drag into a text selection of the
       surrounding page. */
    ev.preventDefault();
    /* Drop the crosshair too — left up, it stays frozen at the point the
       drag began and reads as a second, contradictory price marker. */
    tip.style.display = 'none';
    hoverIdx = null; hoverY = null;
    queueDraw();
    return;
  }
  isDragging = true; mouseMoved = false; startXMouse = ev.clientX; startYMouse = ev.clientY;
});
canvas.addEventListener('mouseup', ev => {
  if (axisDragging) { axisDragging = false; return; }
  if (xAxisDragging) { xAxisDragging = false; return; }
  if (zoomBox) return;   // finished by the document handler below
  if (!mouseMoved) selectAt(ev.clientX, ev.clientY);
  isDragging = false;
});
/* The box is tracked and finished on the document, not the canvas: dragging
   to the very edge of the plot (or a little past it, which is what you do
   when the range you want runs to the edge) would otherwise fire mouseleave
   and throw the selection away mid-drag. */
document.addEventListener('mousemove', ev => {
  if (!zoomBox) return;
  const r = canvas.getBoundingClientRect();
  zoomBox.bx = ev.clientX - r.left; zoomBox.by = ev.clientY - r.top;
  queueDraw();
});
document.addEventListener('mouseup', ev => {
  if (!zoomBox) return;
  const box = zoomBox; zoomBox = null;
  /* A shift-click that never really moved should still pick a point,
     matching what a plain click does. */
  if (Math.abs(box.bx - box.ax) < ZOOM_BOX_MIN && Math.abs(box.by - box.ay) < ZOOM_BOX_MIN) {
    selectAt(ev.clientX, ev.clientY);
  } else {
    applyZoomBox(box);
  }
});
canvas.addEventListener('mouseleave', () => { isDragging = false; axisDragging = false; xAxisDragging = false; tip.style.display = "none"; hoverIdx = null; hoverY = null; queueDraw(); });
/* Escape abandons a box mid-drag — the standard out for any rubber-band. */
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && zoomBox) { zoomBox = null; queueDraw(); }
});
canvas.addEventListener('dblclick', ev => {
  if (inYAxisZone(ev.clientX)) { yScale = 1; yOffset = 0; queueDraw(); }
  else if (inXAxisZone(ev.clientY)) { zoom = 1; offset = 0; queueDraw(); }
  else resetChartView();   // double-click the plot itself = back to everything
});
canvas.addEventListener('mousemove', ev => {
  if (!chartData.L) return;
  if (zoomBox) return;   // the document-level handler owns the box
  if (axisDragging) {
    applyYScaleDrag(ev.clientY - axisLastY); axisLastY = ev.clientY; return;
  }
  if (xAxisDragging) {
    applyXScaleDrag(ev.clientX - xAxisLastX); xAxisLastX = ev.clientX; return;
  }
  if (isDragging) {
    const dx = ev.clientX - startXMouse; if (Math.abs(dx) > 3) mouseMoved = true; startXMouse = ev.clientX;
    const dy = ev.clientY - startYMouse; startYMouse = ev.clientY;
    const { dataW, win, n } = chartData;
    offset -= dx / (dataW / win); offset = Math.max(0, Math.min(n - win, offset));
    if (dy) applyYPan(dy); else queueDraw();
    return;
  }
  /* Holding shift over the plot swaps the cursor to a crosshair — the only
     hint that the box zoom exists until you try it. */
  canvas.style.cursor = inYAxisZone(ev.clientX) ? 'ns-resize'
    : inXAxisZone(ev.clientY) ? 'ew-resize'
    : ev.shiftKey ? 'crosshair' : '';
  handleTooltip(ev.clientX, ev.clientY);
});
canvas.addEventListener('wheel', ev => {
  ev.preventDefault();
  zoom = Math.max(1, Math.min(20, zoom * (ev.deltaY < 0 ? 1.2 : 0.8)));
  anchorZoomToLatest();
  queueDraw();
}, { passive: false });

/* touch: 1 finger = tap-to-select / drag-to-pan (or, when it starts on the
   price axis, drag-to-scale the y-axis), 2 fingers = pinch zoom */
let touchMode = null, lastTouchX = 0, lastTouchY = 0, touchMoved = false, tStartX = 0, tStartY = 0, pinchStart = 0, pinchZoom = 1;
let lastAxisTapT = 0;
/* Set once the first real movement of a touch drag decides whether the chart
   or the page owns it — see the touchmove handler. */
let touchAxisLocked = false;
function dist(t) { const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.hypot(dx, dy); }
canvas.addEventListener('touchstart', ev => {
  if (ev.touches.length === 1) {
    const t = ev.touches[0];
    tStartX = t.clientX; tStartY = t.clientY; touchMoved = false;
    if (inYAxisZone(t.clientX)) {
      touchMode = 'yscale'; lastTouchY = t.clientY;
      /* double-tap the axis = reset to auto-fit */
      const nowT = Date.now();
      if (nowT - lastAxisTapT < 320) { yScale = 1; yOffset = 0; queueDraw(); }
      lastAxisTapT = nowT;
    } else if (inXAxisZone(t.clientY)) {
      touchMode = 'xscale'; lastTouchX = t.clientX;
      /* double-tap the date strip = reset to the full/latest view */
      const nowT = Date.now();
      if (nowT - lastAxisTapT < 320) { zoom = 1; offset = 0; queueDraw(); }
      lastAxisTapT = nowT;
    } else {
      touchMode = 'pan'; lastTouchX = t.clientX; lastTouchY = t.clientY;
    }
    touchAxisLocked = false;
  }
  else if (ev.touches.length === 2) { touchMode = 'pinch'; pinchStart = dist(ev.touches); pinchZoom = zoom; }
}, { passive: true });
canvas.addEventListener('touchmove', ev => {
  if (!chartData.L) return;
  /* The page has to stay scrollable THROUGH the chart. touch-action:pan-y
     declares that, but a preventDefault() in here overrides it anyway, which
     is what left the page stuck behind a full-height chart on a phone.
     So decide once per gesture, on the first real movement, who owns it: a
     mostly-vertical single-finger drag is the reader trying to scroll, and we
     hand it to the browser untouched. Mostly-horizontal stays a chart pan.
     Locked after the first decision so a drifting finger can't flip ownership
     mid-drag, which reads as the chart fighting you. Axis-zone drags and
     pinches are unaffected — they are unambiguous. */
  if (touchMode === 'pagescroll') return;
  if (touchMode === 'pan' && ev.touches.length === 1 && !touchAxisLocked) {
    const t0 = ev.touches[0];
    const adx = Math.abs(t0.clientX - tStartX), ady = Math.abs(t0.clientY - tStartY);
    if (adx > 8 || ady > 8) {
      touchAxisLocked = true;
      if (ady > adx * 1.2) { touchMode = 'pagescroll'; return; }
    }
  }
  ev.preventDefault();
  if (touchMode === 'yscale' && ev.touches.length === 1) {
    const cy = ev.touches[0].clientY;
    applyYScaleDrag(cy - lastTouchY); lastTouchY = cy;
  } else if (touchMode === 'xscale' && ev.touches.length === 1) {
    const cx = ev.touches[0].clientX;
    applyXScaleDrag(cx - lastTouchX); lastTouchX = cx;
  } else if (touchMode === 'pan' && ev.touches.length === 1) {
    const cx = ev.touches[0].clientX, cy = ev.touches[0].clientY;
    if (Math.abs(cx - tStartX) > 6 || Math.abs(cy - tStartY) > 6) touchMoved = true;
    const dx = cx - lastTouchX; lastTouchX = cx;
    const dy = cy - lastTouchY; lastTouchY = cy;
    const { dataW, win, n } = chartData;
    offset -= dx / (dataW / win); offset = Math.max(0, Math.min(n - win, offset));
    if (dy) applyYPan(dy); else queueDraw();
  } else if (touchMode === 'pinch' && ev.touches.length === 2) {
    const nd = dist(ev.touches);
    if (pinchStart > 0) {
      zoom = Math.max(1, Math.min(20, pinchZoom * (nd / pinchStart)));
      anchorZoomToLatest();
      queueDraw();
    }
  }
}, { passive: false });
canvas.addEventListener('touchend', ev => {
  if (touchMode === 'pan' && !touchMoved) selectAt(tStartX, tStartY);
  if (ev.touches.length === 0) touchMode = null;
}, { passive: true });

/* The timeframe strip scrolls horizontally when the header is too narrow to
   show all six pills (see .ticker-header .toolbar). Nothing else scrolls it,
   so without this the selected timeframe can sit parked out of view — the one
   button whose state the user most needs to see. Only ever scrolls the strip
   itself, never the page: scrollIntoView() would drag the whole document. */
function keepActiveViewVisible() {
  const bar = document.getElementById('timeToolbar');
  const btn = bar && bar.querySelector('.view-btn.active');
  if (!bar) return;
  if (btn && bar.scrollWidth > bar.clientWidth + 1) {
    /* Rect deltas, NOT offsetLeft: offsetLeft is measured from the nearest
       POSITIONED ancestor, and the toolbar isn't positioned, so it returns an
       offset relative to something further up the tree. Using it here scrolled
       the active pill out of view instead of into it. */
    const bar_r = bar.getBoundingClientRect(), btn_r = btn.getBoundingClientRect();
    const left = btn_r.left - bar_r.left + bar.scrollLeft;
    const right = left + btn_r.width;
    const pad = 8;                                      // let the neighbour peek
    if (left - pad < bar.scrollLeft) bar.scrollLeft = Math.max(0, left - pad);
    else if (right + pad > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right + pad - bar.clientWidth;
  }
  updateToolbarFades();
}
/* Which edges have more pills behind them. 2px of slack because scrollLeft is
   fractional under zoom/DPR and an exact comparison flickers the mask. */
function updateToolbarFades() {
  const bar = document.getElementById('timeToolbar');
  if (!bar) return;
  const over = bar.scrollWidth > bar.clientWidth + 1;
  bar.classList.toggle('tb-more-left', over && bar.scrollLeft > 2);
  bar.classList.toggle('tb-more-right', over && bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2);
}

function renderOverMax(m) {
  const o = overMaxData[String(m.id)];
  document.querySelectorAll(".view-btn").forEach(b => {
    b.innerHTML = `${b.dataset.view.toUpperCase()}<br/><span class="pct-chg neutral">+0.00%</span>`;
  });
  const now = Math.floor(Date.now() / 1000);
  const mock = emptySeries();
  /* 5 years of daily points so 1Y and 5Y timeframes have data to display. */
  const noise = (o.wtb + o.wts) * 0.01;
  let wtb = o.wtb * 0.8, wts = o.wts * 0.8;
  for (let i = 1825; i >= 0; i--) {
    mock.labels.push(now - (i * 86400));
    wtb += (o.wtb - wtb) * 0.03 + (Math.random() - 0.5) * noise;
    wts += (o.wts - wts) * 0.03 + (Math.random() - 0.5) * noise;
    if (wts <= wtb) wts = wtb + 10000000;
    mock.low.push(Math.round(wtb)); mock.high.push(Math.round(wts));
    mock.lowVol.push(Math.floor(Math.random() * 5)); mock.highVol.push(Math.floor(Math.random() * 5));
  }
  overMaxFull = mock;
  /* Synthetic over-max history is DAILY, so 1D/5D views render 1–5 lonely
     points — bump to 1M for display (preferredView keeps the user's pick). */
  if (view === '1d' || view === '5d') {
    view = '1m';
    document.querySelectorAll(".view-btn").forEach(b => b.classList.toggle('active', b.dataset.view === view));
  }
  currentSeries = filterSeries(overMaxFull, getPeriod(view));
  $("#buyPrice").innerHTML = `<div class="price-label"><span class="pl-t">Target WTB</span> <span class="live-val">Aggregated</span></div><div class="price-val"><span>${abbreviateNumber(o.wtb)}</span></div>`;
  $("#sellPrice").innerHTML = `<div class="price-label"><span class="pl-t">Target WTS</span> <span class="live-val">Aggregated</span></div><div class="price-val"><span>${abbreviateNumber(o.wts)}</span></div>`;
  $("#tickerLivePrice").textContent = abbreviateNumber(o.wts);
  $("#tickerChange").innerHTML = `<span class="neutral">— Estimated Value</span>`;
  recommendedBuy = o.wtb; recommendedSell = o.wts;
  $("#sideModule").innerHTML = `
    <div class="calc-headline-label" style="color: var(--fav-gold);">${uiIcon('crown')} Over-Max Consensus Engine</div>
    <div style="font-size: 10px; color: var(--text-muted); margin: 6px 0; line-height: 1.4;">
      Aggregated from community sale telemetry. Outer 15% of quotes are rejected mathematically to filter spoof bids.
    </div>
    <div style="display:flex; justify-content:space-between; margin-top:8px; padding:8px 10px; background:rgba(0,0,0,0.25); border:1px solid var(--border-main); border-radius:4px;">
       <span style="color:var(--buy-color); font-weight:bold;">WTB: ${abbreviateNumber(o.wtb)}</span>
       <span style="color:var(--sell-color); font-weight:bold;">WTS: ${abbreviateNumber(o.wts)}</span>
    </div>`;
  selectedAbsIdx = null;
  offset = Math.max(0, currentSeries.labels.length - Math.floor(currentSeries.labels.length / zoom));
  
  refreshItemInsights(m, null);
  resizeCanvas();
}

/* Re-render only the chart + targets when the user changes timeframe.
   Don't refetch APIs; we already have all the data sources cached. */
function refreshChart() {
  if (!selected) return;
  /* over-max rares: re-filter the cached synthetic series so 1Y/5Y cycle without
     regenerating (and without an API source). */
  if (overMaxData[String(selected.id)]) {
    if (!overMaxFull) return;
    currentSeries = filterSeries(overMaxFull, getPeriod(view));
    selectedAbsIdx = null;
    offset = Math.max(0, currentSeries.labels.length - Math.floor(currentSeries.labels.length / zoom));
    resizeCanvas();
    return;
  }
  if (!currentItemSrc) return;
  currentSeries = filterSeries(seriesForView(view, currentItemSrc, currentItemLowVol), getPeriod(view));
  selectedAbsIdx = null;
  offset = Math.max(0, currentSeries.labels.length - Math.floor(currentSeries.labels.length / zoom));
  const targets = computeViewTargets(latest?.data?.[String(selected.id)], selected.id);
  recommendedBuy = targets.buy; recommendedSell = targets.sell;
  buyOverridden = false; sellOverridden = false; // fresh timeframe — an old manual gp nudge doesn't carry over
  renderTargetBoxes();
  restoreCalculator(selected.limit, recommendedBuy, recommendedSell);
  
  refreshItemInsights(selected, latest?.data?.[String(selected.id)]);
  resizeCanvas();
}

async function setItem(m, opts = {}) {
  /* Generation token. setItem awaits twice — the item's historical series and
     the live price — and every line after those awaits writes into shared
     globals (currentItemSrc, liveSellRaw, recommendedBuy/Sell) and straight
     into the DOM. Two overlapping calls therefore interleave and the page ends
     up assembled from two different items: the header price and chart from
     whichever resolved last, the quick-facts strip from the other. That is
     exactly what a first load looked like — "Steel cannonball / 1 gp" over a
     chart scaled 1-2 while the strip underneath read insta-buy 252, spread 12,
     vol 39.83M.
     It was always possible (a fast double-click on two watchlist rows would do
     it) but the flip hand-off made it routine: boot calls setItem for the
     opening item and the scan can land mid-await, calling it again. Newest
     call wins — which is the behaviour we want, the hand-off should take
     precedence — and any superseded call stops writing at its next
     checkpoint. */
  const gen = ++setItem._gen;
  const stale = () => gen !== setItem._gen;
  selected = m;
  yScale = 1; yOffset = 0; // manual axis scale is per-item — fresh item, auto-fit

  /* keepHomepage = true when we're showing the default boot item (no ?q=
     in the URL) — restore the brand-level title / meta / canonical so a
     Googlebot crawl of "/" indexes the BRAND page, not a stale "(1) Gilded
     scimitar - PocketGE" because we happened to have an item loaded. The
     app still SHOWS the item internally; only the document-level metadata
     stays brand-aligned for the homepage URL. */
  isHomepageDefault = !!opts.keepHomepage;
  syncHomepageCopy();
  /* Persist the last-viewed item so refresh / reopen lands you back on it
     instead of the default landing item. Recent items list tracks the last
     ~10 picks so the search bar can offer quick-toggle between them. */
  try { localStorage.setItem('ge_lastItem', String(m.id)); } catch (e) {}
  recentItems = [String(m.id), ...recentItems.filter(id => id !== String(m.id))].slice(0, 10);
  try { localStorage.setItem('ge_recentItems', JSON.stringify(recentItems)); } catch (e) {}
  /* Don't pre-fill the search input with the selected item — it created
     visible "double info" on mobile where the ticker title also showed the
     name, AND it made the search bar look like a passive title-display
     instead of an actionable search. Now the search input is purely for
     INPUT and stays empty (with its placeholder visible). The ticker title
     below is the canonical "what's loaded" display. */
  $("#query").value = '';
  applyTitleBadge();
  /* SPA analytics + shareable URLs + per-item SEO: when the user switches
     items, no real navigation happens, so GA4 never sees a new page_view,
     every item-specific visit collapses into "home /", and any social-card
     preview of a shared /?q=Cake link shows the generic homepage text.
     Mirror the item into the URL via history.replaceState, refresh every
     meta tag / canonical to the item's context, then fire a virtual GA4
     page_view.
     EXCEPT when keepHomepage is set: leave the URL as "/", restore brand
     meta, and fire a homepage pageview to GA so the SERP and analytics
     both treat "/" as the clean brand page it's meant to be. */
  try {
    if (isHomepageDefault) {
      /* Strip any stale ?q= the previous build might have left behind. */
      if (window.location.search) history.replaceState(null, '', window.location.pathname);
      restoreBrandMeta();
      if (typeof gtag === 'function') {
        gtag('event', 'page_view', {
          page_title: BRAND_TITLE,
          page_location: 'https://pocketge.com/',
          page_path: '/'
        });
      }
    } else {
      const pagePath = itemPagePath(m.name);
      if (pagePath) {
        /* This item has a prerendered document, so that URL is its home: the
           address bar, anything shared from it, and the canonical below all
           point there, and a refresh lands on real HTML instead of a shell. */
        if (window.location.pathname !== pagePath || window.location.search) {
          history.replaceState(null, '', pagePath);
        }
      } else {
        const slug = encodeURIComponent(m.name);
        /* Base "/" when we are ON an item page, not location.pathname — that
           would have produced /item/emerald/?q=Other when picking an item
           that has no page of its own. */
        const base = window.location.pathname.startsWith('/item/') ? '/' : window.location.pathname;
        const newUrl = `${base}?q=${slug}`;
        if (window.location.pathname !== base || window.location.search !== `?q=${slug}`) {
          history.replaceState(null, '', newUrl);
        }
      }
      updateMetaForItem(m);
      if (typeof gtag === 'function') {
        /* Virtual page tracking for GA4. The real browser URL stays /?q=Item
           (good for sharing), but we report a fake hierarchical path
           /item/<Slug> to GA — its "Page path and screen class" report uses
           location.pathname by default and would otherwise collapse every
           item visit into "/". Setting both page_location AND page_path to
           a virtual URL is the documented GA4 SPA pattern. */
        const virtualUrl = `https://pocketge.com/item/${slug}`;
        gtag('event', 'page_view', {
          page_title: `${m.name} price - PocketGE`,
          page_location: virtualUrl,
          page_path: `/item/${slug}`,
          item_id: String(m.id),
          item_name: m.name
        });
      }
    }
  } catch (e) {}
  const iconURL = itemIconUrl(m.id);
  const iconAlt = `${m.name} — OSRS Grand Exchange price`;
  $("#itemIcon").src = iconURL; $("#itemIcon").alt = iconAlt;
  $("#tickerHeaderIcon").src = iconURL; $("#tickerHeaderIcon").alt = iconAlt;
  /* Tab favicon mirrors the selected item — so when you have a bunch of
     PocketGE tabs open you can tell at a glance which item is which. */
  updateFavicon(iconURL);
  $("#tickerName").textContent = m.name;
  /* OSRS wiki uses the item name with the first letter capitalized and
     spaces replaced by underscores (e.g. "Gilded scimitar" -> Gilded_scimitar).
     encodeURIComponent handles apostrophes etc.; underscores are unreserved
     so they pass through untouched. */
  const wikiSlug = (m.name.charAt(0).toUpperCase() + m.name.slice(1)).replace(/ /g, '_');
  const wikiURL = `https://oldschool.runescape.wiki/w/${encodeURIComponent(wikiSlug)}`;
  $("#tickerHeaderIconLink").href = wikiURL;
  $("#tickerNameLink").href = wikiURL;
  /* Names the destination on hover, so the glyph beside the title doesn't
     have to carry the whole explanation on its own. */
  const wikiTitle = `Open ${m.name} on the OSRS Wiki`;
  $("#tickerNameLink").title = wikiTitle;
  $("#tickerHeaderIconLink").title = wikiTitle;
  /* Combined search control (landscape only, shown via CSS): the current item
     name overlays the otherwise-cramped search box, and the ↗ opens its wiki —
     so the item appears once, and the search stays usable. */
  $("#sbarItem").textContent = m.name;
  $("#sbarWiki").href = wikiURL;
  updateFavoriteBtn();
  renderWatchlist();

  if (stale()) return;
  if (overMaxData[String(m.id)]) { currentItemSrc = null; renderOverMax(m); return; }

  const _src = await buildSeriesForItem(m.id);
  if (stale()) return;   // a newer setItem owns the page now
  currentItemSrc = _src;
  currentItemLowVol = isLowVolume(m.id);

  /* The view-timeframe (1D / 5D / 1M / ...) is treated as a USER preference
     that persists across item changes — EXCEPT when the preferred view has
     almost no prints for this item (a 2-trades-a-day rare on 1D renders
     three lonely dots and looks broken). In that case bump UP to the first
     wider timeframe with enough data. Never bump down; liquid items keep
     whatever the user picked. */
  {
    const VIEW_ORDER = ['1d', '5d', '1m', '6m', '1y', '5y'];
    const dataPts = (v) => {
      const s = filterSeries(seriesForView(v, currentItemSrc, currentItemLowVol), getPeriod(v));
      let n = 0;
      for (let i = 0; i < s.labels.length; i++) {
        if ((s.low[i] != null && s.low[i] > 0) || (s.high[i] != null && s.high[i] > 0)) n++;
      }
      return n;
    };
    const MIN_PTS = 12;
    view = preferredView;
    if (dataPts(view) < MIN_PTS) {
      for (let i = VIEW_ORDER.indexOf(view) + 1; i < VIEW_ORDER.length; i++) {
        if (dataPts(VIEW_ORDER[i]) >= MIN_PTS) { view = VIEW_ORDER[i]; break; }
      }
    }
  }
  document.querySelectorAll(".view-btn").forEach(b => b.classList.toggle('active', b.dataset.view === view));
  keepActiveViewVisible();

  const changes = computeAllChanges(currentItemSrc, currentItemLowVol);
  viewChanges = changes;
  document.querySelectorAll(".view-btn").forEach(b => {
    const p = b.dataset.view; const val = changes[p];
    const cls = val > 0 ? 'positive' : val < 0 ? 'negative' : 'neutral';
    b.innerHTML = `${p.toUpperCase()}<br/><span class="pct-chg ${cls}">${val > 0 ? '+' : ''}${val.toFixed(2)}%</span>`;
  });

  clearHeaderChange();

  currentSeries = filterSeries(seriesForView(view, currentItemSrc, currentItemLowVol), getPeriod(view));
  selectedAbsIdx = null;

  const _latest = await loadLatest();
  if (stale()) return;   // second checkpoint — this await is the longer one
  latest = _latest;
  lastLiveFetchAt = Math.floor(Date.now() / 1000);
  const node = latest.data[String(m.id)];
  liveBuyRaw = node?.low ?? node?.avgLowPrice ?? 0;
  liveSellRaw = node?.high ?? node?.avgHighPrice ?? 0;
  liveBuyTime = node?.lowTime ?? null;
  liveSellTime = node?.highTime ?? null;
  /* Full last price ("2,739 gp"), not the rounded "2.7K" — the abbreviation
     was too lossy to be useful as the headline number. */
  $("#tickerLivePrice").innerHTML = `${fmtGp(liveSellRaw)} <span class="tlp-gp">gp</span>`;

  const targets = computeViewTargets(node, m.id);
  recommendedBuy = targets.buy; recommendedSell = targets.sell;
  buyOverridden = false; sellOverridden = false; // new item — any manual gp nudge was scoped to the last one
  renderTargetBoxes();

  restoreCalculator(m.limit, recommendedBuy, recommendedSell);
  offset = Math.max(0, currentSeries.labels.length - Math.floor(currentSeries.labels.length / zoom));
  
  refreshItemInsights(m, node);
  resizeCanvas();
}
/* Bumped on every call; a call whose token is no longer current stops writing.
   Declared here rather than inside setItem so it survives across calls. */
setItem._gen = 0;
setItem._userPicked = false;

(async function boot() {
  /* Sync both mode pills (top-panel + sidebar) with the persisted state. */
  document.querySelectorAll('.mp-f2p').forEach(el => {
    el.classList.toggle('active', !membersOn);
    if (el.hasAttribute('role')) el.setAttribute('aria-selected', String(!membersOn));
  });
  document.querySelectorAll('.mp-p2p').forEach(el => {
    el.classList.toggle('active', membersOn);
    if (el.hasAttribute('role')) el.setAttribute('aria-selected', String(membersOn));
  });

  try {
    mapping = await loadMapping();
    latest = await loadLatest();
    lastLiveFetchAt = Math.floor(Date.now() / 1000);
    try { past24h = await load24h(); } catch (e) {}
    try { volumes = await loadVolumes(); } catch (e) {}

    renderColToggles();
    renderWatchlist();
    renderFlipIdle();
    findFlip(); // always-open: the recommended flip loads itself, no tap needed
    /* Auto-kick the 5-day extremes scan in the background so the 5D Highs /
       5D Lows / Steady Flips groups have results by the time the user looks.
       Throttled via SCAN_CONCURRENCY against a bounded ~100-item candidate
       pool (top vol + top price), never the full 4500-item mapping. */
    runFiveDayScan();
    runSteadyFlipsScan();

    const sb = $("#suggestBox"), qInput = $("#query");
    /* Empty-input focus → show recently-viewed items so you can hop back
       between two or three items without retyping. */
    function showRecents() {
      const items = recentItems
        .map(id => mapping.find(x => String(x.id) === id))
        .filter(x => x && (membersOn || !x.members))
        .slice(0, 10);
      if (!items.length) { sb.style.display = "none"; return; }
      sb.innerHTML = `<div class="suggest-header">Recent</div>`
        + items.map(x => `<div data-id="${x.id}"><img src="${itemIconUrl(x.id)}" alt="${x.name} icon">${x.name}</div>`).join("");
      sb.style.display = "block";
    }
    qInput.addEventListener("input", () => {
      const q = qInput.value.trim().toLowerCase();
      if (!q) { showRecents(); return; }
      const list = mapping.filter(x => x.name.toLowerCase().includes(q) && (membersOn || !x.members)).slice(0, 40);
      sb.innerHTML = list.map(x => `<div data-id="${x.id}"><img src="${itemIconUrl(x.id)}" alt="${x.name} icon">${x.name}</div>`).join("");
      sb.style.display = list.length ? "block" : "none";
    });
    qInput.addEventListener("focus", () => { if (!qInput.value.trim()) showRecents(); });
    sb.addEventListener("click", e => {
      const id = e.target.closest('div')?.dataset?.id;
      if (id) { const m = mapping.find(x => String(x.id) === String(id)); if (m) {
        /* Read the box BEFORE setItem clears it: the same dropdown serves
           typed results and the recents list, and which one you clicked is
           the only thing separating "found by searching" from "went back to
           something I already had". */
        const typed = qInput.value.trim();
        sb.style.display = "none"; qInput.blur(); setItem._userPicked = false; setItem(m);
        /* After setItem, so track()'s default item_id/item_name describe the
           item that was chosen rather than the one being left. The virtual
           page_view already records WHICH item; this records HOW it was
           reached, which the page_view cannot say. */
        track('search_select', { via: typed ? 'search' : 'recent', query_len: typed.length });
      } }
    });
    document.addEventListener("click", e => { if (e.target !== qInput) sb.style.display = "none"; });

    document.querySelectorAll(".view-btn").forEach(b => {
      b.onclick = () => {
        document.querySelectorAll(".view-btn").forEach(x => x.classList.remove("active"));
        const from = view;
        b.classList.add("active"); view = preferredView = b.dataset.view; zoom = 1.0; yScale = 1; yOffset = 0;
        setItem._userPicked = true;
        keepActiveViewVisible();
        refreshChart();
        /* `timeframe` is the one they picked (track() reads the global, which
           is already reassigned); `from` says what they left. */
        track('timeframe_change', { from: from });
      };
    });
    /* Dragging/wheeling the strip changes which edge has hidden pills. */
    const _tb = document.getElementById('timeToolbar');
    if (_tb) _tb.addEventListener('scroll', updateToolbarFades, { passive: true });

    /* Class-based mode switch — there's a second, larger mode pill in the
       sidebar on desktop; both share the .mp-f2p / .mp-p2p classes so a
       click on either updates both, and the .active state on both stays in
       sync with membersOn. */
    function setMembersMode(on) {
      const changed = membersOn !== on;
      membersOn = on;
      try { localStorage.setItem('ge_members', on ? 'true' : 'false'); } catch (e) {}
      document.querySelectorAll('.mp-f2p').forEach(el => {
        el.classList.toggle('active', !on);
        if (el.hasAttribute('role')) el.setAttribute('aria-selected', String(!on));
      });
      document.querySelectorAll('.mp-p2p').forEach(el => {
        el.classList.toggle('active', on);
        if (el.hasAttribute('role')) el.setAttribute('aria-selected', String(on));
      });
      if (!changed) return;
      /* After the `changed` guard on purpose: clicking F2P while already on
         F2P is a real click but not a real switch, and counting it would
         inflate whichever mode people happen to already be in. This function
         has no callers but the two onclick handlers below, so it cannot fire
         on boot or on a restored preference. */
      track('members_mode', { mode: on ? 'p2p' : 'f2p' });
      dayHiLoCache = {}; steadyFlipsCache = []; scanStatus = { fived: 'idle', steady: 'idle' };
      renderWatchlist();
      resetFlipFinder();
      if (!on && selected?.members) {
        const landing = mapping.find(x => String(x.id) === LANDING_ID);
        if (landing) { setItem._userPicked = false; setItem(landing); }
      }
    }
    document.querySelectorAll('.mp-f2p').forEach(el => { el.onclick = () => setMembersMode(false); });
    document.querySelectorAll('.mp-p2p').forEach(el => { el.onclick = () => setMembersMode(true); });

    /* Bell now opens the Notification Center modal. The master toggle,
       permission request, test-fire button, and per-Bank-stack thresholds
       all live inside that panel — see openNotifCenter / renderNotifCenter
       further up. The bell icon glyph still flips 🔔 / 🔕 to reflect state. */
    applyNotifBtn();
    $("#btnNotif").onclick = () => openNotifCenter();
    $('#closeNotifCenter').onclick = () => closeNotifCenter();
    $('#notifCenterModal').addEventListener('click', (ev) => { if (ev.target === $('#notifCenterModal')) closeNotifCenter(); });

    /* Help / glossary modal wiring. */
    $('#btnHelp').onclick = () => { $('#helpModal').style.display = 'flex'; };
    $('#closeHelp').onclick = () => { $('#helpModal').style.display = 'none'; };
    $('#helpModal').addEventListener('click', (ev) => { if (ev.target === $('#helpModal')) $('#helpModal').style.display = 'none'; });

    /* Mobile ⋯ overflow menu. On desktop the wrapper is display:contents so
       this just no-ops visually (the buttons are inline). On mobile, tap the
       ⋯ to open the dropdown; it closes on any action tap or an outside tap. */
    const moreBtn = $('#btnMore'), moreMenu = $('#moreActions'), moreBackdrop = $('#drawerBackdrop');
    /* Backdrop tracks the drawer so the dimmer can't be left stranded over
       the page if the two ever get toggled from different places. */
    const setMore = (open) => {
      moreMenu.classList.toggle('open', open);
      if (moreBackdrop) moreBackdrop.classList.toggle('open', open);
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const closeMore = () => setMore(false);
    moreBtn.onclick = (ev) => {
      ev.stopPropagation();
      setMore(!moreMenu.classList.contains('open'));
    };
    /* Close after any action inside fires (Refresh/Alerts/Bank/Help) and on
       any nav link tap, so the drawer isn't still open behind the new page
       if the browser restores this one from bfcache. */
    moreMenu.addEventListener('click', (ev) => {
      if (ev.target.closest('.drawer-head') && !ev.target.closest('#drawerClose')) return;
      closeMore();
    });
    if (moreBackdrop) moreBackdrop.addEventListener('click', closeMore);
    /* .about-section carries content-visibility:auto, so it may be unlaid-out
       when the hash jump fires and a raw anchor lands short of the note.
       Scroll it ourselves on the next frame (after the drawer has begun
       closing) and flash it, so it's obvious where you were sent. */
    const rsnLink = moreMenu.querySelector('.drawer-rsn');
    if (rsnLink) rsnLink.addEventListener('click', (ev) => {
      const target = document.getElementById('meet-the-dev');
      /* Prerendered item pages omit the about/FAQ prose — 797 identical
         copies of it is 35MB of boilerplate and, for search, 797 pages whose
         bulk is the same text. Send the link to the homepage's copy rather
         than letting it quietly do nothing there. */
      if (!target) { window.location.href = '/#meet-the-dev'; return; }
      ev.preventDefault();
      closeMore();
      requestAnimationFrame(() => {
        try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        catch (e) { target.scrollIntoView(); }
        target.classList.add('jump-flash');
        setTimeout(() => target.classList.remove('jump-flash'), 1600);
      });
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && moreMenu.classList.contains('open')) closeMore();
    });
    document.addEventListener('click', (ev) => {
      if (moreMenu.classList.contains('open') && !moreMenu.contains(ev.target) && ev.target !== moreBtn && !moreBtn.contains(ev.target)) closeMore();
    });

    /* Tapping a grade "?" chip opens the glossary (mobile can't hover the
       title tooltip). stopPropagation so it doesn't also toggle the buy/sell
       price-box selection it lives inside. */
    document.addEventListener('click', (ev) => {
      if (ev.target.classList && ev.target.classList.contains('pg-help')) {
        ev.stopPropagation();
        $('#helpModal').style.display = 'flex';
      }
    }, true);

    /* Portfolio wiring. */
    $('#btnPortfolio').onclick = () => openPortfolio();
    $('#closePortfolio').onclick = () => closePortfolio();
    $('#portfolioModal').addEventListener('click', (ev) => { if (ev.target === $('#portfolioModal')) closePortfolio(); });
    $('#pfForm').onsubmit = (ev) => {
      ev.preventDefault();
      const hint = $('#pfHint');
      hint.classList.remove('error');
      if (!selected || overMaxData[String(selected.id)]) {
        hint.textContent = 'Select a regular GE item first.'; hint.classList.add('error'); return;
      }
      const qty = parseOSRSNumber($('#pfQty').value);
      const cost = parseOSRSNumber($('#pfCost').value); // optional — 0 means "don't track P&L"
      const alertRaw = $('#pfAlert').value.trim();
      const alertPct = alertRaw ? Math.abs(parseFloat(alertRaw.replace('%', ''))) : 0;
      if (qty <= 0) { hint.textContent = 'Enter how many you hold (qty).'; hint.classList.add('error'); return; }
      const existing = portfolio.find(h => String(h.itemId) === String(selected.id));
      if (existing) {
        existing.qty = qty;
        existing.cost = cost || 0;
        existing.alertPct = alertPct || 0; existing.alertedDir = null;
      } else {
        portfolio.push({ itemId: String(selected.id), name: selected.name, qty, cost: cost || 0, alertPct: alertPct || 0, alertedDir: null });
      }
      savePortfolio();
      $('#pfQty').value = ''; $('#pfCost').value = ''; $('#pfAlert').value = '';
      hint.textContent = cost > 0
        ? `Stashed ${selected.name} — ${qty.toLocaleString()} @ ${cost.toLocaleString()} gp cost`
        : `Stashed ${selected.name} — ${qty.toLocaleString()} held`;
      renderPortfolio();
    };

    /* Pulls a fresh /latest snapshot and repaints everything that depends on
       it. Runs on the 5-min timer below AND on demand from the Refresh
       button, so a user who wants current numbers right now doesn't have to
       reload the whole page (which was re-fetching the item list, mapping
       data, etc. just to get new prices). */
    async function refreshLivePrices() {
      latest = await loadLatest();
      lastLiveFetchAt = Math.floor(Date.now() / 1000);
      updateFootFresh();
      dayHiLoCache = {}; // refresh recent-peak data so the glow stays current
      scanStatus.fived = 'idle'; // let runFiveDayScan re-populate against fresh extremes
      runFiveDayScan();
      renderWatchlist();
      firePortfolioAlerts();
      if ($('#portfolioModal').style.display === 'flex') renderPortfolio();
      if ($('#notifCenterModal').style.display === 'flex') renderNotifCenter();
      if (selected && !overMaxData[String(selected.id)]) {
        const node = latest.data[String(selected.id)];
        liveBuyRaw = node?.low ?? node?.avgLowPrice ?? 0;
        liveSellRaw = node?.high ?? node?.avgHighPrice ?? 0;
        liveBuyTime = node?.lowTime ?? null;
        liveSellTime = node?.highTime ?? null;
        $("#tickerLivePrice").innerHTML = `${fmtGp(liveSellRaw)} <span class="tlp-gp">gp</span>`;
        const targets = computeViewTargets(node, selected.id);
        /* Leave a manually-nudged side alone — otherwise this refresh
           (every price tick) would stomp the "we're a few gp off" tweak
           right back to the raw recommendation before the user even
           acts on it. */
        if (!buyOverridden) recommendedBuy = targets.buy;
        if (!sellOverridden) recommendedSell = targets.sell;
        renderTargetBoxes();

        refreshItemInsights(selected, node);
        queueDraw();
      }
      ensureFlipCard();
    }
    setInterval(() => { refreshLivePrices().catch(() => {}); }, 300000);
    setInterval(tickLiveAge, 15000);

    /* Manual refresh: spin the icon and briefly disable the button so a
       double-tap can't fire two overlapping fetches; re-enables even if the
       fetch fails so a flaky connection doesn't brick the button. */
    $('#btnRefreshPrices').onclick = async () => {
      const btn = $('#btnRefreshPrices');
      if (btn.disabled) return;
      /* Reset first and synchronously: the button is gold precisely because
         there's something to put back, and that should land on the next
         frame rather than waiting on the price fetch (which can be slow, or
         fail entirely). Clearing the overrides before refreshLivePrices()
         also lets its own "leave a nudged side alone" guard fall through, so
         the fresh quote repopulates both targets. */
      /* Read the dirty flag BEFORE the reset clears it — that bit is the
         whole question here: is this button used to refresh prices, or to
         undo a zoom/nudge? They are two different features wearing one
         icon, and the answer decides whether they should stay that way. */
      const wasDirty = viewIsDirty();
      track('refresh_click', { mode: wasDirty ? 'reset_view' : 'refresh' });
      if (wasDirty) { resetChartView(); restoreEngineTargets(); syncChartReset(); }
      btn.disabled = true;
      const icon = btn.querySelector('.ui-ic');
      if (icon) icon.classList.add('ic-spin');
      try {
        await refreshLivePrices();
      } catch (e) {
      } finally {
        if (icon) icon.classList.remove('ic-spin');
        btn.disabled = false;
      }
    };

    resizeCanvas();

    /* Landing item priority:
         1. ?q=<item-name> in the URL  — so deep links from search / shares /
            old analytics referrers actually land on the right item.
         2. Last item the user viewed (localStorage).
         3. Gilded scimitar default.
         4. Ruby as a last resort.
       F2P / Members mode is respected — won't restore a members item in F2P. */
    const eligible = (m) => m && (membersOn || !m.members);
    /* A prerendered page states its item in the head, so the app does not
       have to infer it from a URL it no longer carries a ?q= in. Falls back
       to ?q= for every item without a static page, and for the homepage. */
    const urlQ = (() => {
      try {
        if (window.__PGE_ITEM__ && window.__PGE_ITEM__.name) return window.__PGE_ITEM__.name;
        return new URLSearchParams(window.location.search).get('q');
      } catch (e) { return null; }
    })();
    const urlItem = urlQ ? mapping.find(x => x.name.toLowerCase() === urlQ.toLowerCase()) : null;
    /* A ?q= deep link must ALWAYS resolve to its item. Googlebot and shared
       links arrive with no saved prefs — i.e. F2P mode — and members-only
       items used to fail eligible() and fall back to the brand homepage
       (canonical https://pocketge.com/), which silently de-indexed every
       members item. Flip to P2P for this session only (not persisted, so a
       link never rewrites the user's saved mode). */
    if (urlItem && urlItem.members && !membersOn) {
      membersOn = true;
      document.querySelectorAll('.mp-p2p').forEach(el => { el.classList.add('active'); if (el.hasAttribute('role')) el.setAttribute('aria-selected', 'true'); });
      document.querySelectorAll('.mp-f2p').forEach(el => { el.classList.remove('active'); if (el.hasAttribute('role')) el.setAttribute('aria-selected', 'false'); });
    }
    const lastId = (() => { try { return localStorage.getItem('ge_lastItem'); } catch (e) { return null; } })();
    const last = lastId ? mapping.find(x => String(x.id) === lastId) : null;
    /* No ?q=, no remembered last item = a brand-new visitor, and since the
       landing interstitial is gone this chart is now the first thing they
       ever see. Open on something that has actually moved in the last 24h
       (pickLandingItem) rather than a blind roll of the pool, so the first
       frame shows a market doing something.
       The old random pick stays as the rung below it: if the 24h feed is
       missing or every candidate fails the volume floor, a random staple is
       still a better chart than a fixed one. Pre-resolved Uncut diamond,
       then Ruby, remain the hard fallbacks. */
    const mover = pickLandingItem(eligible);
    const randomId = pickLandingId();
    const randomLanding = mapping.find(x => String(x.id) === randomId);
    const landing = eligible(urlItem) ? urlItem
                  : eligible(last) ? last
                  : mover ? mover
                  : eligible(randomLanding) ? randomLanding
                  : eligible(mapping.find(x => String(x.id) === LANDING_ID)) ? mapping.find(x => String(x.id) === LANDING_ID)
                  : mapping.find(x => x.name.toLowerCase() === "ruby");
    if (landing) {
      setItem._userPicked = false;
      /* Only "itemize" the page (rewrite URL to /?q=Name, canonical to item,
         title to "<Item> - PocketGE") when the visitor came in with an
         explicit ?q= deep link. Otherwise the homepage stays clean brand
         metadata so a Google crawl of "/" indexes the BRAND page. */
      setItem(landing, { keepHomepage: !eligible(urlItem) });
      /* Hand over to the top recommended flip when the scan lands — but ONLY
         for a genuinely new arrival. A ?q= deep link came for a named item
         and a returning visitor has a remembered one; moving either of them
         off it would be taking the page away from someone who asked for it.
         Both cases are excluded by requiring that `landing` was the fallback
         pick rather than urlItem or last. See maybeLandOnFlip. */
      if (!eligible(urlItem) && !eligible(last)) armFlipLanding(landing.id);
    }

    /* Deep links (RuneLite's right-click "Search PocketGE for X", shared
       links, etc.) only reach a FRESH tab. manifest.json declares
       display:"standalone", so once installed as a PWA, Chrome's Launch
       Handler API defaults to client_mode "focus-existing": reopening
       https://pocketge.com/?q=NewItem while the app is already open just
       focuses the existing window WITHOUT navigating it — location.search
       never changes, so the item never updates. launchQueue is the
       documented way to still receive that URL and react manually. */
    const jumpToQueryItem = (q) => {
      const item = q ? mapping.find(x => x.name.toLowerCase() === q.toLowerCase()) : null;
      if (!item || item === selected) return;
      if (item.members && !membersOn) {
        membersOn = true;
        document.querySelectorAll('.mp-p2p').forEach(el => { el.classList.add('active'); if (el.hasAttribute('role')) el.setAttribute('aria-selected', 'true'); });
        document.querySelectorAll('.mp-f2p').forEach(el => { el.classList.remove('active'); if (el.hasAttribute('role')) el.setAttribute('aria-selected', 'false'); });
      }
      if (eligible(item)) setItem(item);
    };
    if ('launchQueue' in window) {
      window.launchQueue.setConsumer((launchParams) => {
        if (!launchParams.targetURL) return;
        try { jumpToQueryItem(new URL(launchParams.targetURL).searchParams.get('q')); } catch (e) {}
      });
    }
    /* Fallback for browsers without the Launch Handler API (Firefox,
       Safari): if the tab is merely refocused rather than navigated and
       the address bar's ?q= no longer matches what's on screen, catch up
       as soon as it's visible again. */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      try { jumpToQueryItem(new URLSearchParams(window.location.search).get('q')); } catch (e) {}
    });

    updateFootFresh();
    updateFootUpdated();
    syncBuildInfo();

    /* The landing-screen gate lived here. Removed with the screen itself —
       there is nothing left to gate. ge_visited survives because it has a
       SECOND job that has nothing to do with the landing page: it is how
       applyTitleBadge tells a returning human from a first render, so a
       crawler never indexes "(2) Ruby Price OSRS...". That check reads
       isReturningVisitor, captured before this line runs, so setting the
       flag here cannot make the current render look like a return visit. */
    try { localStorage.setItem('ge_visited', '1'); } catch (e) {}
  } catch (e) {
    console.error(e);
  }
})();

/* Resizable sidebar (desktop) — drag the divider to set the watchlist width,
   clamped 230–560px, persisted to localStorage. Width is applied via the
   --wl-width CSS variable; the mobile media queries override with explicit
   widths so this only affects the side-by-side desktop layout. The chart
   reflows live (rAF-throttled) and double-click resets to the default. */
(function initSidebarResize() {
  const handle = document.getElementById('wlResize');
  const root = document.documentElement;
  const wl = document.querySelector('.watchlist-container');
  const MIN = 230, MAX = 560, DEFAULT = 300;
  const saved = parseInt(localStorage.getItem('ge_wlWidth') || '', 10);
  if (saved >= MIN && saved <= MAX) root.style.setProperty('--wl-width', saved + 'px');
  if (!handle || !wl) return;
  let startX = 0, startW = 0, dragging = false, raf = 0;
  const apply = (clientX) => {
    const dx = clientX - startX;
    const w = Math.max(MIN, Math.min(MAX, startW - dx)); // drag left grows the right-hand sidebar
    root.style.setProperty('--wl-width', w + 'px');
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (typeof resizeCanvas === 'function') resizeCanvas(); });
  };
  const begin = (clientX) => {
    // Matches the CSS breakpoint that shows .wl-resize (see .wl-resize's
    // min-width:640px rule) — was stuck at the old 1024px threshold, so the
    // handle was visible but inert between 640-1023px.
    if (window.innerWidth < 640) return;
    dragging = true; startX = clientX; startW = wl.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize';
  };
  const end = () => {
    if (!dragging) return;
    dragging = false; handle.classList.remove('dragging');
    document.body.style.userSelect = ''; document.body.style.cursor = '';
    const w = Math.round(wl.getBoundingClientRect().width);
    if (w) { try { localStorage.setItem('ge_wlWidth', String(w)); } catch (e) {} }
    if (typeof resizeCanvas === 'function') resizeCanvas();
  };
  handle.addEventListener('mousedown', (e) => { begin(e.clientX); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => { if (dragging) apply(e.clientX); });
  window.addEventListener('mouseup', end);
  handle.addEventListener('touchstart', (e) => { begin(e.touches[0].clientX); }, { passive: true });
  window.addEventListener('touchmove', (e) => { if (dragging) apply(e.touches[0].clientX); }, { passive: true });
  window.addEventListener('touchend', end);
  handle.addEventListener('dblclick', () => {
    root.style.setProperty('--wl-width', DEFAULT + 'px');
    try { localStorage.setItem('ge_wlWidth', String(DEFAULT)); } catch (e) {}
    if (typeof resizeCanvas === 'function') resizeCanvas();
  });
})();

/* Vertical chart resize — the height counterpart to the sidebar's width
   handle. Same interaction contract as .wl-resize: drag to size, double-click
   to reset, choice persisted, and resizeCanvas() called on every frame so the
   bitmap tracks the box instead of being stretched to fit it afterwards. */
(function chartHeightResizer() {
  const handle = document.getElementById('chResize');
  const box = document.querySelector('.chart-container');
  if (!handle || !box) return;
  const MIN = 240;
  /* Has to sit ABOVE each layout's CSS default (desktop 100dvh - 248px,
     portrait 52vh) or dragging down would shrink the chart — the first thing
     tried, and it would look broken. Both layouts scroll, so growing past
     the fold just pushes what's underneath down, which is a legitimate thing
     to want from a "make the chart bigger" handle. Bounded so the page can't
     become one unscrollable chart. */
  /* One ceiling, and it is the DRAG's ceiling — deliberately generous.
     A 55% portrait cap lived here briefly to stop the page opening as a
     full-screen chart. It did that, but it also capped the drag, so asking for
     a bigger chart on a phone silently stopped halfway. Those are two different
     intents and they needed separating: what the page OPENS at is the CSS
     default (42svh) plus the load-time clamp in applyStored below; how far you
     can DRAG is this, and there is no good reason to stop someone who is
     deliberately asking for a taller chart. Being unable to scroll past it was
     the original complaint, and that is fixed at the touch-action level now,
     so a tall chart is no longer a trap. */
  /* `innerHeight - 120` is a sane ceiling on a tall window and nonsense on a
     short one: a landscape phone is ~390px, so it computes to 270 — BELOW the
     ~303px the chart already is there, which made dragging down shrink the
     chart instead of growing it. Measured at 932x430: 344 -> 320.
     Landscape gets a multiple of the viewport instead. 1.6 screens is enough
     to push the quick-facts row and the 30-Day Range below the fold, which is
     the whole point of the gesture there, while still bounded so the page
     cannot become one unscrollable chart. */
  const maxH = () => Math.max(MIN + 80, window.innerHeight - 120,
                              landscapeMQ.matches ? Math.round(window.innerHeight * 1.6) : 0);
  /* Whether resizing is live at all is decided by the CSS, not repeated here
     — one breakpoint list to keep in sync instead of two. EITHER control
     counts: on touch the handle is display:none and the Max button is the
     only way in, and reading the handle alone would have made applyStored()
     drop every saved height on a phone. */
  const tallBtn = document.getElementById('ctTall');
  const shown = (el) => !!el && getComputedStyle(el).display !== 'none';
  const enabled = () => shown(handle) || shown(tallBtn);
  /* A height chosen on a phone must not follow you to the desktop layout,
     and vice versa: 700px is a reasonable chart on a monitor and most of a
     phone screen. Desktop keeps the original key so heights already saved
     there survive this change. */
  const portraitMQ = window.matchMedia('(max-width: 640px)');
  /* Three layouts, three keys. Landscape phone used to fall through to the
     desktop key by omission — it had no handle, so nothing could be saved
     under it; now that it does, a 300px chart chosen on a phone held sideways
     would otherwise turn up on a monitor. */
  const landscapeMQ = window.matchMedia('(max-height: 600px) and (orientation: landscape) and (pointer: coarse)');
  const heightKey = () => portraitMQ.matches ? 'ge_chartHeight_p'
                        : landscapeMQ.matches ? 'ge_chartHeight_l'
                        : 'ge_chartHeight';

  const setH = (h) => {
    box.style.setProperty('--chart-h', Math.round(h) + 'px');
    box.classList.add('user-sized');
  };
  const unset = () => {
    box.classList.remove('user-sized');
    box.style.removeProperty('--chart-h');
  };
  /* The BUTTON's target is the SCREEN, not maxH(). maxH() is the DRAG's
     ceiling and is deliberately generous — 1.6 viewports in landscape, so
     that someone pulling the handle down can keep going. Tapping is not
     pulling: it is one gesture with one outcome, and it should land
     somewhere you can defend without a second gesture to undo it.
     Measured on a 932x430 landscape phone: the chart is 300px at rest and
     already reaches within 53px of the bottom of the screen, so the drag
     ceiling of 688 was more than twice the chart and buried everything
     under it. There simply is not much unused space to claim there, and the
     button now claims exactly that much: the chart's bottom meets the bottom
     of the screen and stops.
     Portrait is barely affected, which is the check that this is the right
     rule rather than a landscape special case — 724 before, 736 now.
     chartTop is a DOCUMENT coordinate, so this is the same number whatever
     the page is scrolled to, and nothing above the chart moves when the
     chart grows. */
  const fitH = () => {
    const topDoc = box.getBoundingClientRect().top + window.scrollY;
    return Math.max(MIN, Math.min(maxH(), Math.round(window.innerHeight - topDoc)));
  };
  /* Is the chart sitting at that height right now? Compared live rather than
     against a stored flag, so a rotate or a resize that moves the screen
     leaves the button telling the truth. The 2px slack absorbs setH's
     rounding. */
  const atMax = () => box.classList.contains('user-sized') &&
    Math.abs(parseInt(box.style.getPropertyValue('--chart-h'), 10) - fitH()) <= 2;
  const syncTall = () => {
    if (!tallBtn) return;
    const on = atMax();
    tallBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    tallBtn.title = on ? 'Back to the default chart height' : 'Expand the chart to full height';
  };
  const clear = () => {
    unset();
    try { localStorage.removeItem(heightKey()); } catch (e) {}
    if (typeof resizeCanvas === 'function') resizeCanvas();
    syncTall();
  };
  if (tallBtn) tallBtn.addEventListener('click', () => {
    const goingUp = !atMax();
    if (goingUp) {
      const h = fitH();
      setH(h);
      /* Persisted the same way a finished drag is, under the same per-layout
         key, so the two controls cannot disagree about what was chosen. */
      try { localStorage.setItem(heightKey(), String(Math.round(h))); } catch (e) {}
      if (typeof resizeCanvas === 'function') resizeCanvas();
      syncTall();
    } else {
      clear();
    }
    track('chart_max_toggle', { state: goingUp ? 'on' : 'off' });
  });
  /* Re-read on every breakpoint change (rotate, resize, desktop <-> phone):
     the stored height belongs to the layout, so crossing the boundary has to
     load that layout's value or drop back to its default. */
  const applyStored = () => {
    let v = NaN;
    try { v = parseInt(localStorage.getItem(heightKey()) || '', 10); } catch (e) {}
    if (enabled() && v >= MIN) setH(Math.min(v, maxH())); else unset();
    syncTall();
  };
  applyStored();
  /* Both queries, now that both name a layout with its own saved height. A
     phone rotating portrait <-> landscape crosses portraitMQ too, but a wide
     short window growing tall (a tablet, a resized browser) crosses only the
     landscape one — and that is exactly the case where the stored key changes
     underneath us. */
  const _onLayoutMQ = () => {
    applyStored();
    if (typeof resizeCanvas === 'function') resizeCanvas();
  };
  [portraitMQ, landscapeMQ].forEach(mq => {
    if (mq.addEventListener) mq.addEventListener('change', _onLayoutMQ);
    else if (mq.addListener) mq.addListener(_onLayoutMQ);
  });

  let startY = 0, startH = 0, dragging = false, raf = 0;
  const apply = (clientY) => {
    const h = Math.max(MIN, Math.min(maxH(), startH + (clientY - startY)));
    setH(h);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (typeof resizeCanvas === 'function') resizeCanvas(); });
  };
  const begin = (clientY) => {
    if (!enabled()) return;
    dragging = true; startY = clientY; startH = box.getBoundingClientRect().height;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'row-resize';
  };
  const end = () => {
    if (!dragging) return;
    dragging = false; handle.classList.remove('dragging');
    document.body.style.userSelect = ''; document.body.style.cursor = '';
    const h = Math.round(box.getBoundingClientRect().height);
    if (h) { try { localStorage.setItem(heightKey(), String(h)); } catch (e) {} }
    if (typeof resizeCanvas === 'function') resizeCanvas();
    syncTall();
  };
  handle.addEventListener('mousedown', (e) => { begin(e.clientY); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => { if (dragging) apply(e.clientY); });
  window.addEventListener('mouseup', end);
  handle.addEventListener('touchstart', (e) => { begin(e.touches[0].clientY); }, { passive: true });
  window.addEventListener('touchmove', (e) => { if (dragging) apply(e.touches[0].clientY); }, { passive: true });
  window.addEventListener('touchend', end);
  handle.addEventListener('dblclick', clear);
  /* A height saved on a tall window would otherwise bury the controls on a
     short one — re-clamp rather than dropping the preference, so going back
     to the big screen restores what was set there. */
  window.addEventListener('resize', () => {
    if (!box.classList.contains('user-sized')) return;
    const cur = parseInt(box.style.getPropertyValue('--chart-h'), 10);
    const cap = maxH();
    if (cur > cap) { box.style.setProperty('--chart-h', cap + 'px'); if (typeof resizeCanvas === 'function') resizeCanvas(); }
    syncTall();
  });
})();

/* ── Favorites / Find Opportunities splitter ─────────────────────────────
   Drag the divider to trade height between the two lists.

   This drives the FAVOURITES list's height, not Find Opportunities'. It used
   to be the other way round — a max-height cap on Find Opportunities — and
   that stopped working the moment the favourites list became content-sized
   instead of `flex: 1`. With both lists taking exactly their content, capping
   the lower one redistributes nothing: there is no greedy element to hand the
   space back to. Measured after that change, dragging the handle from the top
   of the column to the bottom moved it 0px.

   Sizing the list directly has no such dependency. Shrink its max-height and
   it scrolls, Find Opportunities follows it up, and the panel (which is
   content-height) closes up behind them. Grow it and the reverse. It behaves
   the same whether or not the content happens to fill the column, which is
   the property the old version quietly lacked.

   Stored as a PERCENT of the column, not a pixel height: the sidebar's height
   changes with the window, and a saved "320px" that was two thirds on a
   laptop is a sliver on a monitor and taller than the column on a short one.
   A percent survives both. */
(function () {
  const KEY = 'pge_fav_pct';
  /* One row, not three. The report was that Find Opportunities could not be
     dragged near the top of the list; a three-row floor is most of why, on
     top of the mechanism being dead. One row still shows the list is a list
     and keeps a drop target for the drag back down. */
  const MIN_FAV_PX = 41;                   // one watchlist row
  const MIN_OPPS_PX = 34;                  // its collapsed title bar
  const bar = document.getElementById('wlSplitter');
  const list = document.getElementById('watchlistContent');
  const wrap = document.querySelector('.watchlist-container');
  if (!bar || !list || !wrap) return;
  /* Measured against the COLUMN, which has a definite height and does not
     move when the lists resize — see the note on .watchlist-container. */
  const col = document.querySelector('.content-area') || wrap.parentElement;
  const colH = () => { const r = col.getBoundingClientRect(); return r.height > 0 ? r.height : 0; };

  /* How much room the list may claim: from where it starts down to the bottom
     of the column, less the handle and enough for Find Opportunities' own
     title bar. Its TOP is stable — everything above it (the modules, the two
     headers) is content-sized and unaffected by this drag — so this can be
     read mid-drag without the measurement chasing itself. */
  const room = () => {
    const listT = list.getBoundingClientRect().top;
    const colB = col.getBoundingClientRect().bottom;
    return Math.max(MIN_FAV_PX, colB - listT - bar.offsetHeight - MIN_OPPS_PX);
  };
  const clampPx = px => Math.max(MIN_FAV_PX, Math.min(room(), px));
  const pctOf = px => (px / Math.max(1, colH())) * 100;
  const pxOf = pct => (pct / 100) * colH();

  const apply = pct => {
    const h = colH();
    if (h > 0) wrap.style.setProperty('--fav-h', Math.round(clampPx(pxOf(pct))) + 'px');
  };
  const stored = () => {
    try { const v = parseFloat(localStorage.getItem(KEY)); return isFinite(v) ? v : null; }
    catch (e) { return null; }
  };
  const save = pct => { try { localStorage.setItem(KEY, pct.toFixed(1)); } catch (e) {} };

  let cur = stored();
  if (cur != null) apply(cur);
  /* The stored value is a percentage, so the pixels have to be re-derived
     whenever the column changes height. */
  window.addEventListener('resize', () => { if (cur != null) apply(cur); });

  /* Drag DOWN grows the favourites list, which is the direction the handle
     moves — the pointer's y IS the list's new bottom edge. */
  const pctFromY = (y) => pctOf(clampPx(y - list.getBoundingClientRect().top));

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    cur = pctFromY(e.clientY);
    apply(cur);
    e.preventDefault();
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('is-dragging');
    document.body.classList.remove('wl-resizing');
    if (cur != null) save(cur);
  };
  bar.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    bar.classList.add('is-dragging');
    document.body.classList.add('wl-resizing');
    /* Capture so the drag keeps tracking when the cursor outruns the 11px
       handle — which it always does. */
    try { bar.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  bar.addEventListener('pointermove', onMove);
  bar.addEventListener('pointerup', stop);
  bar.addEventListener('pointercancel', stop);
  /* Belt and braces: if the capture is lost (dev tools, alt-tab mid-drag) the
     pointerup may never reach the handle, and a stuck drag is unrecoverable
     without a reload. */
  window.addEventListener('pointerup', stop);
  window.addEventListener('blur', stop);

  /* Double-click clears the override entirely, back to "as tall as its rows". */
  bar.addEventListener('dblclick', () => {
    cur = null;
    wrap.style.removeProperty('--fav-h');
    try { localStorage.removeItem(KEY); } catch (e) {}
  });
  bar.addEventListener('keydown', (e) => {
    const stepPx = e.shiftKey ? 80 : 30;
    let d = 0;
    if (e.key === 'ArrowUp') d = -stepPx;         // up = less list, more Find Opportunities
    else if (e.key === 'ArrowDown') d = stepPx;
    else if (e.key === 'Home') { cur = pctOf(room()); apply(cur); save(cur); e.preventDefault(); return; }
    else if (e.key === 'End') { cur = pctOf(MIN_FAV_PX); apply(cur); save(cur); e.preventDefault(); return; }
    else return;
    const basePx = cur != null ? pxOf(cur) : list.getBoundingClientRect().height;
    cur = pctOf(clampPx(basePx + d));
    apply(cur); save(cur);
    e.preventDefault();
  });
})();

/* ── Sidebar height cap ──────────────────────────────────────────────────
   Hold the sidebar to the main column's height, so a long or expanded list
   scrolls inside the panel instead of growing the page.

   It has to be measured rather than expressed in CSS. `max-height: 100%`
   resolves against .content-area, whose height is the max of ITS children —
   including this one — so the percentage is circular and, when .wrap's height
   is indefinite, resolves to `none` outright. That is the same trap the
   splitter and the landscape cap both hit.

   The measurement is the main column's CONTENT height, summed from its
   children, NOT its box: the box is a stretched flex item whose height is the
   row's, which the sidebar helps decide. Summing the children reads only
   things the sidebar cannot influence — at these widths .chart-container is
   pinned between a min- and max-height 72px apart, both derived from the
   viewport, so it does not chase the value either. */
(function sidebarCap() {
  const area = document.querySelector('.content-area');
  const main = document.querySelector('.main-column');
  const side = document.querySelector('.watchlist-container');
  if (!area || !main || !side) return;
  /* Side-by-side layouts only — the same 641px the CSS uses. Stacked, the
     sidebar IS the page below the chart and capping it would just hide the
     list behind a second scrollbar. */
  const sideBySideMQ = window.matchMedia('(min-width: 641px)');
  /* "At least 15 before it scrolls" is a desktop promise: the narrower
     side-by-side band has neither the height to keep nor the room to spend. */
  const deskMQ = window.matchMedia('(min-width: 1024px)');
  const FAV_TARGET = 15;
  let last = -1, lastFloor = -1, raf = 0;
  /* Runs on its own, BEFORE the --main-h deadband below: adding a favourite
     changes what the panel needs without changing the main column at all, so
     gating this behind that deadband would leave the floor stale exactly when
     it matters. */
  const measureFloor = () => {
    const list = document.getElementById('watchlistContent');
    /* Not while the splitter is in charge. Dragging it sets --fav-h to size
       the list deliberately, and a floor pushing the other way would be the
       app arguing with the user about a height they just chose. */
    if (!deskMQ.matches || !list || side.style.getPropertyValue('--fav-h')) {
      if (lastFloor !== 0) {
        side.style.removeProperty('--fav-floor');
        side.style.removeProperty('--fav-min');
        lastFloor = 0;
      }
      return;
    }
    const rows = list.querySelectorAll('.wl-item');
    const rowH = rows.length ? rows[0].getBoundingClientRect().height : 0;
    if (!rowH) return;
    /* Every sibling counts at the height it CANNOT go below, not the height
       it happens to be. Find Opportunities is the one flexible child, and
       measuring it as-rendered made the floor chase it: expanding a scanner
       grew the panel, which gave the scanner more room, which grew the floor
       again — and in between, the list lost a row and started scrolling at
       eleven favourites. Costing it at its floor makes the panel height
       independent of the scanner's state, which puts the established rule
       back in force: with a fixed panel, shrink:100 against the list's
       shrink:1 means the SCANNER yields and scrolls, not the list. */
    let chrome = 0;
    for (const el of side.children) {
      if (el === list || getComputedStyle(el).display === 'none') continue;
      const cs = getComputedStyle(el);
      const floorPx = parseFloat(cs.minHeight);
      const h = el.getBoundingClientRect().height;
      chrome += (cs.flexShrink !== '0' && floorPx > 0) ? Math.min(h, floorPx) : h;
    }
    /* Plus the panel's OWN borders. chrome sums the children; the height this
       floor sets is the container's border box, and leaving the 1px top and
       bottom out left the list 2px short of 15 rows — 523px for a 525px
       need, i.e. fourteen rows and a sliver. */
    const frame = side.getBoundingClientRect().height - side.clientHeight;
    const reserve = Math.ceil(Math.min(rows.length, FAV_TARGET) * rowH);
    const need = Math.ceil(chrome + frame) + reserve;
    if (Math.abs(need - lastFloor) <= 1) return;
    lastFloor = need;
    side.style.setProperty('--fav-floor', need + 'px');
    /* Inherits down to .watchlist-content, which is where it is read. */
    side.style.setProperty('--fav-min', reserve + 'px');
  };
  const measure = () => {
    raf = 0;
    measureFloor();
    if (!sideBySideMQ.matches) { area.style.removeProperty('--main-h'); last = -1; return; }
    const gap = parseFloat(getComputedStyle(main).rowGap) || 0;
    let h = 0, n = 0;
    for (const el of main.children) {
      if (getComputedStyle(el).display === 'none') continue;
      h += el.getBoundingClientRect().height + (n ? gap : 0);
      n++;
    }
    h = Math.round(h);
    /* Only write on a real change. Setting the property can resize the row,
       which re-fires the observer — a 1px deadband is what stops that from
       becoming a loop. */
    if (Math.abs(h - last) <= 1) return;
    last = h;
    area.style.setProperty('--main-h', h + 'px');
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
  measure();
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(schedule);
    ro.observe(main);
    for (const el of main.children) ro.observe(el);
  }
  /* The floor needs its own trigger. Everything above watches the MAIN
     column, and favouriting an item changes what the sidebar needs without
     touching the main column at all — measured, the floor sat at its
     first-render value through 4, 15, 16 and 30 favourites.
     childList on the list rather than a ResizeObserver on the panel: we
     write --fav-floor to the panel, so observing its size would be observing
     our own writes. Nothing here ever mutates the list's children, so this
     cannot feed back. renderWatchlist empties and refills this element
     rather than replacing it, so one observer holds for the session. */
  if ('MutationObserver' in window) {
    const listEl = document.getElementById('watchlistContent');
    if (listEl) new MutationObserver(schedule).observe(listEl, { childList: true });
  }
  window.addEventListener('resize', schedule);
  if (sideBySideMQ.addEventListener) sideBySideMQ.addEventListener('change', schedule);
  else if (sideBySideMQ.addListener) sideBySideMQ.addListener(schedule);
  /* Expanding a scanner or the flip card changes the column's height without
     resizing the window. */
  document.addEventListener('click', schedule, true);
})();

/* PWA: register the service worker so the app is installable to the home
   screen (hides the iOS/Android URL bar). Failures are silent — the app still
   works fine without it. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
