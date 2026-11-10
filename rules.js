// The deal rules that need no browser, network or state files: what counts as an OLED monitor listing, which
// listings are the same model, and when a price is far enough below normal to alert. Kept apart from scan.js so
// `npm test` can check them (test/): every false alert so far was a rule bug found on Zameel's phone.

export const MONITOR_OK = /monitor|odyssey|ultragear|alienware|aorus|\brog\b|mpg|mag\s?\d|agon|legion|evnia|mobiuz|xeneon|viewfinity|predator|nitro|xg\d{4}|\bAW\d{4}/i;
export const NOT_MONITOR = /watch|laptop|notebook|\btv\b|television|smartphone|phone|zenbook|ideapad|vivobook|cooler|ryujin|portable monitor|tablet|soundbar|headphone|projector|keyboard|mouse|\bsmps\b|\bpsu\b/i;
// model-code searches ("PG27AQWP", "27Q-10") also return parts and look-alike models: a VESA adapter "compatible with"
// the monitor, Lenovo's IPS LOQ 27Q-10, Samsung's IPS G5. Titles naming a non-OLED panel or an accessory are dropped.
export const ACCESSORY = /compatible with|\badapter\b|bracket|wall mount|monitor arm|mount kit|screen (protector|guard)|replacement|power supply|charger|\bcable\b|dust cover/i;
export const NON_OLED_PANEL = /\b(IPS|VA|TN|mini[\s-]?LED)\b/i;
export const RISKY_CONDITION = /open[\s-]?box|refurb|renewed|repackag|pre[\s-]?owned|\bused\b|b[\s-]?grade|display unit|demo/i;

