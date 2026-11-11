// BuyHatke (buyhatke.com, India's price-history site): two things we can't get anywhere else.
// STATUS 2026-11-10: priceData has answered {"data":{}} for every id since 2026-11-06 (dead at BuyHatke's end, not a
// wall). Its two jobs are covered elsewhere: Amazon ids -> azDetails below (Amazon itself), Flipkart -> the plain-HTTP
// search reader in shops.js (5-minute check) + the full scan. If priceData comes back it is used again automatically
// (the fast-check log line "BH priceData diag: ... keys N of M" shows N > 0).
//  1. LIVE PRICES by store id, plain HTTP, no login, not walled from GitHub's IPs:
//       POST https://search-new.bitbns.com/buyhatke/thunder/priceData  {"param":[[63,"<ASIN>"],[2,"<Flipkart pid>"]]}
//       -> {"63~**~<ASIN>":"{\"price\":39799,\"oos\":0}"}   (store codes: 63 Amazon, 2 Flipkart, others per shop)
//     Amazon's own search pages wall GitHub's IPs on most runs; this returns Amazon's price anyway.
//  2. PRICE HISTORY on each product page (buyhatke.com/<store url> redirects to it): all-time low, 1-month and
//     yearly averages, and the same product matched at other shops (MD Computers, Lenovo, ...). The page sits
//     behind a Cloudflare challenge that Chrome on GitHub's IPs never passes (tested 2026-11-02; the extension's
//     graph.bitbns.com history API is walled too), so this is OFF in config.json (historyPerRun: 0). It works
//     when the scan drives a real home browser (CDP_URL), and statsByKey/seriesFor simply return nothing otherwise.
// There is no product search in this API, so we keep a WATCHLIST (state/buyhatke.json) of every OLED monitor id
// the scan has seen: Amazon ASINs and Flipkart pids from our own listings, BuyHatke's monitor category, and the
// other-shop matches found on history pages. It only grows with real OLED listings, so it stays small.
const API = 'https://search-new.bitbns.com/buyhatke';
const HEADERS = { 'content-type': 'application/json', origin: 'https://buyhatke.com', referer: 'https://buyhatke.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' };
const STORE = { 63: 'Amazon', 2: 'Flipkart' };

