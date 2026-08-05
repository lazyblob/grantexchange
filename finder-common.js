/* Shared by the standalone "flip finder" landing pages (high-vol-margins.html,
   low-vol-margins.html, biggest-losers-24h.html) — a small, independent
   reimplementation of just the price-fetch + margin/mover math from the main
   app's sidebar scanner (index.html), scoped to what a single static page
   needs for its own live top-10. Deliberately NOT shared code with index.html
   (that engine lives in one giant inline script, not built for import) — kept
   in sync by hand since this is a small, stable slice of the math (tax
   formula, margin, 24h mover %) that rarely changes. */
const PRICES_API = "https://prices.runescape.wiki/api/v1/osrs";
const LOW_VOL_THRESHOLD = 100000;
const TAX_EXEMPT_IDS = new Set([
  13190, 1755, 5325, 11364, 2347, 1733, 233, 5341, 8794, 5329, 5343, 1735, 952, 5331,
]);

function taxOf(sellPrice, exempt) {
  if (exempt || sellPrice < 50) return 0;
  return Math.min(5000000, Math.floor(sellPrice / 50));
}
function calculateTax(price, id) {
  return taxOf(price, TAX_EXEMPT_IDS.has(Number(id)));
}

async function jget(url) {
  const r = await fetch(url, { cache: "default" });
  if (!r.ok) throw new Error(url + " HTTP " + r.status);
  return await r.json();
}