export const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// "Amazon.com", "DealSea · Amazon" and "amazon" are the same retailer
export const retailerOf = (name) => String(name).toLowerCase().replace(/^dealsea · /, '').replace(/\.(com|in)$/, '').replace(/[^a-z0-9&]/g, '');
// product URLs often carry the full name + model code that a cut-off listing title lost
// (Samsung "Odyssey OLED G9 Gaming Monitor with 240..." -> ".../odyssey-oled-g9-g93sd-49-inch-oled-dual-qhd-ls49dg930swxxl/")
export const urlWords = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/[-_/.]+/g, ' '); } catch { return ''; } };
// screen size in inches from a title ("27 inch", 27", "68.4 cm"); 0 when the title gives none
export const inches = (t) => { const m = t.match(/(\d{2}(?:\.\d)?)\s*(?:-?\s?inch|in\b|["”])/i); if (m) return +m[1]; const c = t.match(/(\d{2,3}(?:\.\d+)?)\s*cm/i); return c ? +c[1] / 2.54 : 0; };

export function modelKey(title) {
  const t = title.toUpperCase().replace(/[™®‎‏]/g, '');
  // Samsung: the same panel is sold as "LS27FG500SN" (retailers) and "Odyssey OLED G5 G50SF" (Samsung's own pages);
  // fold both into size + Odyssey code (27G50SF) so they get compared with each other.
  const ls = t.match(/\bLS(\d{2})([A-Z])G(\d)(\d)\d[A-Z]{2}/);
  if (ls) return `${ls[1]}G${ls[3]}${ls[4]}S${ls[2]}`;
  const ody = t.match(/\bG([3-9])(\d)S([A-Z])\b/);
  if (ody) { const size = t.match(/\b(\d{2})(?:\.\d)?\s?(?:"|”|″|''|-?\s?INCH|IN\b)/); return `${size ? size[1] : ''}G${ody[1]}${ody[2]}S${ody[3]}`; }
  // Acer: family+size code (VG277U, X27U, XV275K); the trailing "Xbiip"/"W1bmiipprx" is just a bundle variant
  const acer = /ACER|NITRO|PREDATOR/.test(t) && t.match(/\b((?:VG|XV|XB|XZ|KG|CB|X)\d{2,3}[A-Z]{0,2})\b/);
  if (acer) return acer[1];
  const pats = [
    [/\bAW\d{4}[A-Z]{1,3}\b/, (m) => m[0]],                                 // Alienware
    [/\bAG\d{3}[A-Z0-9]{3,5}\b/, (m) => m[0]],                              // AOC Agon
    [/\bQ\d{2}G[A-Z0-9]{2,4}\b/, (m) => m[0]],                              // AOC Q27G..
    [/\b\d{2}G[A-Z]\d{2,3}[A-Z]{0,2}(?:-[A-Z])?\b/, (m) => m[0].replace(/-[A-Z]$/, '')], // LG 27GX790A
    [/\b(MAG|MPG|MEG)\s?(\d{3}[A-Z]{2,5})\b/, (m) => m[1] + m[2]],          // MSI
    [/\bX?G\d{2}[A-Z]{3,}[A-Z0-9]*\b/, (m) => m[0]],                        // ASUS XG27AQDMG
    [/\bPG\d{2}[A-Z]{3,}[A-Z0-9]*\b/, (m) => m[0]],
    [/\bXG\d{4}\b/, (m) => m[0]],                                           // ViewSonic
    [/\bF[OC]\d{2}[A-Z]\d[A-Z]?\b/, (m) => m[0]],                           // Gigabyte
    [/\bCO\d{2}DQ\b/, (m) => m[0]],
    [/\bEX\d{3}UZ\b/, (m) => m[0]],                                         // BenQ
    [/^(?!.*\bLOQ\b).*27Q-10/, () => 'LEGION27Q-10'],                       // Legion OLED, not the IPS LOQ 27Q-10
  ];
  for (const [re, f] of pats) { const m = t.match(re); if (m) return f(m); }
  return null;
}
// No model code in the title (e.g. Best Buy's "Acer - Predator 27" QD-OLED QHD 240Hz"): group by brand + size +
// resolution + refresh so the listing still shows up in the cheapest-prices table. Never used for alerts,
// because different models share the same specs.
export const BRANDS = /\b(ACER|ALIENWARE|DELL|ASUS|SAMSUNG|LG|MSI|GIGABYTE|AORUS|AOC|PHILIPS|HP|OMEN|LENOVO|CORSAIR|SONY|BENQ|VIEWSONIC|KTC|INNOCN|SCEPTRE|XIAOMI|ZOWIE)\b/;
export function specKey(title) {
  const t = title.toUpperCase();
  const brand = (t.match(BRANDS) || [])[1]; const size = (t.match(/\b(\d{2})(?:\.\d)?\s?(?:"|”|″|''|-?\s?INCH|IN\b)/) || [])[1];
  if (!brand || !size) return null;
  const res = /4K|UHD|3840/.test(t) ? '4K' : /5K|5120/.test(t) ? '5K' : /QHD|1440|2560/.test(t) ? 'QHD' : /FHD|1080/.test(t) ? 'FHD' : '';
  const hz = Math.max(0, ...[...t.matchAll(/(\d{3})\s?HZ/g)].map((m) => +m[1]));
  return `~${brand} ${size}" ${res}${hz ? ' ' + hz + 'Hz' : ''}`.replace(/\s+/g, ' ');
}

// brands Zameel banned (config bannedBrands): never listed, compared, alerted or shown anywhere
export const bannedRe = (cfg) => ((cfg.bannedBrands || []).length ? new RegExp('\\b(' + cfg.bannedBrands.join('|') + ')\\b', 'i') : /$^/);

// one source's raw items -> the OLED-monitor listings the rules keep, normalised (model key, shop, condition).
// Used by the early check (right after each source), the 5-minute shop check and the full comparison at the end.
//   knownOled: Set of model keys already known to be OLED; usualPrice(key): that model's usual price or 0
export function keepListings(src, items, { cfg, knownOled, usualPrice }) {
  const BANNED = bannedRe(cfg);
  // one product per URL (+ store): Flipkart lists each product twice, once with a cut-off title
  const byUrl = new Map();
  for (const i of items) { const k = i.url ? i.url + '|' + (i.store || '') : Symbol(); if (!byUrl.has(k) || byUrl.get(k).title.length < i.title.length) byUrl.set(k, i); }
  const good = [...byUrl.values()].filter((i) => {
    const full = i.title + ' ' + urlWords(i.url);
    if (!i.title || BANNED.test(full) || !MONITOR_OK.test(full) || NOT_MONITOR.test(i.title) || ACCESSORY.test(i.title) || i.price < cfg.minPrice || i.price > cfg.maxPrice) return false;
    if (/oled/i.test(full)) return true;
    // no "OLED" anywhere: only a known OLED model, no other panel type named, and not absurdly cheap for that model
    const key = modelKey(full); const usual = usualPrice(key);
    return knownOled.has(key) && !NON_OLED_PANEL.test(i.title) && (!usual || i.price >= usual * 0.5);
  });
  return good.map((g) => {
    const source = g.store ? `${src.name} · ${g.store}` : src.name;
    const key = modelKey(g.title) || modelKey(urlWords(g.url)); const spec = key ? null : specKey(g.title);
    return { ...g, source, retailer: ['smartprix', 'buyhatke'].includes(src.kind) ? retailerOf(g.store) : retailerOf(source),
      feed: !!src.feed, key: key || spec, generic: !key, risky: RISKY_CONDITION.test(g.title) };
  });
}

// One model's listings across shops -> { crazy, near }.
// "normal" = what OTHER retailers charge (never the listing itself, never deal-feed or open-box prices), plus the
// seeded street price, this model's own price history and BuyHatke's month average.
//   hist: this model's past prices (numbers); seed: its seeded street price or 0; bhK: BuyHatke stats or undefined
export function judgeModel(list, { hist, seed, bhK, cfg }) {
  const crazy = []; const near = [];
  const histRef = hist.length >= 6 ? median(hist) : 0;
  const lo = Math.min(hist.length ? Math.min(...hist) : Infinity, bhK?.low || Infinity);
  const lowestSeen = Number.isFinite(lo) ? lo : 0;
  const bhRef = bhK?.monthAvg || bhK?.yearAvg || 0;   // BuyHatke's 1-month average: an independent "normal price" signal
  for (const it of list) {
    if (it.peer || it.generic) continue;
    const others = list.filter((x) => x.retailer !== it.retailer && !x.risky && !x.feed).map((x) => x.price);
    const signals = [...others, ...(seed ? [seed] : []), ...(histRef ? [histRef] : []), ...(bhRef ? [bhRef] : [])];
    if (!signals.length) continue;
    const ref = median(signals);
    const vsRef = it.price / ref; const vsHist = histRef ? it.price / histRef : 1;
    const rec = { ...it, ref, basis: signals.length, lowestSeen, pct: Math.round((1 - vsRef) * 100), suspect: vsRef < 0.25 };
    // an alert needs 2+ independent prices: a single comparison is often a brand store's list price
    // (Samsung.com "From $499" vs a normal $329 street price) and would cry wolf
    const isCrazy = vsRef <= cfg.crazyThreshold || (vsHist <= cfg.historyThreshold && vsRef < 0.9);
    // a "deal" one shop has sat on for 3+ days is that shop's normal price, not a flash sale
    if (isCrazy && signals.length >= 2 && !(it.steadyDays >= 3)) crazy.push(rec);
    else if (isCrazy || vsRef <= cfg.nearMissThreshold) near.push(rec);
  }
  return { crazy, near };
}

// Price history keeps ONE point per hour (the hour's lowest normal price), 120 points = 5 days.
// It used to keep one per run: fine while scans were hourly, but at one scan per 15 minutes the "usual price"
// (median of the last 48 points) looked back only 12 hours, so half a day at a new price became the new normal.
export function pushHistory(arr, t, price, keep = 120) {
  const last = arr[arr.length - 1];
  if (last && last.t.slice(0, 13) === t.slice(0, 13)) last.price = Math.min(last.price, price);
  else arr.push({ t, price });
  return arr.slice(-keep);
}

// alert again only for a new listing, a price 5%+ lower than last time, or the same deal after a week
export const notRecent = (p, price, nowMs = Date.now()) => !p || price < p.price * 0.95 || nowMs - Date.parse(p.t) > 7 * 864e5;