export function createBuyHatke({ readJson, writeJson, modelKey, HOUR, DAY }) {
  const st = readJson('buyhatke.json', { ids: {} });
  const idOf = (pos, pid) => `${pos}~${pid}`;
  const now = () => new Date().toISOString();

  // remember an OLED monitor id; name/url/key are refreshed whenever we see it again
  function watch(pos, pid, info = {}) {
    if (!pid) return;
    const id = idOf(pos, pid);
    const w = (st.ids[id] ||= { pos: +pos, pid, first: now() });
    for (const [k, v] of Object.entries(info)) if (v) w[k] = v;
    w.seen = now();
  }
  // harvest ids from this run's own listings (only ones the rules already judged to be OLED monitors)
  function harvest(items) {
    for (const it of items) {
      const asin = (it.url || '').match(/amazon\.in\/(?:.*\/)?dp\/(\w{10})/);
      if (asin) watch(63, asin[1], { name: it.title, url: `https://www.amazon.in/dp/${asin[1]}`, key: it.key });
      if (it.pid && /flipkart\.com/.test(it.url || '')) watch(2, it.pid, { name: it.title, url: it.url, key: it.key });
    }
  }

  // BuyHatke's curated monitor category (~100 popular monitors): adds the OLED ones it knows about
  async function discover() {
    try {
      const r = await fetch(`${API}/getCategoryProducts?ln=1398&sort=aiscore-desc&limit=100&page=1`, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      const items = (await r.json()).data?.categories?.[0]?.items || [];
      for (const x of items) if (/oled/i.test(x.prod)) watch(x.pos, x.pid, { name: x.prod, url: x.pos === 63 ? `https://www.amazon.in/dp/${x.pid}` : '' });
    } catch (e) { console.log('BUYHATKE discover failed', String(e.message).slice(0, 80)); }
  }

  // live price + stock for every watched id, 50 per request
  async function prices() {
    const ids = Object.values(st.ids).filter((w) => Date.now() - Date.parse(w.seen) < 45 * DAY);   // forget ids not seen for 45 days
    const out = []; const errors = []; const low = [];   // low: Amazon ids whose price came back under ₹10,000 (see azLow)
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        const r = await fetch(`${API}/thunder/priceData`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ param: chunk.map((w) => [w.pos, w.pid]) }), signal: AbortSignal.timeout(30000) });
        const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch {}
        const data = j.data || {};
        if (!i) console.log('BH priceData diag: http', r.status, 'keys', Object.keys(data).length, 'of', chunk.length, 'body', txt.slice(0, 120).replace(/\s+/g, ' '));
        for (const w of chunk) {
          const raw = data[`${w.pos}~**~${w.pid}`]; if (!raw) continue;
          const p = JSON.parse(raw);
          if (p.price > 0) out.push({ w, price: Math.round(p.price), oos: !!p.oos, exGst: exGst(p.price, w.last) });
        }
      } catch (e) { errors.push(String(e.message).slice(0, 60)); }
    }
    // BuyHatke's priceData went empty on 2026-11-06: Amazon ids it did not answer are read from Amazon itself instead
    // (4 at a time, 150 s budget). If priceData comes back it answers first and this loop has nothing to do.
    if (AZ_URL) {
      const have = new Set(out.map((x) => x.w.pid));
      const amazon = ids.filter((w) => w.pos === 63 && !have.has(w.pid));
      const todo = [...amazon]; const t0 = Date.now(); let n = 0; const skipped = [];
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (let w; (w = todo.shift()) && Date.now() - t0 < 150000;) {
          const a = await azDetails(w.pid);
          if (a && a.price > 0 && a.inStock) { out.push({ w, price: a.price, oos: false, exGst: false, via: 'amazon', seller: a.seller }); n++; }
          else skipped.push(w.pid + (a ? (a.inStock ? ' price ' + a.price : a.inStock === null ? ' stock-unknown ' + a.price : ' oos') : ' no-data'));
          const lo = !a && azLow(w.pid);
          if (lo && lo.inStock !== false) low.push({ w, price: lo.price, inStock: lo.inStock });
        }
      }));
      console.log('AMAZON scraper priced', n, 'of', amazon.length, 'Amazon ids without a BuyHatke price');
      if (skipped.length) console.log('AMAZON unpriced:', skipped.join(', '));
    }
    return { out, errors, low };
  }

  // history page -> stats + other-shop matches. Field order differs between pages, so read each by name.
  function parseHistory(html) {
    const at = html.indexOf('maxall:'); if (at < 0) return null;
    const blob = html.slice(Math.max(0, at - 600), at + 600);
    const num = (k) => { const m = blob.match(new RegExp(`[,{]${k}:([0-9.]+)`)); return m ? Math.round(+m[1]) : null; };
    const h = { t: now(), min: num('min'), avg: num('avg'), avg1mon: num('avg1mon'), yearavg: num('yearavg'), maxall: num('maxall'), stableDays: num('stable_days') };
    const deals = []; const d = html.match(/dealsList:\[([\s\S]*?)\],exactDittoFlag/);
    if (d) for (const obj of d[1].split(/\},\{(?=prod:)/)) {   // one object per shop; read each field by name
      const f = (k, re = '"([^"]*)"') => (obj.match(new RegExp(`[,{]${k}:${re}`)) || [])[1];
      const pid = f('PID'); const pos = +f('position', '(\\d+)'); const price = +f('price', '(\\d+)');
      if (pid && pos && price) deals.push({ pid, pos, price, url: f('link') || '', store: f('site_name') || '', oos: f('oos', '(\\d)') === '1', refurb: f('refurbished_flag', '(true|false)') === 'true' });
    }
    h.deals = deals.slice(0, 8);
    // the full price timeline ({from, to, price} per price level), kept for 120 days: used to spot fake discounts
    const tl = html.match(/predictedData:\{history:\[([\s\S]*?)\]/);
    if (tl) {
      const cutoff = Date.now() - 120 * DAY;
      h.series = [...tl[1].matchAll(/from:"([^"]+)",to:"([^"]+)",price:([0-9.]+)/g)]
        .map((m) => [m[1].slice(0, 10), m[2].slice(0, 10), Math.round(+m[3])]).filter(([, to]) => Date.parse(to) >= cutoff);
    }
    return h;
  }
  // series for a model at one shop (Amazon/Flipkart/...), for listings that came from other sources
  const shopOf = (w) => String(w.store || STORE[w.pos] || '').toLowerCase().replace(/[^a-z0-9&]/g, '');
  function seriesFor(key, retailer) {
    for (const w of Object.values(st.ids)) if (w.hist?.series?.length && (w.key || (w.name && modelKey(w.name))) === key && shopOf(w) === retailer) return w.hist.series;
    return null;
  }
  // read up to `max` history pages that are over a day old (newest ids and changed prices first)
  async function refreshHistory(ctx, ids, { max = 12, budgetMs = 150000 } = {}) {
    const due = ids.filter((w) => w.url && (!w.hist || Date.now() - Date.parse(w.hist.t) > DAY)).sort((a, b) => (a.hist ? 1 : 0) - (b.hist ? 1 : 0)).slice(0, max);
    if (!due.length) return 0;
    const deadline = Date.now() + budgetMs; let n = 0;
    for (const w of due) {
      if (Date.now() > deadline) break;
      // a fresh tab per product: once one product page is open the site navigates in-app, and the price data is
      // then fetched separately instead of being embedded in the page
      let page; try { page = await ctx.newPage(); } catch (e) { console.log('BUYHATKE history: no browser page', String(e.message).slice(0, 60)); return n; }
      try {
        // buyhatke.com/<store url> redirects to the product page mid-load, which can surface as a navigation
        // error even though the page arrives: keep polling the content either way
        await page.goto('https://buyhatke.com/' + w.url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
        let h = null;
        for (let i = 0; i < 20 && !h; i++) { h = parseHistory(await page.content().catch(() => '')); if (!h) await page.waitForTimeout(1000); }
        if (!h) { console.log('BUYHATKE no history for', w.pos + '~' + w.pid); continue; }
        w.hist = h; n++;
        for (const x of h.deals) if (!x.refurb && (x.pos !== w.pos || x.pid !== w.pid)) watch(x.pos, x.pid, { name: w.name, url: x.url, key: w.key, store: x.store });
      } catch (e) { /* next one */ } finally { await page.close().catch(() => {}); }
    }
    return n;
  }

  // the source: harvest -> discover -> live prices -> (history pages). Items carry history stats as `bh`.
  async function source(ctx, src, earlierItems) {
    harvest(earlierItems);
    await discover();
    const { out, errors } = await prices();
    const refreshed = await refreshHistory(ctx, out.filter((x) => !x.oos).map((x) => x.w), { max: src.historyPerRun ?? 12, budgetMs: src.budgetMs ?? 150000 });
    const items = [];
    let gone = 0; const tally = {};
    for (const { w, price, oos, exGst: noGst, via, seller } of out) {
      if (oos || !w.name || noGst) continue;
      w.last = price;
      // BuyHatke's stock flag is stale (see amazonStock): Amazon listings are confirmed on Amazon itself; the rest
      // (Flipkart) go through verifyDeal's product-page check like any shop instead of counting as pre-verified
      const stock = w.pos === 63 ? await amazonStock(w.pid) : 'unknown';
      if (w.pos === 63) tally[stock] = (tally[stock] || 0) + 1;
      if (stock === 'out of stock') { gone++; continue; }
      const store = w.store || STORE[w.pos] || `store ${w.pos}`;
      // a price read from Amazon itself is labelled as such ("Amazon (direct)"), not as a BuyHatke price
      items.push({ title: w.name + (seller ? ` [sold by ${seller}]` : ''), price, mrp: 0, url: w.url || '', store, apiChecked: stock === 'in stock', bh: w.hist || null, bhId: idOf(w.pos, w.pid),
        // the watchlist remembers the model even when this run's copy of the title is the cut-off search-card one
        // (Amazon's G9 title loses "LS49DG930SWXXL" at 150 characters and then looked like an unknown model)
        ...(w.key ? { knownKey: w.key } : {}),
        ...(via === 'amazon' ? { sourceName: 'Amazon (direct)' } : {}) });
    }
    // other sellers, used and renewed units of the watched Amazon listings (Amazon's all-offers panel through the
    // scraper, at the pincode): the browser scan reads that panel too, but Amazon walls it on many runs
    const offerItems = await otherOffers(out.filter((x) => x.w.pos === 63 && !x.oos && x.w.name), src.offers ?? 12);
    items.push(...offerItems);
    console.log('BUYHATKE dropped', gone, 'listings Amazon shows as unavailable; Amazon page check', JSON.stringify(tally), amazonWalled ? '(Amazon walled us)' : '');
    console.log('BUYHATKE watching', Object.keys(st.ids).length, 'ids, priced', out.length, '(', out.filter((x) => x.oos).length, 'out of stock ), history refreshed', refreshed);
    writeJson('buyhatke.json', st);
    return { items, errors, blockedUrls: [] };
  }

  // history stats per model key, for the deal logic: lowest believable all-time low and month/year averages.
  // A history low far under the averages is usually a one-off glitch (a Legion 27Q-10 "₹18,690" on Flipkart):
  // kept separately as `glitchLow` (worth showing) but never used as the reference low.
  function statsByKey() {
    const by = {};
    for (const w of Object.values(st.ids)) {
      const h = w.hist; const key = w.key || (w.name && modelKey(w.name)); if (!h || !key) continue;
      const s = (by[key] ||= { lows: [], month: [], year: [], glitch: 0 });
      const typical = h.yearavg || h.avg1mon || h.avg;
      if (h.min && typical && h.min >= typical * 0.6) s.lows.push(h.min); else if (h.min) s.glitch = Math.min(s.glitch || Infinity, h.min);
      if (h.avg1mon) s.month.push(h.avg1mon); if (h.yearavg) s.year.push(h.yearavg);
    }
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
    return Object.fromEntries(Object.entries(by).map(([k, s]) => [k, { low: s.lows.length ? Math.min(...s.lows) : 0, monthAvg: med(s.month), yearAvg: med(s.year), glitchLow: s.glitch || 0 }]));
  }
  // live prices only (no harvest, no history pages, no state writes): the 5-minute fast check
  async function livePrices() { return prices(); }
  // parallel scan: the combine job learns ids from every part's listings (the BuyHatke source itself only saw its own part's)
  function harvestAll(items) { harvest(items); writeJson('buyhatke.json', st); }
  return { source, statsByKey, seriesFor, livePrices, harvestAll, ids: () => st.ids };
}

// Fake discount: the shop raised the price in the last 3 weeks, and today's "drop" only brings it back to (about)
// what it normally cost before that. series = [[fromDate, toDate, price], ...] from BuyHatke's price timeline.
// Returns { normal, hikedTo } when the drop is fake, otherwise null.
// BuyHatke sometimes reports an Amazon Business ("Smartchoice") listing WITHOUT 18% GST: 2026-11-02 four fake
// "drops" were all exactly price/1.18 (AW2726DM ₹39,799 -> ₹33,728). True when price is a reference price minus GST.
export function exGst(price, ...refs) {
  return refs.some((r) => r > 0 && Math.abs((price * 1.18) / r - 1) < 0.003);
}

export function fakeDiscount(series, price, nowMs = Date.now()) {
  if (!series?.length) return null;
  const DAY = 864e5;
  const priceOn = (ms) => { let p = null; for (const [from, , v] of series) if (Date.parse(from) <= ms) p = v; return p; };
  const before = []; for (let d = 22; d <= 80; d += 2) { const p = priceOn(nowMs - d * DAY); if (p) before.push(p); }
  if (before.length < 8) return null;   // not enough history before the hike window to know the normal price
  const normal = [...before].sort((a, b) => a - b)[before.length >> 1];
  const recent = series.filter(([, to]) => Date.parse(to) >= nowMs - 21 * DAY).map(([, , v]) => v);
  const hikedTo = recent.length ? Math.max(...recent) : 0;
  return hikedTo >= normal * 1.1 && price >= normal * 0.95 ? { normal, hikedTo } : null;
}

// BuyHatke's live price for an Amazon listing is a CACHE: it kept saying "₹49,800, in stock" for the ViewSonic
// XG2738 (B0GL83RWPV) while Amazon showed "Currently unavailable / No featured offers" (Zameel, 2026-11-03).
// So every Amazon price from BuyHatke is checked against Amazon's own page (plain HTTP, mobile UA, no browser):
// an add-to-cart / buy-now button = in stock; "currently unavailable" or "no featured offers" without one = out of
// stock; a captcha or error = unknown (stops asking for the rest of the run, Amazon walls GitHub IPs at times).
// Amazon price + stock straight from Amazon through omkarcloud/amazon-scraper (pinned, started by the workflow on
// localhost; see .github/actions/amazon-scraper). Real India prices at Zameel's pincode, so no stale-cache problem and no
// GitHub-IP wall. Only active when AMAZON_SCRAPER_URL is set; any failure returns null and the old paths take over.
const AZ_URL = process.env.AMAZON_SCRAPER_URL, AZ_PIN = process.env.AMAZON_PINCODE || '622001';
const azCache = new Map(); let azFails = 0;
const azLowSeen = new Map();
// what azDetails saw for a listing it refused to price because the price was under ₹10,000 ({ price, inStock }), if any
export const azLow = (asin) => azLowSeen.get(asin);
export async function azDetails(asin) {
  if (!AZ_URL || azFails >= 3) return null;           // 3 failures in a row = scraper is down/blocked: stop asking this run
  if (azCache.has(asin)) return azCache.get(asin);
  let res = null;
  try {
    const link = encodeURIComponent('https://www.amazon.in/dp/' + asin);
    const r = await fetch(`${AZ_URL}/products/details?product=${link}&postal_code=${AZ_PIN}`, { signal: AbortSignal.timeout(60000) });
    const d = await r.json();
    if (d && d.asin === asin) {
      azFails = 0;
      const price = Math.round(d.price?.amount || 0);
      // third-party BUNDLE listings ("G9 + Logitech webcam", seller Clicktech) come back with the add-on's price (₹2,995 for a
      // ₹87k monitor: dry run 2026-11-08 B0HDSK5WMF): never trust a bundle title or a price no OLED monitor sells at
      // A price under ₹10,000 on a non-bundle listing is still not used as a price anywhere, but it is remembered
      // (azLow) so the 5-minute check can ping it as "unconfirmed": it could be the one extreme glitch.
      if (price && (price < 10000 || / \+ /.test(d.title || ''))) {
        console.log('azDetails ignoring bundle/implausible price', asin, price);
        if (!/ \+ /.test(d.title || '')) azLowSeen.set(asin, { price, inStock: d.availability ? !!d.availability.is_in_stock : null });
      }
      // some listings come back with a price but no availability block (B0CZSGWLD5, B0CZWM44QP: third-party offers only).
      // That is a good answer with unknown stock, not a scraper failure: it must not count towards the 3-failures stop.
      // The all-offers list settles those: a New offer there = in stock at that seller's price; none = not buyable.
      else if (d.availability) res = { price, inStock: !!d.availability.is_in_stock };
      else {
        const best = cheapestNew(await azOffers(asin));
        res = best === null ? { price, inStock: null } : best ? { price: best.price, inStock: true, seller: best.seller } : { price, inStock: false };
      }
    } else azFails++;
  } catch (e) { azFails++; console.log('azDetails', asin, String(e.message).slice(0, 60)); }
  azCache.set(asin, res);
  return res;
}

// Amazon SEARCH through the same scraper: how the 5-minute check finds listings that are not on the watchlist yet
// (a brand-new listing or seller at a glitch price). Measured from a runner on 2026-11-10: calls back to back get
// Amazon's 503 "dogs" page (2 of 5 worked); 20 s apart 13 of 14 worked, 1-14 s each. So the caller paces them, and a
// blocked search just returns null (it never counts against azDetails). Search has no pincode: every hit is
// confirmed with azDetails (price + stock at the pincode) before a ping.
// Every seller's offer for one listing (Amazon's all-offers panel) at the pincode: [{ cond, price, seller }], or
// null when the scraper is off or the call failed. Plausible monitor prices only (a bundle add-on is not an offer).
export function parseAzOffers(json) {
  return (json?.offers || []).map((o) => ({ cond: String(o.condition || 'New').replace(/\s+/g, ' ').trim(), price: Math.round(o.price?.amount || 0),
    seller: String(o.seller?.name || '').replace(/\s+/g, ' ').trim() })).filter((o) => o.price >= 10000);
}
export async function azOffers(asin) {
  if (!AZ_URL) return null;
  try {
    const r = await fetch(`${AZ_URL}/products/offers?country=IN&postal_code=${AZ_PIN}&product=${asin}`, { signal: AbortSignal.timeout(45000) });
    return r.ok ? parseAzOffers(await r.json()) : null;
  } catch (e) { console.log('azOffers', asin, String(e.message).slice(0, 60)); return null; }
}
// the cheapest New offer; false when the list has none; null when there is no list (unknown)
export const cheapestNew = (offers) => (!offers ? null : offers.filter((o) => /^new$/i.test(o.cond)).sort((a, b) => a.price - b.price)[0] || false);
// offers worth listing next to the buy-box price: used/renewed units, and New from another seller that is cheaper
export const sideOffers = (offers, buyBoxPrice) => (offers || []).filter((o) => !/^new$/i.test(o.cond) || o.price < buyBoxPrice * 0.99);
async function otherOffers(priced, max) {
  if (!AZ_URL || !max) return [];
  const todo = priced.slice(0, max); const items = []; const t0 = Date.now(); let asked = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let x; (x = todo.shift()) && Date.now() - t0 < 90000;) {
      const offers = await azOffers(x.w.pid); asked++;
      sideOffers(offers, x.price).forEach((o, n) => items.push({ title: `${x.w.name} [${o.cond}${o.seller ? ' · ' + o.seller : ''}]`, price: o.price, mrp: 0,
        url: `https://www.amazon.in/dp/${x.w.pid}?aod=1&offer=${n}`, store: 'Amazon other sellers', apiChecked: true, sourceName: 'Amazon (direct) · other sellers' }));
    }
  }));
  console.log('AMAZON offers:', asked, 'listings asked,', items.length, 'used/renewed/cheaper-seller offers');
  return items;
}