function fmtGp(n) {
  const neg = n < 0;
  const a = Math.abs(Math.round(n));
  return (neg ? "-" : "") + a.toLocaleString();
}
function abbreviateNumber(n) {
  const neg = n < 0;
  const a = Math.abs(n);
  let out;
  if (a >= 1e9) out = (a / 1e9).toFixed(a >= 1e10 ? 1 : 2) + "B";
  else if (a >= 1e6) out = (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
  else if (a >= 1e3) out = (a / 1e3).toFixed(a >= 1e4 ? 1 : 2) + "K";
  else out = Math.round(a).toLocaleString();
  return (neg ? "-" : "") + out;
}

/** Fetches mapping + latest + 24h + volumes once, in parallel. Every finder
 *  page needs this same base set. */
async function loadFinderData() {
  const [mapping, latest, past24h, volumes] = await Promise.all([
    jget(PRICES_API + "/mapping"),
    jget(PRICES_API + "/latest"),
    jget(PRICES_API + "/24h"),
    jget(PRICES_API + "/volumes"),
  ]);
  return { mapping, latest, past24h, volumes };
}

function dailyVolume(id, data) {
  let v = data.volumes && data.volumes[String(id)];
  if (v == null) {
    const p = data.past24h.data[String(id)];
    v = p ? (p.highPriceVolume || 0) + (p.lowPriceVolume || 0) : 0;
  }
  return v || 0;
}

/** Live 1D margin rows (insta-buy/insta-sell spread after tax), split by
 *  volume tier — same filters as the sidebar's High/Low Vol Margins groups:
 *  both sides must have recent prints, margin has to be positive and not an
 *  absurd >70%-of-price outlier (usually a stale/bad print). */
function computeMarginRows(data, wantLowVol) {
  const out = [];
  for (const item of data.mapping) {
    if (!item.name) continue;
    const id = String(item.id);
    const node = data.latest.data[id];
    const p24 = data.past24h.data[id];
    if (!node || !(node.high > 0) || !(node.low > 0) || node.high <= node.low) continue;
    if (!p24 || !(p24.highPriceVolume > 0) || !(p24.lowPriceVolume > 0)) continue;
    const margin = node.high - node.low - calculateTax(node.high, item.id);
    if (!(margin > 0) || margin >= node.high * 0.7) continue;
    const lowVol = dailyVolume(id, data) < LOW_VOL_THRESHOLD;
    if (lowVol !== wantLowVol) continue;
    out.push({ item, margin, buy: node.low, sell: node.high, vol: dailyVolume(id, data) });
  }
  out.sort((a, b) => b.margin - a.margin);
  return out;
}

/** Live 24h losers — mid price vs 24h volume-weighted average mid, same
 *  volume floor and >=3% move filter as the sidebar's Biggest Losers group. */
function computeLoserRows(data) {
  const out = [];
  for (const item of data.mapping) {
    if (!item.name) continue;
    const id = String(item.id);
    const node = data.latest.data[id];
    const p24 = data.past24h.data[id];
    if (!node || !(node.high > 0) || !(node.low > 0)) continue;
    if (!p24 || !(p24.avgHighPrice > 0) || !(p24.avgLowPrice > 0)) continue;
    const curMid = (node.high + node.low) / 2;
    const avgMid = (p24.avgHighPrice + p24.avgLowPrice) / 2;
    if (!(avgMid > 0)) continue;
    const pct = ((curMid - avgMid) / avgMid) * 100;
    const vol = (p24.highPriceVolume || 0) + (p24.lowPriceVolume || 0);
    if (curMid >= 100 && vol >= LOW_VOL_THRESHOLD && pct <= -3) {
      out.push({ item, pct, price: curMid, vol: dailyVolume(id, data) });
    }
  }
  out.sort((a, b) => a.pct - b.pct);
  return out;
}

const NATURE_RUNE_ID = 561;

/** Live High Alchemy profit rows: an item's high alch value minus one
 *  nature rune's live cost minus the item's live buy price — the exact
 *  spell math, no invented numbers. Positive-only, sorted best first. Only
 *  items whose mapping entry carries a highalch value qualify (mostly
 *  equipment/weapons; raw materials and consumables mostly don't have one). */
function computeHighAlchRows(data) {
  const natureNode = data.latest.data[String(NATURE_RUNE_ID)];
  const natureCost = natureNode && natureNode.low > 0 ? natureNode.low : null;
  if (!natureCost) return [];
  const out = [];
  for (const item of data.mapping) {
    if (!item.name || !(item.highalch > 0)) continue;
    const id = String(item.id);
    const node = data.latest.data[id];
    if (!node || !(node.low > 0)) continue;
    const profit = item.highalch - natureCost - node.low;
    if (!(profit > 0)) continue;
    out.push({ item, profit, buy: node.low, highalch: item.highalch, vol: dailyVolume(id, data) });
  }
  out.sort((a, b) => b.profit - a.profit);
  return out;
}

/* Verified skilling recipes — deliberately a short, hand-curated list, not
   an attempt at a full recipe database. Each entry is a method stable and
   well-documented enough to bet on (unchanged for years, no ambiguity in
   the ratio), with its exact assumption spelled out on the page that uses
   it so it's auditable rather than a black box. Add to this list only for
   methods that are genuinely this certain — a wrong ratio here is worse
   than the page not existing. */
const STEEL_BAR_ID = 2353, CANNONBALL_ID = 2, CANNONBALLS_PER_BAR = 4;

/** Smithing: steel bar -> 4 cannonballs at a furnace (Dwarf Cannon quest,
 *  35 Smithing). Both sides are GE-tradeable, so this is pure price math
 *  once the 1:4 ratio is fixed — no external recipe dataset needed. */
function computeCannonballProfit(data) {
  const barNode = data.latest.data[String(STEEL_BAR_ID)];
  const ballNode = data.latest.data[String(CANNONBALL_ID)];
  if (!barNode || !(barNode.low > 0) || !ballNode || !(ballNode.high > 0)) return null;
  const barCost = barNode.low;
  const ballSell = ballNode.high;
  const tax = calculateTax(ballSell, CANNONBALL_ID);
  const netPerBall = ballSell - tax;
  const revenuePerBar = CANNONBALLS_PER_BAR * netPerBall;
  const profitPerBar = revenuePerBar - barCost;
  return { barCost, ballSell, tax, netPerBall, revenuePerBar, profitPerBar };
}

function itemIconUrl(id) {
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(String(id))}.png`;
}
