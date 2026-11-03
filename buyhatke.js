// BuyHatke (buyhatke.com, India's price-history site): two things we can't get anywhere else.
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
    const out = []; const errors = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        const r = await fetch(`${API}/thunder/priceData`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ param: chunk.map((w) => [w.pos, w.pid]) }), signal: AbortSignal.timeout(30000) });
        const data = (await r.json()).data || {};
        for (const w of chunk) {
          const raw = data[`${w.pos}~**~${w.pid}`]; if (!raw) continue;
          const p = JSON.parse(raw);
          if (p.price > 0) out.push({ w, price: Math.round(p.price), oos: !!p.oos, exGst: exGst(p.price, w.last) });
        }
      } catch (e) { errors.push(String(e.message).slice(0, 60)); }
    }
    return { out, errors };
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
    for (const { w, price, oos, exGst: noGst } of out) {
      if (oos || !w.name || noGst) continue;
      w.last = price;
      const store = w.store || STORE[w.pos] || `store ${w.pos}`;
      items.push({ title: w.name, price, mrp: 0, url: w.url || '', store, apiChecked: true, bh: w.hist || null, bhId: idOf(w.pos, w.pid) });
    }
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