// what Amazon's own answer (azDetails) says about a listing someone priced at `price`
export const azVerdict = (az, price) => (az.inStock === false || !az.price ? 'out of stock'
  : Math.abs(az.price - price) > price * 0.01 ? 'price changed' : az.inStock ? 'verified' : 'stock unknown');
export function parseAzSearch(json) {
  const items = [];
  for (const p of json?.results || []) {
    const price = Math.round(p?.price?.amount || 0); const list = Math.round(p?.price?.list_price || 0);
    if (!/^\w{10}$/.test(p?.asin || '') || !p.title || !price) continue;
    items.push({ title: String(p.title).replace(/\s+/g, ' ').trim(), price, mrp: list > price ? list : 0, url: `https://www.amazon.in/dp/${p.asin}` });
  }
  return items;
}
export async function azSearch(query) {
  if (!AZ_URL) return null;
  const t0 = Date.now();
  try {
    const r = await fetch(`${AZ_URL}/search?country=IN&query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(40000) });
    const j = await r.json().catch(() => null);
    const items = r.ok ? parseAzSearch(j) : null;
    // one line per search, every run: the block rate over a week decides whether search can replace the browser scan
    console.log(`AMAZON search "${query}"`, r.ok ? `ok ${items.length} items` : `BLOCKED http ${r.status} ${String(j?.error || '').slice(0, 70)}`, Date.now() - t0, 'ms');
    return items;
  } catch (e) { console.log(`AMAZON search "${query}" FAILED`, String(e.message).slice(0, 60)); return null; }
}

const stockCache = new Map(); let amazonWalled = false;
export async function amazonStock(asin) {
  if (stockCache.has(asin)) return stockCache.get(asin);
  const az = await azDetails(asin);
  if (az) { const r = az.inStock === null ? 'unknown' : az.inStock && az.price ? 'in stock' : 'out of stock'; stockCache.set(asin, r); return r; }
  if (amazonWalled) return 'unknown';
  let res = 'unknown';
  try {
    const r = await fetch(`https://www.amazon.in/dp/${asin}`, { signal: AbortSignal.timeout(20000), headers: {
      'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      'accept-language': 'en-IN,en;q=0.9', accept: 'text/html' } });
    const t = await r.text();
    if (r.status >= 400 || /captcha|api-services-support|enter the characters/i.test(t.slice(0, 20000))) amazonWalled = true;
    else if (/id="add-to-cart-button"|id="buy-now-button"/.test(t)) res = 'in stock';
    else if (/currently unavailable|no featured offers/i.test(t)) res = 'out of stock';
  } catch (e) { console.log('amazonStock', asin, String(e.message).slice(0, 60)); }
  if (amazonWalled && res === 'unknown') console.log('amazonStock walled at', asin);
  stockCache.set(asin, res);
  return res;
}
