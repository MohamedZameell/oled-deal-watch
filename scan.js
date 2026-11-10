// OLED deal watch: scrape retailers, compare every listing against what OTHER sellers charge for the same
// model, re-open the product page to confirm price + stock, then email the anomalies.
// One engine for every region; config.json holds the region, sources and thresholds.
// Usage: node scan.js [--dry] [--verify-sample]     (rules: rules.js, shop APIs: shops.js, tests: npm test)
//   --dry            print the digest instead of sending it, and don't persist state
//   --verify-sample  also run the product-page check on the 3 cheapest listings (tests the verifier)
//   --community-only only the community feeds (deal channels, Reddit), Telegram pings, no browser or email
// Env: CONFIG, STATE_DIR, CDP_URL (drive an existing browser), BROWSER_CHANNEL (e.g. chrome),
//      MAIL_VIA_GH (relay mail through that repo's mail.yml), FORCE_EMAIL, DEBUG_ITEMS
import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import { createAI } from './ai.js';
import { createBuyHatke, fakeDiscount, exGst, amazonStock, azDetails, azSearch, azVerdict } from './buyhatke.js';
import { MONITOR_OK, NOT_MONITOR, RISKY_CONDITION, BRANDS, median, retailerOf, urlWords, inches, modelKey, bannedRe,
  keepListings as keepRule, judgeModel, pushHistory, typicalPrice, notRecent as notRecentAt } from './rules.js';
import { shopApi, flipkartHttp } from './shops.js';
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const VERIFY_SAMPLE = process.argv.includes('--verify-sample');
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG || 'config.json', 'utf8'));
const R = cfg.region;
const STATE = process.env.STATE_DIR || 'state';
fs.mkdirSync(STATE, { recursive: true });
const readJsonAt = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const readJson = (f, d) => readJsonAt(`${STATE}/${f}`, d);
const writeJson = (f, v) => { if (!DRY) fs.writeFileSync(`${STATE}/${f}`, JSON.stringify(v, null, 1)); };
const HOUR = 3600e3; const DAY = 24 * HOUR;
// free AI judge (small open model run by Ollama on the runner): see ai.js. Every use falls back to the rule-based behaviour when it has no answer.
const ai = createAI({ cfg, stateDir: STATE, dry: DRY });
const VERDICT = { buy: '🔥 BUY', good: '👍 good deal', meh: '😐 meh', check: '⚠️ check this' };
const aiTag = (c) => (c.fake ? ` · ⚠️ fake discount? raised to ${fmt(c.fake.hikedTo)} recently, normally ~${fmt(c.fake.normal)}` : '') +
  (c.judge ? ` · 🤖 ${VERDICT[c.judge.verdict] || esc(c.judge.verdict)}: ${esc(c.judge.note)}` : '');
// sale seasons (Big Billion Days, Great Indian Festival, ...): full scans every 15 min instead of hourly, smaller discounts alert
const SALE = (cfg.saleWindows || []).find((w) => Date.now() >= Date.parse(w.from) && Date.now() < Date.parse(w.to) + DAY);
if (SALE) Object.assign(cfg, cfg.saleOverrides || {});

// what counts as an OLED monitor listing, model keys and the alert maths live in rules.js (tested by `npm test`)
const BANNED = bannedRe(cfg);   // brands Zameel banned (config bannedBrands): never listed, compared, alerted or shown
const SKIP_LINE = /emi|\/mo|per month|month|cashback|sav(e|ing)|\boff\b|coupon|exchange|discount|delivery|shipping|instant|bonus|joining/i;
const OUT_OF_STOCK = /out of stock|sold out|currently unavailable|no longer available|temporarily unavailable|notify me when available/i;

const CUR = R.currency;                                        // '₹' or '$'
// ₹ amounts must follow Indian digit grouping (1,65,920): Flipkart prints "₹49,89013% off", which a loose
// [\d,]+ read as ₹49,89,013
const CUR_RE = CUR === '₹' ? /(?:₹|Rs\.?)\s?(\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d+)?|\d{4,7}(?:\.\d+)?)/g : /\$\s?([\d,]{3,7}(?:\.\d{2})?)/g;
const CUR_IN_LINE = CUR === '₹' ? /₹|Rs\./ : /\$/;
const money = (s) => { const m = String(s).replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? Math.round(parseFloat(m[0])) : 0; };
const amountsIn = (line) => [...line.matchAll(CUR_RE)].map((m) => Math.round(parseFloat(m[1].replace(/,/g, '')))).filter((n) => n >= R.minAmount);
const fmt = (n) => CUR + Math.round(n).toLocaleString(R.numberLocale);
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const seeds = Object.fromEntries(Object.entries(cfg.streetPriceSeeds || {}).map(([k, v]) => [modelKey(k) || k, v]));
// models already known to be OLED: a model-code search ("AW2726DM") also finds listings whose title never says OLED
const savedHistory = readJson('history.json', {});
const bh = createBuyHatke({ readJson, writeJson, modelKey, HOUR, DAY });
const knownOled = new Set([...Object.keys(seeds), ...Object.keys(savedHistory)].filter((k) => !k.startsWith('~')).map((k) => modelKey(k) || k));
// usual price of a model: its typical price over the last 30 days of our own daily lows (rules.js typicalPrice), else
// the typed street price from config.json (new models), else the last two days of scan history
const savedLows = readJson('lows.json', {});
const usualPrice = (key) => typicalPrice(savedLows[key]?.days) || seeds[key] || (savedHistory[key]?.length ? median(savedHistory[key].slice(-48).map((h) => h.price)) : 0);

// ---------- page extractors (run inside the browser) ----------
const amazonExtract = () => [...document.querySelectorAll('[data-component-type="s-search-result"]')].map((e) => ({
  title: (e.querySelector('h2') || {}).innerText || '',
  price: (e.querySelector('.a-price .a-offscreen') || {}).textContent || '',
  mrp: (e.querySelector('.a-price.a-text-price .a-offscreen') || {}).textContent || '',
  url: e.dataset.asin ? location.origin + '/dp/' + e.dataset.asin : '',
}));

// Amazon "all offers" panel: every seller below the buy box, with its condition (New / Renewed / Used - Like New)
const aodExtract = () => [...document.querySelectorAll('#aod-offer')].map((o) => ({
  price: ((o.querySelector('.apex-pricetopay-value') || o.querySelector('.a-price .a-offscreen') || {}).innerText || '').trim(),
  cond: ((o.querySelector('#aod-offer-heading') || {}).innerText || '').replace(/\s+/g, ' ').trim(),
  seller: ((o.querySelector('#aod-offer-soldBy a') || o.querySelector('#aod-offer-soldBy .a-col-right') || {}).innerText || '').replace(/\s+/g, ' ').trim(),
}));

const flipkartExtract = () => [...document.querySelectorAll('a[href*="/p/itm"]')].map((a) => {
  const c = a.closest('[data-id]') || a.parentElement.parentElement;
  const text = c.innerText.replace(/\n+/g, ' | ');
  const title = a.getAttribute('title') || (c.innerText.split('\n').find((l) => l.length > 25) || '');
  // the card's data-id is Flipkart's product id (MON...): BuyHatke's live-price API looks products up by it
  return { title, text, url: a.href.split('?')[0], pid: (a.closest('[data-id]') || {}).dataset?.id || new URL(a.href).searchParams.get('pid') || '' };
});

const bestbuyExtract = () => [...document.querySelectorAll('a.product-list-item-link')].map((a) => {
  const c = a.closest('li') || a.parentElement.parentElement;
  const text = c.innerText.split('\n').join(' | ');
  const title = (c.querySelector('h2, h3, .product-title') || {}).innerText || a.innerText;
  return { title, text, url: a.href.split('?')[0] };
});

// generic product-card extractor: title = longest OLED line without a price, url = the card's product link
const cardsExtract = (sel) => [...document.querySelectorAll(sel)].map((e) => {
  const lines = e.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
  const title = lines.filter((l) => /oled/i.test(l) && l.length >= 20 && l.length <= 250 && !l.includes('$')).sort((a, b) => b.length - a.length)[0] || '';
  const links = [...e.querySelectorAll('a[href]')].filter((x) => !/signin|account\.|javascript:|#/.test(x.href) && x.href.length > 30);
  const a = links.find((x) => /\/p\/N|\/ip\/|\.product\.|\/c\/product\/|\/product\//.test(x.href)) || links[0];
  return { title, text: lines.join(' | '), url: a ? a.href.split('?')[0] : '' };
});

// DealSea: community-posted deals; each box = title, price, "Retailer $price". Expired boxes are skipped.
const dealseaExtract = () => [...document.querySelectorAll('.dealbox')].map((e) => {
  const lines = e.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
  const a = e.querySelector('a[href^="/view-deal/"]');
  const sm = lines.map((l) => l.match(/^(.+?)\s+\$[\d,.]+$/)).find(Boolean);
  return { title: lines[0] || '', price: lines.find((l) => /^\$[\d,.]+$/.test(l)) || '', store: sm ? sm[1] : '',
    expired: /expired/i.test(e.className + ' ' + e.innerText.slice(0, 200)), url: a ? 'https://dealsea.com' + a.getAttribute('href') : '' };
});

const anchorsExtract = () => [...document.querySelectorAll('a[href]')].map((a) => [(a.innerText || a.title || '').trim().slice(0, 120), a.href]).filter(([t]) => t.length > 15);

// Free-text listing pages: find OLED monitor title lines, then read the prices under each one.
//  'labeled' (US): the first "$x" / "From $x" line is the price; was/MSRP/estimated-value lines are the reference.
//  'minmax' (India): lowest amount under the title is the price, highest the MRP, skipping EMI/cashback lines.
function parseTextBlocks(text, anchors, fallbackUrl) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const isTitle = (l) => /oled/i.test(l) && l.length >= 20 && l.length <= 220 && !CUR_IN_LINE.test(l) && MONITOR_OK.test(l) && !NOT_MONITOR.test(l);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isTitle(lines[i])) continue;
    let price = 0; let mrp = 0;
    if (R.textParser === 'minmax') {
      const nums = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
        if (isTitle(lines[j])) break;
        if (SKIP_LINE.test(lines[j]) && !/mrp|total price|original price/i.test(lines[j])) continue;
        nums.push(...amountsIn(lines[j]));
      }
      if (!nums.length) continue;
      price = Math.min(...nums); mrp = Math.max(...nums);
    } else {
      const prices = []; const refs = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 14); j++) {
        const l = lines[j];
        if (isTitle(l) || /^(save|compare|view product page|quick view|add to cart|buy)$/i.test(l)) break;
        if (/\/mo\b|per month|financ|\bapr\b|earn|back in|rewards/i.test(l)) continue;
        const am = amountsIn(l); if (!am.length) continue;
        if (/estimated value|\bwas\b|msrp|list price|original price|reg(ular)?\.? price/i.test(l)) refs.push(...am);
        else if (/^(from |now )?\$/i.test(l)) prices.push(am[0]);
      }
      if (!prices.length) continue;
      price = prices[0]; mrp = Math.max(0, ...refs);
    }
    const key = lines[i].slice(0, 22).toLowerCase();
    const code = (lines[i].match(/\b[A-Z]{1,3}\d{2,4}[A-Z0-9]{0,6}\b/g) || []).pop();
    const hit = anchors.find(([, h]) => code && h.toLowerCase().includes(code.toLowerCase())) ||
      anchors.find(([t]) => t.toLowerCase().startsWith(key) || lines[i].toLowerCase().startsWith(t.toLowerCase().slice(0, 22)));
    out.push({ title: lines[i], price, mrp: mrp > price ? mrp : 0, url: hit ? hit[1] : fallbackUrl });
  }
  return out;
}

// ---------- scrape ----------
const BLOCKED = /captcha|robot check|access denied|unusual traffic|enter the characters|security verification|verify you are (a )?human|are you a human|just a moment|robot or human|503 - service unavailable|rush hour and traffic/i;

// Samsung India: the finder API lists every monitor model; the shop API gives the public AND the Corporate Store
// price plus live stock for each, including hidden "-F" repackaged SKUs (the ₹25,680 G5 was one).
// Plain HTTP, no login, no browser. Stock comes from the API, so these listings skip the product-page check.
async function samsungApi(src) {
  const items = []; const errors = [];
  const get = async (u) => { const r = await fetch(u, { headers: { 'user-agent': UA_DESKTOP, 'accept-language': 'en-IN,en;q=0.9' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
  const plain = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  try {
    const f = await get('https://searchapi.samsung.com/v6/front/b2c/product/finder/global?type=07010000&siteCode=in&start=1&num=200&sort=newest&onlyFilterInfoYN=N&keySummaryYN=N&specHighlightYN=N');
    const models = f.response.resultData.productList.flatMap((fam) => fam.modelList || []).filter((m) => /oled/i.test(plain(m.displayName) + ' ' + m.pdpUrl));
    const pdp = Object.fromEntries(models.map((m) => [m.modelCode.replace(/XXL$/, ''), 'https://www.samsung.com' + m.pdpUrl]));
    const codes = Object.keys(pdp).flatMap((c) => [c, c + '-F']);
    // a store is one shop id, or a group of staff stores (Corporate / Student / Business bulk) that usually share
    // prices: the group reports its cheapest offer per SKU and names the stores that have it
    for (const store of src.stores) {
      const ids = store.ids || { [store.id]: '' };
      const cheapest = {};
      for (const [id, label] of Object.entries(ids)) {
        for (let i = 0; i < codes.length; i += 20) {
          const list = await get(`https://p1-smi-api-cdn.shop.samsung.com/tokocommercewebservices/v2/${id}/products?productCodes=${codes.slice(i, i + 20).join(',')}&fields=FULL`);
          for (const p of list) {
            if (!p.code || !p.stock || p.stock.stockLevelStatus === 'outOfStock') continue;
            const price = Math.round(p.promotionPrice?.value || p.price?.value || 0); if (!price) continue;
            const c = cheapest[p.code];
            if (!c || price < c.price) cheapest[p.code] = { p, price, where: [label] }; else if (price === c.price) c.where.push(label);
          }
        }
      }
      for (const { p, price, where } of Object.values(cheapest)) {
        const base = p.code.replace(/-F$/, '');
        items.push({ title: `${plain(p.name)} ${base}${p.productType === 'REPACKAGED' ? ' (repackaged)' : ''}${where.filter(Boolean).length ? ` [${where.join('/')}]` : ''}`,
          price, mrp: Math.round(p.price?.value || 0), url: pdp[base], store: store.name, apiChecked: true });
      }
    }
  } catch (e) { errors.push(String(e.message).slice(0, 60)); }
  return { items, errors, blockedUrls: [] };
}

// Smartprix: one page per price band lists every OLED monitor it tracks, and each product page carries a table of
// store prices (Amazon, Flipkart, ...) with stock. That gives Amazon prices even on runs when Amazon walls us.
// It sits behind a Cloudflare check that a headless browser fails: the workflow runs Chrome headful under xvfb.
// Product pages are cached (state/smartprix.json) and only re-read when the listed price moves or the copy is old.
async function smartprixSource(ctx, src) {
  const items = []; const errors = []; const page = await ctx.newPage();
  const base = 'https://www.smartprix.com';
  const readWay = async (url) => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      for (let i = 0; i < 25; i++) {
        const m = (await page.content()).match(/<script id="__WAY_JSON__" type="application\/json">([\s\S]*?)<\/script>/);
        if (m) return JSON.parse(m[1]).$way?.props?.item || null;
        await page.waitForTimeout(1000);
      }
    } catch (e) { errors.push(String(e.message).slice(0, 60)); }
    return null;
  };
  const listed = new Map();
  for (const u of src.urls) {
    const it = await readWay(u);
    if (!it?.searchResults) { errors.push('blocked/captcha'); continue; }
    const sr = it.searchResults;
    if (sr.pageInfo?.hasNextPage) console.log('SMARTPRIX band has a second page (split it in config.json):', u, sr.totalCount);
    for (const n of sr.nodes || []) if (n.url && n.price) listed.set(n.id, n);
  }
  const cache = readJson('smartprix.json', {});
  const now = Date.now(); const maxAge = (src.refreshHours || 6) * HOUR;
  const stale = [...listed.values()].filter((n) => !cache[n.id] || cache[n.id].listPrice !== n.price || now - Date.parse(cache[n.id].t) > maxAge)
    .sort((a, b) => (cache[a.id] ? 1 : 0) - (cache[b.id] ? 1 : 0) || a.price - b.price);
  const deadline = now + (src.budgetMs || 240000); let fetched = 0;
  for (const n of stale.slice(0, src.maxProducts || 40)) {
    if (Date.now() > deadline) break;
    const it = await readWay(base + n.url);
    if (!it?.priceComparison) continue;
    fetched++;
    const rows = [];
    for (const [cond, list] of Object.entries(it.priceComparison.table || {})) {
      if (cond === 'global') continue;   // import listings (Amazon.com etc.), not buyable here at that price
      for (const r of list || []) if (r.price && r.store?.name) rows.push({ store: r.store.name, price: Math.round(r.price), stock: r.stock, cond,
        offers: (r.offers || []).map((o) => (typeof o === 'string' ? o : o.title || o.text || o.description || o.name || '')).filter(Boolean).slice(0, 2) });
    }
    cache[n.id] = { t: new Date().toISOString(), listPrice: n.price, name: it.name || n.name, url: base + n.url, drop: it.priceDrop ?? null, rows };
  }
  for (const n of listed.values()) {
    const c = cache[n.id];
    if (!c || now - Date.parse(c.t) > DAY) continue;   // never show a store price older than a day
    for (const r of c.rows) {
      if (r.stock === 'OUT_OF_STOCK') continue;
      items.push({ title: c.name + (r.cond === 'used' ? ' (used)' : ''), price: r.price, mrp: 0, url: c.url, store: r.store,
        preChecked: r.stock === 'IN_STOCK' ? 'verified' : 'unverified (Smartprix: stock unknown)', spDrop: c.drop, offers: r.offers });
    }
  }
  for (const id of Object.keys(cache)) if (!listed.has(id) && now - Date.parse(cache[id].t) > 7 * DAY) delete cache[id];
  writeJson('smartprix.json', cache);
  console.log('SMARTPRIX listed', listed.size, 'refreshed', fetched, 'of', stale.length, 'stale');
  await page.close();
  return { items, errors, blockedUrls: [] };
}

async function scrapeSource(ctx, src, deskCtx = ctx, earlierItems = []) {
  if (src.kind === 'samsungapi') return samsungApi(src);
  if (src.kind === 'smartprix') return smartprixSource(deskCtx, src);
  // listed last in config.json: it learns Amazon/Flipkart ids from the OLED listings the other sources found this run
  if (src.kind === 'buyhatke') return bh.source(deskCtx, src, earlierItems.filter((i) => /oled/i.test(i.title + ' ' + urlWords(i.url || ''))));
  if (src.api) {   // the shop's own catalogue API (shops.js): real price + stock, no browser; the search page only if it gives nothing
    const r = await shopApi(src);
    console.log('SHOP API', src.name, r.items.length, 'in stock,', r.oos, 'out of stock', r.errors.join(','));
    if (r.items.length) return r;
  }
  const items = []; const errors = []; const blockedUrls = [];
  const page = await ctx.newPage();
  // Amazon serves a bot wall to a cold session far more often than to one that opened the homepage first
  const warmup = async () => { if (src.warmup) { await page.goto(src.warmup, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await page.waitForTimeout(3000); } };
  await warmup();
  // Amazon walls GitHub IPs in waves: once two searches in a row stay blocked through every retry, retrying in place
  // just burns ~90 s per URL (it pushed runs past the 30-min job limit), so give the rest one try and leave them for
  // the second pass; a time budget caps the whole source so the digest always goes out
  const deadline = src.budgetMs ? Date.now() + src.budgetMs : Infinity;
  let wallStreak = 0, skipped = 0;
  for (const url of src.urls) {
    if (Date.now() > deadline) { blockedUrls.push(url); skipped++; continue; }
    try {
      // some sites (Amazon from datacenter IPs) block at random: retry with fresh cookies and a growing pause
      let body = '', blocked = true, tries = 0;
      const maxTries = wallStreak >= 2 ? 1 : (src.retries || 1);
      while (blocked && tries < maxTries && Date.now() <= deadline) {
        if (tries) { await ctx.clearCookies(); await page.waitForTimeout(4000 + tries * 3000); await warmup(); }
        tries++;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(4000);
        // Best Buy renders the result grid late, and the first search of a session is often ads only until a reload
        if (src.kind === 'bestbuy') {
          const grid = () => page.waitForSelector('a.product-list-item-link', { timeout: 15000 }).then(() => true, () => false);
          if (!(await grid())) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }); await grid(); }
        }
        for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 1600); await page.waitForTimeout(400); }
        body = await page.evaluate(() => document.body.innerText);
        blocked = BLOCKED.test(body.slice(0, 1500)) || BLOCKED.test(await page.title());
      }
      if (src.retries) console.log('TRIES', src.name, url, tries, blocked ? 'still blocked' : 'ok');
      if (blocked) { if (tries >= (src.retries || 1)) wallStreak++; errors.push('blocked/captcha'); blockedUrls.push(url); continue; }
      wallStreak = 0;
      const before = items.length;
      if (src.kind === 'amazon') {
        for (const r of (await page.evaluate(amazonExtract)).filter((x) => x.price.includes(CUR))) items.push({ title: r.title, price: money(r.price), mrp: money(r.mrp), url: r.url });
      } else if (src.kind === 'flipkart' || src.kind === 'bestbuy') {
        for (const r of await page.evaluate(src.kind === 'bestbuy' ? bestbuyExtract : flipkartExtract)) {
          const a = amountsIn(r.text); if (!a.length) continue;
          items.push({ title: r.title, price: a[0], mrp: a[1] > a[0] ? a[1] : 0, url: r.url, pid: r.pid });
        }
      } else if (src.kind === 'dealsea') {
        for (const r of await page.evaluate(dealseaExtract)) if (!r.expired && r.price) items.push({ title: r.title, price: money(r.price), mrp: 0, url: r.url, store: r.store });
      } else if (src.kind === 'cards') {
        const mk = (v) => [].concat(v || []).map((x) => new RegExp(x, 'i'));
        const priceRes = mk(src.priceRe); const refRes = mk(src.refRe);
        const firstMatch = (res, t) => { for (const re of res) { const m = t.match(re); if (m) return m; } return null; };
        await page.waitForTimeout(src.wait || 0);
        for (const r of await page.evaluate(cardsExtract, src.sel)) {
          const pm = firstMatch(priceRes, r.text); if (!pm) continue;
          const rm = firstMatch(refRes, r.text);
          items.push({ title: r.title, price: money(pm[1]), mrp: rm ? money(rm[1]) : 0, url: r.url || url });
        }
      } else {
        items.push(...parseTextBlocks(body, await page.evaluate(anchorsExtract), url));
      }
      if (items.length === before) {
        // zero rows from a search page: record what the page really was (title, text, screenshot) so a silent bot wall shows up
        const tag = `${src.name.replace(/\W+/g, '')}-${src.urls.indexOf(url)}`;
        console.log('EMPTY', src.name, url, '| title:', await page.title(), '| text:', body.slice(0, 200).replace(/\s+/g, ' '));
        try { fs.mkdirSync('debug', { recursive: true }); await page.screenshot({ path: `debug/${tag}.png` }); } catch {}
        if (src.kind !== 'text') errors.push('0 results');
      }
    } catch (e) { errors.push(String(e.message).slice(0, 60)); }
  }
  await page.close();
  if (skipped) console.log('BUDGET', src.name, skipped, 'URLs skipped (time budget)');
  // Amazon search shows only the buy-box price; cheaper other sellers, Renewed and used units sit in each product's
  // offer panel, which Amazon only fills for a desktop browser (a phone-shaped one gets the buy box alone)
  if (src.offers) {
    const origin = new URL(src.urls[0] || src.warmup).origin;
    const asins = [...new Map(items.map((i) => [(i.url.match(/\/dp\/(\w{10})/) || [])[1], i]).filter(([a, i]) => a && knownOled.has(modelKey(i.title)))).entries()];
    const op = await deskCtx.newPage(); let found = 0;
    for (const [asin, base] of asins.slice(0, src.offers)) {
      try {
        await op.goto(`${origin}/gp/product/ajax/aodAjaxMain/ref=auto_load_aod?asin=${asin}&pc=dp`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await op.waitForTimeout(1500);
        (await op.evaluate(aodExtract)).forEach((o, n) => { if (!o.price) return; found++;
          items.push({ title: `${base.title} [${o.cond || 'offer'}${o.seller ? ' · ' + o.seller : ''}]`, price: money(o.price), mrp: 0, url: `${base.url}?aod=1&offer=${n}`, store: 'other sellers' }); });
      } catch {}
    }
    await op.close();
    console.log('OFFERS', src.name, Math.min(asins.length, src.offers), 'products checked,', found, 'other-seller offers');
  }
  return { items, errors, blockedUrls };
}

// ---------- community posts ----------
// Deal posts on Reddit / DesiDime / public Telegram channels: catch what the retailer scan can't see
// (the ₹25,680 Samsung corporate-store G5 surfaced on r/IndianGaming first). Plain HTTP, no browser.
const DEAL_WORDS = /deal|price|sale|drop|offer|steal|discount|lowest|cheap|coupon|clearance|open[\s-]?box|repackag|refurb|₹|\brs\.?\s?\d|\b\d{2,3}k\b/i;
// Reddit's <content> is HTML escaped once more, so decode, strip tags, and repeat
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const strip = (s) => s.replace(/<[^>]+>/g, ' ');
const unhtml = (s) => strip(decode(strip(decode(String(s))))).replace(/\s+/g, ' ').trim();
const parsers = {
  // Reddit search RSS (Atom): one <entry> per post; the JSON API and HTML search are blocked from GitHub IPs, RSS is not
  reddit: (s) => s.split('<entry>').slice(1).map((e) => ({ id: (e.match(/<id>([^<]+)/) || [])[1], title: unhtml((e.match(/<title>([^<]*)/) || [])[1] || ''),
    body: unhtml((e.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '').slice(0, 1500), url: (e.match(/<link href="([^"]+)"/) || [])[1],
    t: (e.match(/<published>([^<]+)/) || [])[1], where: 'r/' + ((e.match(/<category term="([^"]+)"/) || [])[1] || 'reddit') })),
  // DesiDime "new deals" page: every /deals/<slug>-<id> link is a deal post
  desidime: (s) => [...s.matchAll(/<a[^>]+href="(\/deals\/[a-z0-9-]+-(\d+))"[^>]*>([^<]{10,250})<\/a>/g)]
    .map((m) => ({ id: 'dd' + m[2], title: unhtml(m[3]), body: '', url: 'https://www.desidime.com' + m[1], where: 'DesiDime' })),
  // public Telegram channel preview (t.me/s/<channel>): readable without logging in
  // plain RSS 2.0 feeds. (TechEnclave's site, RSS and search alike, answers GitHub IPs with 403: its Telegram channel covers it)
  rss: (s, src) => s.split('<item>').slice(1).map((e) => {
    const link = (e.match(/<link>([^<]+)/) || [])[1] || '';
    return { id: 'rss' + link, title: unhtml((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''), body: unhtml((e.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '').slice(0, 1500),
      url: link, t: (e.match(/<pubDate>([^<]+)/) || [])[1], where: src.name };
  }),
  // Discourse forum search (TechEnclave): newest posts matching the query, incl. replies inside long deal threads
  discourse: (s, src) => {
    const j = JSON.parse(s); const origin = new URL(src.urls[0]).origin;
    const topics = Object.fromEntries((j.topics || []).map((t) => [t.id, t]));
    return (j.posts || []).filter((p) => !src.categories || src.categories.includes(topics[p.topic_id]?.category_id))
      .map((p) => ({ id: 'dc' + p.id, title: `${unhtml(topics[p.topic_id]?.title || '')}: ${unhtml(p.blurb || '')}`.slice(0, 200), body: unhtml(p.blurb || ''), url: `${origin}/t/${p.topic_id}/${p.post_number}`, t: p.created_at, where: src.name }));
  },
  tgchannel: (s) => s.split('data-post="').slice(1).map((e) => {
    const post = e.slice(0, e.indexOf('"')); const text = unhtml((e.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
    return { id: 'tg' + post, title: text.slice(0, 160), body: text, url: 'https://t.me/' + post, t: (e.match(/<time datetime="([^"]+)"/) || [])[1], where: 'Telegram @' + post.split('/')[0] };
  }),
};

async function fetchCommunity() {
  const posts = []; const health = [];
  for (const src of cfg.community || []) {
    let n = 0; const errors = [];
    for (const url of src.urls) {
      try {
        let r;
        for (let i = 0; i < 2; i++) {   // Reddit answers bursts with 429: one slow retry
          r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'accept-language': 'en-IN,en;q=0.9' } });
          if (r.status !== 429) break;
          await new Promise((ok) => setTimeout(ok, 15000));
        }
        if (!r.ok) { errors.push('HTTP ' + r.status); continue; }
        for (const p of parsers[src.kind](await r.text(), src)) {
          if (!p.id || !p.title) continue; n++;
          const text = p.title + ' ' + p.body;
          // a post must be about an OLED monitor; on Reddit (questions, reviews, flexes) it must also read like a deal
          if (!/oled/i.test(text) || !/monitor/i.test(text) && !MONITOR_OK.test(p.title) || NOT_MONITOR.test(p.title.replace(/monitor/ig, ''))) continue;
          if (!/oled|monitor/i.test(p.title) && !modelKey(p.title)) continue;   // OLED only in the body: a PC-build thread, not a deal
          if (src.needDealWords && !DEAL_WORDS.test(text)) continue;
          // forum replies inside a "deals" thread are mostly chat: the reply itself must name a price
          if (src.needPrice && !amountsIn(p.body).length && !/\b\d{2,3}\s?k\b/i.test(p.body)) continue;
          if (p.t && Date.now() - Date.parse(p.t) > 3 * DAY) continue;
          posts.push({ ...p, source: src.name });
        }
      } catch (e) { errors.push(String(e.message).slice(0, 60)); }
    }
    health.push({ name: src.name, found: n, errors: [...new Set(errors)] });
    console.log(src.name, 'posts', n, errors.length ? 'ERR ' + [...new Set(errors)].join(',') : '');
  }
  return { posts: [...new Map(posts.map((p) => [p.id, p])).values()], health };
}

// Report each community post once; the very first run only records what is already there.
// Each new post gets its price and what that model normally costs, when the post names one.
function newCommunityPosts(community, history, now) {
  const seen = readJson('community.json', null);
  const fresh = !seen ? [] : community.posts.filter((p) => !seen.ids[p.id]);
  const ids = Object.fromEntries(Object.entries(seen?.ids || {}).filter(([, t]) => Date.now() - Date.parse(t) < 30 * DAY));
  for (const p of community.posts) ids[p.id] ||= now;
  writeJson('community.json', { init: seen?.init || now, ids });
  for (const p of DRY ? community.posts : fresh) {
    const text = p.title + ' ' + p.body; const key = modelKey(text);
    const amounts = [...new Set(amountsIn(text).filter((n) => n >= cfg.minPrice && n <= cfg.maxPrice))];
    p.price = amounts[0] || 0;
    // "G6 ₹39,848 vs AW2726DM ₹31,063": with several prices the model and the price may not belong together
    const hist = key ? (history[key] || []).map((h) => h.price) : [];
    p.ref = key && amounts.length === 1 ? seeds[key] || (hist.length ? median(hist) : 0) : 0;
  }
  return fresh;
}

// a source that finds nothing several runs in a row is probably broken (layout change, new bot wall): warn once
function brokenSources(health) {
  const streaks = readJson('health.json', {});
  const broken = [];
  for (const h of health) {
    streaks[h.name] = h.found ? 0 : (streaks[h.name] || 0) + 1;
    const known = [...cfg.sources, ...(cfg.community || [])].find((x) => x.name === h.name)?.knownBlocked;
    if (streaks[h.name] === (cfg.brokenAfterRuns || 6) && !known) broken.push({ ...h, runs: streaks[h.name] });
  }
  writeJson('health.json', streaks);
  return broken;
}

const postLine = (p) => `${esc(p.where)}: ${esc(p.title.slice(0, 140))}${p.price ? ` (${fmt(p.price)}${p.ref ? `, normally ~${fmt(p.ref)}` : ''})` : ''}${p.aiNote ? ` · 🤖 ${esc(p.aiNote)}` : ''}`;
// AI check on new community posts: the regexes let through questions, reviews and build threads that mention OLED
async function aiFilterPosts(list) {
  const v = await ai.posts(list);
  return list.filter((p) => {
    const c = v.get(p.id); if (!c) return true;   // no AI answer: keep the rule-based decision
    p.aiNote = c.note; if (!p.price && c.price) p.price = c.price;
    if (!c.deal) console.log('AI-SKIP post', p.where, p.title.slice(0, 80));
    return c.deal;
  });
}
const postTg = (p) => `💬 <a href="${esc(p.url)}">${postLine(p)}</a>`;
const brokenTg = (h) => `⚠️ ${esc(h.name)} found nothing for ${h.runs} runs in a row${h.errors.length ? ' (' + esc(h.errors.join(', ')) + ')' : ''}`;

// Telegram: instant phone ping for what's worth acting on; a failed ping must not cost the email
async function sendTelegram(text) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!text || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }) }).catch((e) => ({ ok: false, status: e.message }));
  console.log('telegram', r.ok ? 'sent' : 'FAILED ' + r.status);
}

// --community-only: just the deal channels/feeds, Telegram only. A light job (no browser, no email) that runs
// between the hourly full scans, because channel deals can sell out before the next hourly run.
async function communityOnly() {
  const community = await fetchCommunity();
  const newPosts = await aiFilterPosts(newCommunityPosts(community, readJson('history.json', {}), new Date().toISOString()));
  ai.save();
  const broken = brokenSources(community.health);
  const tg = [...newPosts.map(postTg), ...broken.map(brokenTg)].join('\n\n');
  if (DRY) {
    console.log('\nCOMMUNITY (all matching posts, shown as if new):\n' + community.posts.map((p) => '  ' + postLine(p) + ' ' + p.url).join('\n'));
    console.log('\nTELEGRAM:', tg || '(nothing to send)');
    return;
  }
  console.log('new posts', newPosts.length, 'broken', broken.length);
  await sendTelegram(tg);
}

// Re-open a deal's product page: is the price really there, and is it in stock?
// A misread price (B&H once parsed as $60 for a $699 monitor) or a sold-out listing must not become an alert.
// a check result that kills the alert: sold out, or the shop itself now shows a different price
const gone = (check) => check === 'out of stock' || String(check).startsWith('price changed');
async function verifyDeal(ctx, it) {
  if (it.apiChecked) return 'verified';   // price + stock came from the store's own API this run (Samsung)
  if (it.preChecked) return it.preChecked;   // Smartprix: stock from its store table (its page lists every shop, so a page check proves nothing)
  // Amazon listings: ask Amazon itself through the scraper (real price + stock at Zameel's pincode) when it is running.
  // Not for other-seller offers (?aod=1), whose price is not the buy-box price the scraper reports.
  const asin = !/[?&]aod=1/.test(it.url || '') && ((it.url || '').match(/amazon\.in\/(?:.*\/)?dp\/(\w{10})/) || [])[1];
  if (asin) {
    const az = await azDetails(asin);
    if (az) {
      const v = azVerdict(az, it.price);
      return v === 'price changed' ? `price changed (Amazon shows ${fmt(az.price)} at your pincode)` : v === 'stock unknown' ? 'unverified (Amazon: stock unknown)' : v;
    }
    if (!ctx) return 'unverified (Amazon check failed)';   // a plain request from a runner gets Amazon's non-India page: useless
  }
  if (!ctx) return verifyHttp(it);   // the 5-minute check has no browser
  const page = await ctx.newPage();
  try {
    await page.goto(it.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(5000);
    const text = await page.evaluate(() => document.body.innerText);
    if (BLOCKED.test(text.slice(0, 1500))) return 'unverified (page blocked)';
    const top = text.slice(0, 6000);
    const close = (n) => Math.abs(n - it.price) <= Math.max(1, it.price * 0.005);
    const seen = amountsIn(text).some(close);
    // second, independent reading (PriceGhost's idea): the structured product data shops embed for Google
    // (JSON-LD offers, product:price meta, itemprop=price). It names the real selling price and stock, where page
    // text also holds EMI amounts, "save ₹X" and other sellers' prices.
    const sd = await page.evaluate(() => {
      const prices = []; let avail = '';
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o['@graph']) walk(o['@graph']);
        if (o.offers) walk(o.offers);
        for (const k of ['price', 'lowPrice']) if (o[k] != null && (o['@type'] || '').toString().includes('Offer')) prices.push(String(o[k]));
        if (o.availability) avail += ' ' + o.availability;
      };
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) { try { walk(JSON.parse(s.textContent)); } catch {} }
      for (const m of document.querySelectorAll('meta[property="product:price:amount"], meta[itemprop="price"]')) prices.push(m.getAttribute('content') || '');
      return { prices, avail };
    }).catch(() => ({ prices: [], avail: '' }));
    const structured = sd.prices.map((p) => Math.round(parseFloat(String(p).replace(/[^0-9.]/g, '')))).filter((n) => n >= R.minAmount);
    if (/OutOfStock|SoldOut|Discontinued/i.test(sd.avail) && !/InStock/i.test(sd.avail)) return 'out of stock';
    if (OUT_OF_STOCK.test(top) && !/add to (cart|bag)|buy now/i.test(top)) return 'out of stock';
    if (structured.length && !structured.some(close)) return `unverified (page data says ${fmt(Math.min(...structured))})`;
    return seen || structured.some(close) ? 'verified' : 'unverified (price not on page)';
  } catch (e) {
    return 'unverified (page failed to load)';
  } finally { await page.close().catch(() => {}); }
}

// The same check over plain HTTP, for pages that are server-rendered (Flipkart): the price must be on the product
// page and the page must not say sold out. Used by the 5-minute check, which runs without a browser.
async function verifyHttp(it) {
  try {
    const r = await fetch(it.url, { headers: { 'user-agent': UA_DESKTOP, accept: 'text/html', 'accept-language': 'en-IN,en;q=0.9' }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) return 'unverified (page blocked)';
    const text = (await r.text()).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, '\n');
    if (BLOCKED.test(text.slice(0, 1500))) return 'unverified (page blocked)';
    if (OUT_OF_STOCK.test(text) && !/add to (cart|bag)|buy now|buy at/i.test(text)) return 'out of stock';
    return amountsIn(text).some((n) => Math.abs(n - it.price) <= Math.max(1, it.price * 0.005)) ? 'verified' : 'unverified (price not on page)';
  } catch (e) { return 'unverified (page failed to load)'; }
}

// --samsung-only: the Samsung shop API alone, every 5 min, Telegram only. Plain HTTP, ~5 s. Samsung's
// repackaged/staff-store stock is the kind that sells out within hours (the ₹25,680 G5 lasted about a day).
// Pings: any repackaged unit in stock, a crazy price vs the usual one, a 10%+ drop, or anything under the price target.
async function samsungOnly() {
  const src = cfg.sources.find((s) => s.kind === 'samsungapi');
  const { items, errors } = await samsungApi(src);
  console.log('Samsung API items', items.length, errors.join(','));
  const history = readJson('history.json', {}); const steady = readJson('steady.json', {}); const fast = readJson('fast.json', {});
  const now = new Date().toISOString(); const deals = [];
  for (const it of items) {
    const key = modelKey(it.title); if (!key) continue;
    const source = `${src.name} · ${it.store}`; const k = key + '|' + retailerOf(source);
    const hist = (history[key] || []).slice(-48).map((h) => h.price);
    const usual = hist.length >= 6 ? median(hist) : seeds[key] || 0;
    const prev = steady[k];
    const why = RISKY_CONDITION.test(it.title) ? 'repackaged unit in stock'
      : usual && it.price <= usual * cfg.crazyThreshold ? `${Math.round((1 - it.price / usual) * 100)}% below the usual ~${fmt(usual)}`
      : prev && it.price <= prev.price * (cfg.dropThreshold || 0.9) ? `dropped from ${fmt(prev.price)}`
      : cfg.priceAlertBelow && it.price < cfg.priceAlertBelow ? `under ${fmt(cfg.priceAlertBelow)}` : '';
    console.log(' ', key, it.store, fmt(it.price), usual ? 'usual ' + fmt(usual) : '', why || '-');
    if (!why) continue;
    const last = fast[k];
    if (last && it.price >= last.price * 0.95 && Date.now() - Date.parse(last.t) < 7 * DAY) continue;
    fast[k] = { price: it.price, t: now };
    deals.push({ title: it.title, price: it.price, why, where: source, url: it.url });
  }
  // Shops with a catalogue API (Elitehubs, TPS: shops.js), all at once, a few seconds, no browser.
  // Same rules as the full scan's early check (far below usual / under the price target / new all-time low), and the
  // API gives live stock, so a glitch price at these shops pings within 5 minutes instead of at the next full scan.
  const shopSrcs = cfg.sources.filter((x) => x.api);
  const shopRes = await Promise.all(shopSrcs.map((x) => shopApi(x, { timeoutMs: 20000 }).catch((e) => ({ items: [], errors: [String(e.message).slice(0, 60)], oos: 0 }))));
  earlyState.fast = fast;   // this run's Samsung pings count as "told already"
  shopSrcs.forEach((x, i) => console.log('SHOP API', x.name, shopRes[i].items.length, 'in stock,', shopRes[i].oos, 'out of stock', shopRes[i].errors.join(',')));
  for (let i = 0; i < shopSrcs.length; i++) await earlyCheck(keepListings(shopSrcs[i], shopRes[i].items), null);
  // Flipkart's search pages over plain HTTP (config fastUrls): what BuyHatke's live Flipkart prices used to cover
  const fk = cfg.sources.find((x) => x.kind === 'flipkart' && x.fastUrls?.length);
  if (fk) {
    // the general searches every run, plus two of the model-specific ones in rotation (all of them within the hour)
    const rest = (fk.urls || []).filter((u) => !fk.fastUrls.includes(u) && !/refurbished|open\+box/.test(u));
    const slot = Math.floor(Date.now() / 300e3);
    const extra = rest.length ? [...new Set([0, 1].map((i) => rest[(slot * 2 + i) % rest.length]))] : [];
    const r = await flipkartHttp([...fk.fastUrls, ...extra]);
    const kept = keepListings(fk, r.items);
    console.log('FLIPKART HTTP', r.items.length, 'cards,', kept.length, 'OLED monitors', r.errors.join(','));
    await earlyCheck(kept, null);
  }
  // NEW Amazon listings (ones not on the watchlist yet): two scraper searches per run, rotating through config
  // fastQueries, at least 20 s apart (back-to-back searches get blocked). The first runs here, the second after the
  // watchlist prices below, which take about that long anyway.
  const azSrc = process.env.AMAZON_SCRAPER_URL ? cfg.sources.find((x) => x.kind === 'amazon' && x.fastQueries?.length) : null;
  const azSlot = Math.floor(Date.now() / 300e3);
  const azQueries = azSrc ? [0, 1].map((i) => azSrc.fastQueries[(azSlot * 2 + i) % azSrc.fastQueries.length]) : [];
  const azFound = []; let azLast = 0;
  const azLook = async (q) => {
    if (!q) return;
    const wait = azLast + 20000 - Date.now(); if (azLast && wait > 0) await new Promise((ok) => setTimeout(ok, wait));
    const r = await azSearch(q); azLast = Date.now();
    if (r) azFound.push(...r);
  };
  await azLook(azQueries[0]);
  // BuyHatke live prices for every watched OLED id (plain HTTP, one request per 50 ids): a flash deal on Amazon or
  // Flipkart reaches Telegram within 5 minutes instead of waiting for the next full scan. Read-only on
  // buyhatke.json (the full scan owns the watchlist); last-seen prices live in fast.json PER LISTING ("bhid|<pos>~<pid>"):
  // keyed per model+shop, two Amazon listings of one model (G6 "Smartchoice" + another) once faked a ₹54,935 -> ₹46,899
  // "drop" that was just the other listing's normal price.
  for (const k of Object.keys(fast)) if (k.startsWith('bh|')) delete fast[k];   // old per-model keys
  const { out: live, errors: bhErr } = await bh.livePrices();
  const stats = bh.statsByKey(); const nl = cfg.newLowAlert || {};
  console.log('BuyHatke live prices', live.length, bhErr.join(','));
  for (const { w, price, oos } of live) {
    if (oos || !w.name || BANNED.test(w.name)) continue;
    const key = w.key || modelKey(w.name); if (!key) continue;
    const store = w.store || ({ 63: 'Amazon', 2: 'Flipkart' })[w.pos] || 'shop';
    const k = key + '|' + retailerOf(store);
    const s = stats[key] || {}; const hist = (history[key] || []).slice(-48).map((h) => h.price);
    const usual = s.monthAvg || (hist.length >= 6 ? median(hist) : seeds[key] || 0);
    const id = 'bhid|' + w.pos + '~' + w.pid;
    // GST-excluded price (BuyHatke quirk on Amazon Business listings): not a real price, don't alert or remember it
    if (exGst(price, fast[id]?.price, w.last, usual)) { console.log('  skip ex-GST price', key, fmt(price)); continue; }
    // remembered only when the price changes: stamping every listing on every run rewrote fast.json each time,
    // which meant a state commit every 5 minutes (289 a day) and most of the push races
    const seen = fast[id]; if (!seen || seen.price !== price) fast[id] = { price, t: now };
    const size = inches(w.name);
    const why = usual && price <= usual * cfg.crazyThreshold ? `${Math.round((1 - price / usual) * 100)}% below the usual ~${fmt(usual)}`
      : s.low && price <= s.low * (1 - (nl.minDropPct ?? 3) / 100) && price <= (nl.maxPrice ?? Infinity) ? `new all-time low (was ${fmt(s.low)})`
      // a drop counts only when it also lands well under the model's usual price: going back to normal is not a deal
      : seen && price <= seen.price * (cfg.dropThreshold || 0.9) && usual && price <= usual * 0.9 && !fakeDiscount(w.hist?.series, price)
        ? `dropped from ${fmt(seen.price)} (usual ~${fmt(usual)})`
      : cfg.priceAlertBelow && price < cfg.priceAlertBelow && BRANDS.test(w.name.toUpperCase()) && (!size || size >= 24) ? `under ${fmt(cfg.priceAlertBelow)}` : '';
    if (!why) continue;
    // BuyHatke's price/stock can be a stale cache: confirm Amazon listings on Amazon before pinging
    const stock = w.pos === 63 ? await amazonStock(w.pid) : 'unknown';
    console.log(' ', key, store, fmt(price), why, stock);
    if (stock === 'out of stock') continue;
    const last = fast[k];
    if (last && price >= last.price * 0.95 && Date.now() - Date.parse(last.t) < 7 * DAY) continue;
    fast[k] = { price, t: now };
    deals.push({ title: w.name, price, why: stock === 'in stock' ? why : why + ' (BuyHatke price, stock not confirmed: check before buying)', where: store, url: w.url });
  }
  // every alert goes to Telegram and into the hourly digest (fast.json .log); email right away only under
  // immediateEmailBelow (₹25k: Zameel's rule, everything else waits for the digest)
  await azLook(azQueries[1]);
  if (azSrc) {
    // bundle listings ("monitor + webcam") carry the add-on's price; every hit is confirmed on Amazon (verifyDeal) before a ping
    const kept = keepListings(azSrc, azFound.filter((x) => !/ \+ /.test(x.title)));
    console.log('AMAZON search found', azFound.length, 'listings,', kept.length, 'OLED monitors');
    await earlyCheck(kept, null);
  }
  // what the shop / Flipkart / Amazon-search checks pinged (earlyCheck sent them): remembered so nothing repeats them
  const shopPings = [...earlyState.pinged].map(([k, e]) => { fast[k] = { price: e.price, t: e.t }; return { title: e.title, price: e.price, why: e.why, where: e.where, url: e.url, t: e.t }; });
  console.log('shop alerts', shopPings.length);
  fast.log = [...(fast.log || []), ...deals.map((d) => ({ ...d, t: now })), ...shopPings].filter((d) => Date.now() - Date.parse(d.t) < 2 * DAY).slice(-60);
  writeJson('fast.json', fast);
  console.log('alerts', deals.length);
  const tg = deals.map((d) => `⚡ <b>${esc(d.where)}</b>: ${esc(d.title.slice(0, 100))}\n<b>${fmt(d.price)}</b>, ${esc(d.why)} · <a href="${esc(d.url)}">open</a>`);
  if (DRY) { console.log(tg.join('\n\n') || '(nothing to send)'); return; }
  await sendTelegram(tg.join('\n\n'));
  for (const d of deals.filter(mailNow)) await dealMail(d.title, d.price, d.why, d.where, d.url, '');
}

// one source's raw items -> the OLED-monitor listings the rules keep (rules.js)
function keepListings(src, items) {
  if (process.env.DEBUG_ITEMS) console.log(src.name, JSON.stringify(items.slice(0, 6)).slice(0, 1800));
  return keepRule(src, items, { cfg, knownOled, usualPrice });
}

// EARLY CHECK: the moment one source has been read, look for a glitch among its listings and ping Telegram right
// away, instead of after the whole ~20-minute scan. Rules only (no AI, no cross-shop comparison yet): a known model
// code at a price far below its usual price, under the price target from a known brand, or under its all-time low.
// Every hit is re-checked on the product page first. The final comparison skips what was already pinged.
const earlyState = { alerted: null, fast: null, lows: null, stats: null, pinged: new Map() };
async function earlyCheck(listings, verifyCtx) {
  if (!cfg.earlyPing?.enabled) return;
  earlyState.alerted ||= readJson('alerted.json', {}); earlyState.fast ||= readJson('fast.json', {});
  earlyState.lows ||= readJson('lows.json', {}); earlyState.stats ||= bh.statsByKey();
  const now = new Date().toISOString(); const nl = cfg.newLowAlert || {};
  const recent = (v, price) => v && price >= (typeof v === 'number' ? v : v.price) * 0.95 && (typeof v === 'number' || Date.now() - Date.parse(v.t) < 7 * DAY);
  for (const it of listings) {
    if (it.generic || it.feed || it.risky) continue;
    const k = it.key + '|' + it.retailer;
    if (earlyState.pinged.has(k)) continue;
    const usual = earlyState.stats[it.key]?.monthAvg || usualPrice(it.key);
    const L = earlyState.lows[it.key]; const low = L ? Math.min(...Object.values(L.days)) : 0;
    const size = inches(it.title);
    const [kind, why] = usual && it.price <= usual * cfg.crazyThreshold ? ['', `${Math.round((1 - it.price / usual) * 100)}% below the usual ~${fmt(usual)}`]
      : cfg.priceAlertBelow && it.price < cfg.priceAlertBelow && BRANDS.test(it.title.toUpperCase()) && !/portable/i.test(it.title) && (!size || size >= 24) ? ['below|', `under ${fmt(cfg.priceAlertBelow)}`]
      : low && it.price <= low * (1 - (nl.minDropPct ?? 3) / 100) && it.price <= (nl.maxPrice ?? Infinity) && L && Date.now() - Date.parse(L.first) >= (nl.minDays ?? 7) * DAY ? ['low|', `new all-time low (was ${fmt(low)})`]
      : [null, ''];
    if (kind === null) continue;
    if (recent(earlyState.alerted[kind + k], it.price) || recent(earlyState.fast[k], it.price)) continue;   // told already
    const check = await verifyDeal(verifyCtx, it);
    const suspect = usual && it.price < usual * 0.25;
    console.log('EARLY', it.key, it.source, fmt(it.price), why, '->', check);
    if (gone(check) || (suspect && check !== 'verified')) continue;
    earlyState.pinged.set(k, { kind, price: it.price, t: now, title: it.title, why, where: it.source, url: it.url });
    if (DRY) { console.log('EARLY PING (dry, not sent):', it.title.slice(0, 80), fmt(it.price), why); continue; }
    await sendTelegram(`⚡ <b>${esc(it.source)}</b>: ${esc(it.title.slice(0, 100))}\n<b>${fmt(it.price)}</b>, ${esc(why)}${check === 'verified' ? ' ✓ checked' : ` (${esc(check)})`} · <a href="${esc(it.url)}">open</a>`);
    if (mailNow(it)) await dealMail(it.title, it.price, why, it.source, it.url, check === 'verified' ? '✓ price + stock checked' : check);
  }
}

// parallel scan (scan.yml): `--part=<name>` scrapes only the sources with that "part" in config.json, pings early,
// and saves its raw results to parts/<name>.json; `--combine` then loads every part and runs the comparison,
// AI, alerts and email. Without either flag, one process does everything (local runs, old behaviour).
const PART = (process.argv.find((a) => a.startsWith('--part=')) || '').slice(7);
const COMBINE = process.argv.includes('--combine');

async function main() {
  if (!PART) writeJson('lastscan.json', { t: new Date().toISOString() });
  const CDP = process.env.CDP_URL;
  const ua = { locale: R.browserLocale, timezoneId: R.timeZone };
  const browser = CDP ? await chromium.connectOverCDP(CDP)
    : await chromium.launch({ headless: !process.env.HEADFUL, channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.BROWSER_PATH || undefined });
  const ctx = CDP ? browser.contexts()[0] : await browser.newContext({ ...ua, viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
  // Amazon.in answers desktop browsers from GitHub's datacenter IPs with a 503 "rush hour" page; a phone-shaped browser gets real results.
  const mobileCtx = CDP ? ctx : await browser.newContext({ ...ua, isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });

  const health = []; const all = [];
  const scraped = [];
  const sources = COMBINE ? [] : PART ? cfg.sources.filter((s) => (s.part || 'shops') === PART) : cfg.sources;
  const t0 = Date.now();
  for (const src of sources) {
    const r = await scrapeSource(src.mobile ? mobileCtx : ctx, src, ctx, scraped.flatMap(([, x]) => x.items));
    scraped.push([src, r]);
    await earlyCheck(keepListings(src, r.items), src.mobile ? mobileCtx : ctx);
    console.log(`SOURCE DONE ${src.name} at +${Math.round((Date.now() - t0) / 1000)} s`);
  }
  if (COMBINE) {   // the parts' results, saved by the parallel jobs
    for (const f of fs.existsSync('parts') ? fs.readdirSync('parts').filter((x) => x.endsWith('.json')) : []) {
      const p = JSON.parse(fs.readFileSync(`parts/${f}`, 'utf8'));
      for (const [name, r] of p.scraped) { const src = cfg.sources.find((s) => s.name === name); if (src) scraped.push([src, r]); }
      for (const [k, e] of p.early || []) earlyState.pinged.set(k, e);
      console.log('PART', f, p.scraped.map(([n, r]) => `${n}:${r.items.length}`).join(' '), 'early pings', (p.early || []).length);
    }
    const missing = cfg.sources.filter((s) => !scraped.some(([x]) => x === s)).map((s) => s.name);
    if (missing.length) console.log('PART MISSING (that job failed or timed out):', missing.join(', '));
    // shown as ❌ in the email's source health, and counted by the broken-source warning
    for (const name of missing) scraped.push([cfg.sources.find((s) => s.name === name), { items: [], errors: ['scan job failed'], blockedUrls: [] }]);
  }
  // Amazon.in blocks GitHub's IPs in waves: the searches that hit the wall often go through a few minutes later
  for (const [src, r] of scraped) {
    if (!r.blockedUrls.length || !src.retries || COMBINE) continue;   // the parts already ran their second pass
    const again = await scrapeSource(src.mobile ? mobileCtx : ctx, { ...src, urls: r.blockedUrls, budgetMs: src.secondPassBudgetMs || src.budgetMs }, ctx);
    console.log('SECOND PASS', src.name, r.blockedUrls.length, 'blocked ->', again.blockedUrls.length, 'still blocked');
    r.items.push(...again.items);
    if (!again.blockedUrls.length) r.errors = r.errors.filter((e) => e !== 'blocked/captcha');
    if (!COMBINE) await earlyCheck(keepListings(src, again.items), src.mobile ? mobileCtx : ctx);
  }
  if (PART) {   // hand the raw results to the combine job and stop: no comparison, AI, email or state commit here
    fs.mkdirSync('parts', { recursive: true });
    fs.writeFileSync(`parts/${PART}.json`, JSON.stringify({ t: new Date().toISOString(), scraped: scraped.map(([s, r]) => [s.name, r]), early: [...earlyState.pinged] }));
    console.log(`PART ${PART} done in ${Math.round((Date.now() - t0) / 1000)} s: ${scraped.map(([s, r]) => `${s.name}:${r.items.length}`).join(' ')}`);
    if (!CDP) await browser.close();
    return;
  }
  for (const [src, r] of scraped) {
    const good = keepListings(src, r.items);
    all.push(...good);
    if (COMBINE && src.kind !== 'buyhatke') bh.harvestAll(good);
    health.push({ name: src.name, found: good.length, errors: [...new Set(r.errors)] });
    console.log(src.name, 'raw', r.items.length, 'kept', good.length, r.errors.length ? 'ERR ' + [...new Set(r.errors)].join(',') : '');
  }

  // AI second opinion on every listing the rules kept (cached per title, so only new listings cost a request):
  // drops non-OLED / non-desktop items the regexes let through, catches open-box/renewed wording, and gives
  // listings with no recognised model code a real model key so they can be compared and alerted on
  const verdicts = await ai.classify(all.map((x) => x.title));
  for (let i = all.length - 1; i >= 0; i--) {
    const it = all[i]; const c = verdicts.get(it.title); if (!c) continue;
    it.ai = c;
    // only the product KIND removes a listing: small models misjudge panel types from model names
    // (qwen3:4b called the PG27AQDM and 34GS95QE "LCD"), and the regex rules already handle titles naming IPS/VA
    const wrongKind = c.kind === 'accessory' || c.kind === 'laptop' || (c.kind === 'portable' && !(c.size >= 22)) || (c.kind === 'tv' && !/monitor/i.test(it.title));
    if (wrongKind) {
      console.log('AI-DROP', it.source, fmt(it.price), it.title.slice(0, 80), JSON.stringify({ kind: c.kind, panel: c.panel }));
      all.splice(i, 1); continue;
    }
    if (['renewed', 'open-box', 'used'].includes(c.cond)) it.risky = true;
    if (it.generic && c.model) {
      it.key = modelKey(`${c.model} ${c.size ? c.size + ' inch' : ''}`) || 'AI ' + c.model.toUpperCase().replace(/\s+/g, '');
      it.generic = false; it.aiKey = true;
    }
  }

  const community = await fetchCommunity();

  // cheapest listing per (model, shop, condition); Smartprix's Amazon row and our own Amazon scrape are the same shop
  const best = new Map();
  for (const it of all) {
    if (!it.key) continue;
    const k = it.key + '|' + it.retailer + '|' + (it.risky ? 'r' : 'n');
    if (!best.has(k) || best.get(k).price > it.price) best.set(k, it);
  }
  const mine = [...best.values()];
  // BuyHatke price history per model (all-time low, month/year averages): months of history we don't have ourselves
  const bhStats = bh.statsByKey();
  for (const it of mine) it.bhs = bhStats[it.key] || null;

  // the other scanner's latest listings (laptop <-> GitHub) widen the comparison; they are never alerted from here
  const peer = cfg.peerSnapshot ? readJsonAt(cfg.peerSnapshot, null) : null;
  const peerAgeH = peer ? (Date.now() - Date.parse(peer.t)) / HOUR : Infinity;
  const myRetailers = new Set(mine.map((x) => x.retailer));
  const peerItems = peer && peerAgeH < 8 ? peer.items.filter((x) => !myRetailers.has(x.retailer)) : [];

  const byModel = {};
  for (const it of [...mine, ...peerItems.map((x) => ({ ...x, peer: true }))]) (byModel[it.key] ||= []).push(it);

  const history = readJson('history.json', {});
  for (const k of Object.keys(history)) {   // fold histories saved under older model keys (e.g. LS27FG502SW -> 27G50SF)
    const nk = modelKey(k);
    if (nk && nk !== k) { history[nk] = [...(history[nk] || []), ...history[k]].sort((a, b) => (a.t < b.t ? -1 : 1)).slice(-120); delete history[k]; }
  }
  const alerted = readJson('alerted.json', {});
  const peerAlerted = cfg.peerSnapshot ? readJsonAt(path.join(path.dirname(cfg.peerSnapshot), 'alerted.json'), {}) : {};
  const now = new Date().toISOString();
  // since when each shop has listed each model at (about) today's price: a "deal" one shop has sat on for days is
  // that shop's normal price, not a flash sale (Elitehubs listed the PG27AQWP-G ~40% under PrimeABGB for weeks).
  // First run: whatever the last snapshot already showed counts as old.
  const steady = readJson('steady.json', null) || Object.fromEntries((readJson('snapshot.json', { items: [] }).items)
    .filter((x) => !x.generic).map((x) => [x.key + '|' + x.retailer, { price: x.price, since: '2026-01-01T00:00:00.000Z', seen: now }]));
  for (const it of mine) {
    if (it.generic) continue;
    const k = it.key + '|' + it.retailer; const p = steady[k];
    // a shop cutting its own price 10%+ since it was last seen listing it is how flash sales start
    if (p && it.price <= p.price * (cfg.dropThreshold || 0.9) && Date.parse(now) - Date.parse(p.seen) < 3 * DAY &&
      // and well under the usual price: a cheaper second listing coming back in stock is not a flash sale
      (!usualPrice(it.key) || it.price <= usualPrice(it.key) * 0.9)) it.dropFrom = p.price;
    if (!p || Math.abs(it.price - p.price) > p.price * 0.02) steady[k] = { price: it.price, since: now, seen: now }; else p.seen = now;
    it.steadyDays = (Date.parse(now) - Date.parse(steady[k].since)) / DAY;
  }
  for (const [k, p] of Object.entries(steady)) if (Date.parse(now) - Date.parse(p.seen) > 14 * DAY) delete steady[k];
  // all-time lows per model (state/lows.json: one lowest price per day, kept 180 days). "Lowest price ever tracked"
  // is the strongest sign of a real deal, and history.json only remembers the last ~120 runs.
  const lows = readJson('lows.json', {});
  const dayStr = now.slice(0, 10);
  for (const it of mine) {
    if (it.generic || it.risky || it.feed) continue;
    let L = lows[it.key];
    if (!L) {   // first sight: seed from the run history we already have
      L = lows[it.key] = { first: now, days: {} };
      for (const h of history[it.key] || []) { const d = h.t.slice(0, 10); L.days[d] = Math.min(L.days[d] || Infinity, h.price); if (h.t < L.first) L.first = h.t; }
    }
    const prev = Object.entries(L.days).filter(([d]) => d !== dayStr).map(([, v]) => v);
    // reference low = ours or BuyHatke's believable all-time low, whichever is lower; BuyHatke's months of
    // history count as "tracked long enough" on day one
    const ownLow = prev.length ? Math.min(...prev) : 0; const bhLow = it.bhs?.low || 0;
    it.prevLow = ownLow && bhLow ? Math.min(ownLow, bhLow) : ownLow || bhLow;
    it.trackedDays = (Date.parse(now) - Date.parse(L.first)) / DAY;
    const nl = cfg.newLowAlert || {};
    if (it.prevLow && it.price <= it.prevLow * (1 - (nl.minDropPct ?? 3) / 100) && (it.trackedDays >= (nl.minDays ?? 7) || bhLow) && it.price <= (nl.maxPrice ?? Infinity)) it.newLow = true;
    L.days[dayStr] = Math.min(L.days[dayStr] || Infinity, it.price);
  }
  for (const L of Object.values(lows)) for (const d of Object.keys(L.days)) if (Date.parse(now) - Date.parse(d) > 180 * DAY) delete L.days[d];
  // our own per-shop price timeline (state/series.json: lowest price per model per shop per day, 120 days).
  // BuyHatke's history pages are walled from GitHub, so this is what the fake-discount check reads; it becomes
  // useful once ~3 weeks are recorded (until then fakeOf falls back to the usual-price rule)
  const series = readJson('series.json', {});
  for (const it of mine) {
    if (it.generic || it.risky || it.feed) continue;
    const d = ((series[it.key + '|' + it.retailer] ||= {}));
    d[dayStr] = Math.min(d[dayStr] || Infinity, it.price);
  }
  for (const [k, d] of Object.entries(series)) { for (const day of Object.keys(d)) if (Date.parse(now) - Date.parse(day) > 120 * DAY) delete d[day]; if (!Object.keys(d).length) delete series[k]; }
  const ownSeries = (key, retailer) => { const d = series[key + '|' + retailer]; return d ? Object.entries(d).sort().map(([day, p]) => [day, day, p]) : null; };
  const crazy = []; const near = [];
  for (const [key, list] of Object.entries(byModel)) {
    const j = judgeModel(list, { hist: (history[key] || []).map((h) => h.price), seed: seeds[key], bhK: bhStats[key], cfg });
    crazy.push(...j.crazy); near.push(...j.near);
    // history tracks the best NORMAL price (no open-box, no deal-feed) from this scanner's own sources
    const normal = list.filter((x) => !x.peer && !x.risky && !x.feed).map((x) => x.price);
    if (normal.length) history[key] = pushHistory(history[key] || [], now, Math.min(...normal));   // one point per hour, 5 days
  }

  // alert only on new or ≥5% lower prices, or the same deal again after a week; skip what the other scanner already sent
  const aKey = (c) => c.key + '|' + c.retailer;
  const prevOf = (store, c) => { const v = store[aKey(c)]; return typeof v === 'number' ? { price: v, t: now } : v; };
  const notRecent = (p, price) => notRecentAt(p, price);
  // the 5-minute Samsung check (--samsung-only) may already have pinged this one
  const fastPinged = readJson('fast.json', {});
  const isFresh = (c) => [prevOf(alerted, c), prevOf(peerAlerted, c), fastPinged[aKey(c)]].every((p) => notRecent(p, c.price));
  const candidates = crazy.filter(isFresh).sort((a, b) => b.pct - a.pct);

  // verify on the product page before alerting
  const fresh = []; const dropped = [];
  for (const c of candidates.slice(0, 8)) {
    const srcCfg = cfg.sources.find((s) => c.source.startsWith(s.name));
    c.check = await verifyDeal(srcCfg?.mobile ? mobileCtx : ctx, c);
    console.log('VERIFY', c.key, c.source, fmt(c.price), '->', c.check);
    if (gone(c.check) || (c.suspect && c.check !== 'verified')) dropped.push(c); else fresh.push(c);
  }
  // price-target alerts: any desktop OLED below a fixed price, whatever the "normal" price says
  // (size check keeps small portable OLED panels out; titles give inches or cm)
  const below = [];
  if (cfg.priceAlertBelow) {
    const shown = new Set(fresh.map(aKey));
    const targets = mine.filter((x) => !x.feed && x.price < cfg.priceAlertBelow && !/portable/i.test(x.title) &&
      (inches(x.title) >= 24 || (!inches(x.title) && !x.generic)) && !shown.has(aKey(x)) &&
      // known monitor brands only: a no-name "LYVON 43-inch OLED panel" at ₹25,886 is not the deal you're after
      BRANDS.test(x.title.toUpperCase()))
      .filter((x) => notRecent(alerted['below|' + aKey(x)], x.price) && notRecent(fastPinged[aKey(x)], x.price))
      .sort((a, b) => a.price - b.price);
    for (const c of targets.slice(0, 5)) {
      const srcCfg = cfg.sources.find((s) => c.source.startsWith(s.name));
      c.check = await verifyDeal(srcCfg?.mobile ? mobileCtx : ctx, c);
      console.log('VERIFY-BELOW', c.key, c.source, fmt(c.price), '->', c.check);
      if (!gone(c.check)) below.push(c);
    }
  }
  // sudden drops (dropFrom, set above): smaller than a crazy deal, but often the first sign of a flash sale
  const drops = [];
  const shownAlready = new Set([...fresh, ...below].map(aKey));
  const dropCands = mine.filter((x) => x.dropFrom && !x.feed && !shownAlready.has(aKey(x)) &&
    notRecent(alerted['drop|' + aKey(x)], x.price) && notRecent(fastPinged[aKey(x)], x.price)).sort((a, b) => a.price / a.dropFrom - b.price / b.dropFrom);
  for (const c of dropCands.slice(0, 5)) {
    const srcCfg = cfg.sources.find((s) => c.source.startsWith(s.name));
    c.check = await verifyDeal(srcCfg?.mobile ? mobileCtx : ctx, c);
    console.log('VERIFY-DROP', c.key, c.source, fmt(c.dropFrom), '->', fmt(c.price), c.check);
    if (!gone(c.check)) drops.push(c);
  }
  // new all-time lows: not 35% off, but cheaper than this model has ever been since tracking started
  const newLows = [];
  const shownSoFar = new Set([...fresh, ...below, ...drops].map(aKey));
  const lowCands = mine.filter((x) => x.newLow && !shownSoFar.has(aKey(x)) && notRecent(alerted['low|' + aKey(x)], x.price) && notRecent(fastPinged[aKey(x)], x.price))
    .sort((a, b) => a.price / a.prevLow - b.price / b.prevLow);
  for (const c of lowCands.slice(0, 4)) {
    const srcCfg = cfg.sources.find((s) => c.source.startsWith(s.name));
    c.check = await verifyDeal(srcCfg?.mobile ? mobileCtx : ctx, c);
    console.log('VERIFY-LOW', c.key, c.source, fmt(c.prevLow), '->', fmt(c.price), c.check);
    if (!gone(c.check)) newLows.push(c);
  }
  // fake discounts: a "drop" that only undoes a recent price hike (PriceDive's trick). BuyHatke's price timeline
  // when we have it for that shop, else our own run history. Fake drops are not alerts; anything else gets a tag.
  const fakeOf = (c) => fakeDiscount(c.bh?.series || bh.seriesFor(c.key, c.retailer) || ownSeries(c.key, c.retailer), c.price) ||
    (c.dropFrom && usualPrice(c.key) && c.dropFrom >= usualPrice(c.key) * 1.08 && c.price >= usualPrice(c.key) * 0.95 ? { normal: usualPrice(c.key), hikedTo: c.dropFrom } : null);
  for (const c of [...fresh, ...below, ...drops]) c.fake = fakeOf(c);
  const fakeDrops = drops.filter((c) => c.fake);
  for (const c of fakeDrops) console.log('FAKE-DROP', c.key, c.source, fmt(c.dropFrom), '->', fmt(c.price), 'normal', fmt(c.fake.normal));
  drops.splice(0, drops.length, ...drops.filter((c) => !c.fake));
  // AI verdict on every alert: one request with the full context (other shops, history, flags)
  const alertList = [...fresh.map((c) => ['crazy: far below other shops', c]), ...below.map((c) => ['under the price target', c]),
    ...drops.map((c) => ['sudden drop at this shop', c]), ...newLows.map((c) => ['new all-time low', c])];
  const judged = await ai.judge(alertList.map(([type, c]) => ({ type, title: c.title.slice(0, 160), price: c.price, shop: c.source,
    condition: c.risky ? 'open-box/renewed/used?' : c.ai?.cond || 'new', pageCheck: c.check || null,
    otherShops: (byModel[c.key] || []).filter((x) => x.retailer !== c.retailer).sort((a, b) => a.price - b.price).slice(0, 5)
      .map((x) => `${x.source} ₹${x.price}${x.risky ? ' (open-box?)' : ''}`),
    lowestTracked: c.prevLow || c.lowestSeen || null, trackedDays: Math.round(c.trackedDays || 0), typicalPrice: usualPrice(c.key) || null,
    previousPriceHere: c.dropFrom || null, smartprixMonthDropPct: c.spDrop != null ? Math.round(c.spDrop) : null,
    bankOffers: c.offers?.length ? c.offers : undefined,
    fakeDiscount: c.fake ? `price was raised to ₹${c.fake.hikedTo} recently; normal before that ~₹${c.fake.normal}` : undefined,
    buyhatkeAllTimeLow: c.bhs?.low || null, buyhatkeMonthAvg: c.bhs?.monthAvg || null, buyhatkeYearAvg: c.bhs?.yearAvg || null,
    // the arithmetic, done here: a 4B model misreads "₹33,999 vs lowest ₹37,999" as nothing special
    pctBelowTypical: usualPrice(c.key) ? Math.round((1 - c.price / usualPrice(c.key)) * 100) : null,
    pctBelowLowestTracked: c.prevLow || c.lowestSeen ? Math.round((1 - c.price / (c.prevLow || c.lowestSeen)) * 100) : null,
    pctBelowCheapestOtherShop: (() => { const o = (byModel[c.key] || []).filter((x) => x.retailer !== c.retailer && !x.risky).map((x) => x.price); return o.length ? Math.round((1 - c.price / Math.min(...o)) * 100) : null; })() })));
  alertList.forEach(([, c], i) => { c.judge = judged.get(i); });
  if (VERIFY_SAMPLE) {
    for (const c of mine.filter((x) => !x.feed).sort((a, b) => a.price - b.price).slice(0, 3)) console.log('SAMPLE-VERIFY', c.key, c.source, fmt(c.price), '->', await verifyDeal(ctx, c), c.url);
  }
  if (CDP) { /* leave the user's browser running */ } else await browser.close();

  for (const c of fresh) alerted[aKey(c)] = { price: c.price, t: now };
  for (const c of below) alerted['below|' + aKey(c)] = { price: c.price, t: now };
  for (const c of drops) alerted['drop|' + aKey(c)] = { price: c.price, t: now };
  for (const c of newLows) alerted['low|' + aKey(c)] = { price: c.price, t: now };
  // early pings (sent mid-scan) count as alerted too, so neither this run's final ping nor the next run repeats them
  for (const [k, e] of earlyState.pinged) alerted[e.kind + k] = { price: e.price, t: e.t };
  const notEarly = (c) => { const e = earlyState.pinged.get(aKey(c)); return !e || c.price < e.price * 0.95; };
  writeJson('lows.json', lows); writeJson('series.json', series);
  writeJson('history.json', history); writeJson('alerted.json', alerted); writeJson('steady.json', steady);
  writeJson('snapshot.json', { t: now, items: mine.filter((x) => !x.feed).map(({ key, generic, source, retailer, price, risky, title, url }) => ({ key, generic, source, retailer, price, risky, title, url })) });

  const newPosts = await aiFilterPosts(newCommunityPosts(community, history, now));
  ai.save();
  const broken = brokenSources([...health, ...community.health]);

  // ---------- email ----------
  const stamp = new Date().toLocaleString(R.numberLocale, { timeZone: R.timeZone, dateStyle: 'medium', timeStyle: 'short' });
  const th = 'style="text-align:left;padding:6px 8px;background:#f3f4f6;border-bottom:1px solid #e5e7eb"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top"';
  const badge = (c) => !c.check ? '' : c.check === 'verified' ? '<span style="color:#15803d">✓ price + stock checked</span>' : `<span style="color:#b45309">⚠ ${esc(c.check)}</span>`;
  const row = (c) => `<tr><td ${td}><b>${esc(c.title.slice(0, 90))}</b>${c.risky ? ' <span style="color:#b45309">⚠ open-box/refurb/used?</span>' : ''}<br>${badge(c)}${aiTag(c)}</td>` +
    `<td ${td}><b>${fmt(c.price)}</b></td><td ${td}>${fmt(c.ref)}<br><small style="color:#6b7280">from ${c.basis} price${c.basis > 1 ? 's' : ''}</small></td>` +
    `<td ${td}>${c.pct}% below${c.lowestSeen ? `<br><small style="color:#6b7280">lowest seen ${fmt(c.lowestSeen)}</small>` : ''}${c.bhs?.monthAvg ? `<br><small style="color:#6b7280">BuyHatke 1-mo avg ${fmt(c.bhs.monthAvg)}${c.bhs.glitchLow ? `, once glitched to ${fmt(c.bhs.glitchLow)}` : ''}</small>` : ''}${c.steadyDays >= 3 ? `<br><small style="color:#6b7280">this price for ${c.steadyDays > 200 ? 'a while' : Math.floor(c.steadyDays) + ' days'}</small>` : ''}</td><td ${td}><a href="${esc(c.url)}">${esc(c.source)}</a></td></tr>`;
  const tbl = (rows) => `<table style="border-collapse:collapse;font:14px Arial;width:100%"><tr><th ${th}>Item</th><th ${th}>Price</th><th ${th}>Normal</th><th ${th}></th><th ${th}>Where</th></tr>${rows.map(row).join('')}</table>`;
  const cheapest = Object.entries(byModel).map(([key, list]) => ({ key, ...list.filter((x) => !x.peer && !x.risky).sort((a, b) => a.price - b.price)[0] }))
    .filter((x) => x.price).sort((a, b) => a.price - b.price).slice(0, 8);
  const bad = health.filter((h) => !h.found);
  let html = `<div style="font:14px Arial;max-width:820px;color:#111"><h2 style="margin:0 0 4px">${esc(R.title)}</h2><div style="color:#6b7280">${stamp} ${R.tzLabel}</div>`;
  if (SALE) html += `<p style="background:#fef3c7;padding:6px 8px">🛍️ <b>${esc(SALE.name)}</b>: scanning every 15 min, alerting from ${Math.round((1 - cfg.crazyThreshold) * 100)}% below.</p>`;
  html += fresh.length ? `<h3 style="color:#b91c1c">🚨 Crazy deals (≥${Math.round((1 - cfg.crazyThreshold) * 100)}% below what other sellers charge)</h3>${tbl(fresh)}<p>${esc(R.buyNote)}</p>`
    : `<h3>No new crazy deal this run.</h3>`;
  if (below.length) html += `<h3 style="color:#b91c1c">🎯 Under ${fmt(cfg.priceAlertBelow)}</h3><ul>${below.map((c) => `<li><b>${fmt(c.price)}</b> ${esc(c.title.slice(0, 90))}${c.risky ? ' ⚠ open-box/refurb?' : ''} · ${badge(c)}${aiTag(c)} · <a href="${esc(c.url)}">${esc(c.source)}</a></li>`).join('')}</ul>`;
  if (drops.length) html += `<h3 style="color:#b45309">📉 Sudden price drops</h3><ul>${drops.map((c) => `<li><b>${fmt(c.price)}</b> <s style="color:#6b7280">${fmt(c.dropFrom)}</s> ${esc(c.title.slice(0, 90))}${c.risky ? ' ⚠ open-box/refurb?' : ''} · ${badge(c)}${aiTag(c)} · <a href="${esc(c.url)}">${esc(c.source)}</a></li>`).join('')}</ul>`;
  // what the 5-minute check (Samsung + BuyHatke) alerted since the last digest: it only mails under ₹25k itself
  const dgPrev = readJson('digest.json', {});
  const fastLog = (readJson('fast.json', {}).log || []).filter((d) => !dgPrev.last || d.t > dgPrev.last);
  if (fastLog.length) html += `<h3>⚡ Alerts from the 5-minute check since the last digest</h3><ul>${fastLog.map((d) => `<li><b>${fmt(d.price)}</b> ${esc(d.title.slice(0, 90))}: ${esc(d.why)} · <a href="${esc(d.url)}">${esc(d.where)}</a></li>`).join('')}</ul>`;
  if (fakeDrops.length) html += `<p style="color:#6b7280">Ignored ${fakeDrops.length} fake discount${fakeDrops.length > 1 ? 's' : ''} (price raised first, then "dropped" back): ${fakeDrops.map((c) => `${esc(c.key)} ${fmt(c.dropFrom)} → ${fmt(c.price)} at ${esc(c.source)}, normally ~${fmt(c.fake.normal)}`).join('; ')}.</p>`;
  if (newLows.length) html += `<h3 style="color:#15803d">🏆 New all-time lows</h3><ul>${newLows.map((c) => `<li><b>${fmt(c.price)}</b> <s style="color:#6b7280">${fmt(c.prevLow)}</s> lowest in ${Math.round(c.trackedDays)} days · ${esc(c.title.slice(0, 90))} · ${badge(c)}${aiTag(c)} · <a href="${esc(c.url)}">${esc(c.source)}</a></li>`).join('')}</ul>`;
  if (dropped.length) html += `<p style="color:#6b7280">Skipped ${dropped.length} deal${dropped.length > 1 ? 's' : ''} that failed the page check: ${dropped.map((c) => `${esc(c.key)} ${fmt(c.price)} at ${esc(c.source)} (${esc(c.check)})`).join('; ')}.</p>`;
  if (near.length) html += `<h3>Near-misses (${Math.round((1 - cfg.nearMissThreshold) * 100)}%+ below, or a bigger drop with only one price to compare)</h3>${tbl(near.sort((a, b) => b.pct - a.pct).slice(0, 8))}`;
  if (newPosts.length) html += `<h3>💬 New community posts</h3><ul>${newPosts.map((p) => `<li><a href="${esc(p.url)}">${postLine(p)}</a></li>`).join('')}</ul>`;
  if (broken.length) html += `<h3 style="color:#b45309">⚠ Sources that stopped working</h3><ul>${broken.map((h) => `<li>${esc(h.name)}: nothing found for ${h.runs} runs in a row${h.errors.length ? ' (' + esc(h.errors.join(', ')) + ')' : ''}. Probably a layout change or a new bot wall: scan.js needs a fix.</li>`).join('')}</ul>`;
  html += `<h3>Cheapest prices right now</h3><table style="border-collapse:collapse;font:14px Arial;width:100%"><tr><th ${th}>Model</th><th ${th}>Price</th><th ${th}>Where</th></tr>${cheapest.map((c) => `<tr><td ${td}>${esc(c.title.slice(0, 80))}</td><td ${td}><b>${fmt(c.price)}</b>${c.mrp > c.price && c.mrp <= c.price * 1.5 ? ` <s style="color:#6b7280">${fmt(c.mrp)}</s>` : ''}</td><td ${td}><a href="${esc(c.url)}">${esc(c.source)}</a>${c.bhId && !c.apiChecked ? '<br><small style="color:#b45309">BuyHatke price, stock not confirmed</small>' : ''}</td></tr>`).join('')}</table>`;
  // (struck-out "MRP" hidden above 1.5x the price: shops' made-up MRPs like ₹1,49,999 on a ₹43,500 monitor)
  html += `<h3>Source health</h3><ul>${[...health, ...community.health].map((h) => `<li>${h.found ? '✅' : '❌'} ${esc(h.name)}: ${h.found} items${h.errors.length ? ' (' + esc(h.errors.join(', ')) + ')' : ''}</li>`).join('')}`;
  html += `<li>${ai.on ? '🤖' : '⚠️'} AI judge (local ${esc(cfg.ai?.model || 'qwen3:4b')} on the runner): ${ai.calls} requests today${ai.on ? '' : ', off this run (rules only)'}</li>`;
  if (cfg.peerSnapshot) html += `<li>${peerAgeH < 26 ? '✅' : '⚠️'} ${esc(cfg.peerLabel)}: ${peer ? `last ran ${peerAgeH < 1 ? 'under an hour' : Math.round(peerAgeH) + 'h'} ago, ${peer.items.length} listings` : 'no run recorded yet'}${peerAgeH >= 26 ? ' (not running: is the laptop on?)' : ''}</li>`;
  html += `</ul><p style="color:#6b7280">${esc(R.footer)}</p></div>`;
  const subject = fresh.length ? `🚨 ${R.subjectTag} crazy deal: ${fresh[0].title.slice(0, 40)} ${fmt(fresh[0].price)} (${fresh[0].pct}% below)`
    : below.length ? `🎯 ${R.subjectTag} under ${fmt(cfg.priceAlertBelow)}: ${below[0].title.slice(0, 40)} ${fmt(below[0].price)}`
    : newLows.length ? `🏆 ${R.subjectTag} new all-time low: ${newLows[0].title.slice(0, 40)} ${fmt(newLows[0].price)} (was ${fmt(newLows[0].prevLow)})`
    : drops.length ? `📉 ${R.subjectTag} price drop: ${drops[0].title.slice(0, 40)} ${fmt(drops[0].dropFrom)} → ${fmt(drops[0].price)}`
    : newPosts.length ? `💬 ${R.subjectTag} community post: ${newPosts[0].title.slice(0, 60)}`
    : `${R.subjectTag} digest ${stamp}: no crazy deal (${cheapest[0] ? 'low ' + fmt(cheapest[0].price) : 'no data'})${bad.length > 3 ? ' ⚠ many sources failed' : ''}${broken.length ? ' ⚠ ' + broken.map((h) => h.name).join(', ') + ' stopped working' : ''}`;

  // Telegram: instant phone ping for what's worth acting on (deals, posts, broken sources); digests stay in email
  const tg = [
    ...fresh.filter(notEarly).map((c) => `🚨 <b>Crazy deal</b>: ${esc(c.title.slice(0, 90))}\n<b>${fmt(c.price)}</b>, ${c.pct}% below ~${fmt(c.ref)}${c.risky ? ' (open-box/refurb?)' : ''}${aiTag(c)} · <a href="${esc(c.url)}">${esc(c.source)}</a>`),
    ...below.filter(notEarly).map((c) => `🎯 <b>Under ${fmt(cfg.priceAlertBelow)}</b>: ${esc(c.title.slice(0, 90))}\n<b>${fmt(c.price)}</b>${c.risky ? ' (open-box/refurb?)' : ''}${c.check === 'verified' ? ' ✓ checked' : ''}${aiTag(c)} · <a href="${esc(c.url)}">${esc(c.source)}</a>`),
    // the AI verdict is advice only: it never hides a ping (a 4B model once called a 10%-below-all-time-low deal "meh")
    ...drops.filter(notEarly).map((c) => `📉 <b>Price drop</b>: ${esc(c.title.slice(0, 90))}\n<b>${fmt(c.price)}</b>, was ${fmt(c.dropFrom)} here${c.risky ? ' (open-box/refurb?)' : ''}${c.check === 'verified' ? ' ✓ checked' : ''}${aiTag(c)} · <a href="${esc(c.url)}">${esc(c.source)}</a>`),
    ...newLows.filter(notEarly).map((c) => `🏆 <b>New all-time low</b>: ${esc(c.title.slice(0, 90))}\n<b>${fmt(c.price)}</b>, lowest in ${Math.round(c.trackedDays)} days (was ${fmt(c.prevLow)})${c.check === 'verified' ? ' ✓ checked' : ''}${aiTag(c)} · <a href="${esc(c.url)}">${esc(c.source)}</a>`),
    ...newPosts.map(postTg), ...broken.map(brokenTg),
  ].join('\n\n');

  if (DRY) {
    console.log('AI VERDICTS', alertList.map(([t, c]) => `${t}: ${c.key} ${c.price} ${c.source} -> ${c.judge ? c.judge.verdict + ' / ' + c.judge.note : '-'}`));
    console.log('NEW LOWS', newLows.map((c) => `${c.key} ${c.prevLow}->${c.price} ${c.source}`));
    console.log('DROPS', drops.map((c) => `${c.key} ${c.dropFrom}->${c.price} ${c.source}`), 'SALE', SALE ? SALE.name : '-');
    console.log('\nCOMMUNITY (all matching posts, shown as if new):\n' + community.posts.map((p) => '  ' + postLine(p) + ' ' + p.url).join('\n'));
    console.log('\nTELEGRAM:', tg || '(nothing to send)');
    console.log('\nSUBJECT:', subject, '\nCRAZY', fresh.length, 'DROPPED', dropped.length, 'NEAR', near.length, 'PEER', peerItems.length,
      '\nCHEAPEST', cheapest.map((c) => `${c.key} ${c.price} ${c.source}`), '\nNEAR', near.map((c) => `${c.key} ${c.price} ${c.source} ref ${c.ref} (${c.basis})`));
    fs.writeFileSync('last-email.html', html); return;
  }
  const hourNow = Number(new Date().toLocaleString('en-US', { timeZone: R.timeZone, hour: 'numeric', hour12: false }));
  // hourly runs land in several digest hours (and GitHub delays some), so send the daily digest only once per local date
  const today = new Date().toLocaleDateString('en-CA', { timeZone: R.timeZone });
  const dailyDigest = (R.dailyDigestHours || []).includes(hourNow) && readJson('digest.json', {}).date !== today;
  await sendTelegram(tg);
  // email (config emailMode):
  //  "hourly"      - a new deal (crazy / under target / real drop / new all-time low, not already mailed by an early
  //                  ping) or a broken source is mailed at once; otherwise the digest goes out at most every digestEveryMin
  //  "alerts-only" - only deals, posts, broken sources, or the daily digest hour;   "always" - every run
  const dg = readJson('digest.json', {});
  const dealNow = [...fresh, ...below, ...drops, ...newLows].some((c) => notEarly(c) && mailNow(c));
  const send = cfg.emailMode === 'always' ? true
    : cfg.emailMode === 'alerts-only' ? dealNow || newPosts.length || broken.length || dailyDigest
    : dealNow || !dg.last || Date.now() - Date.parse(dg.last) >= ((cfg.digestEveryMin ?? 60) - 5) * 60e3;
  if (!send && !process.env.FORCE_EMAIL) { console.log('no new deal; last digest', dg.last, '- skipping email'); return; }
  if (await sendMail(subject, html)) writeJson('digest.json', { ...dg, last: new Date().toISOString(), ...(dailyDigest ? { date: today } : {}) });
}

// one email, used by the digest, the mid-scan early pings and the 5-minute fast check
async function sendMail(subject, html) {
  if (DRY) { console.log('MAIL (dry, not sent):', subject); return false; }
  if (process.env.MAIL_VIA_GH) {
    const { execFileSync } = await import('node:child_process');
    execFileSync('gh', ['workflow', 'run', 'mail.yml', '-R', process.env.MAIL_VIA_GH, '--json'], { input: JSON.stringify({ subject, html }) });
    console.log('email relayed via GitHub:', subject);
    return true;
  }
  const { GMAIL_USER, GMAIL_APP_PASSWORD, MAIL_TO } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !MAIL_TO) { console.log('no mail credentials in this job; not mailed:', subject); return false; }
  try {
    const tx = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
    await tx.sendMail({ from: `${R.title} <${GMAIL_USER}>`, to: MAIL_TO, subject, html });
    console.log('email sent:', subject);
    return true;
  } catch (e) { console.log('EMAIL FAILED', subject, String(e.message).slice(0, 120)); return false; }
}
// immediate email only under cfg.immediateEmailBelow (₹25k, Zameel 2026-11-02); everything else is in the hourly digest
const mailNow = (d) => !cfg.immediateEmailBelow || d.price < cfg.immediateEmailBelow;
// a short "act now" email for one deal (early ping or fast check), sent the same moment as its Telegram ping
const dealMail = (title, price, why, where, url, check) => sendMail(`⚡ OLED deal: ${title.slice(0, 60)} ${fmt(price)} (${why})`,
  `<div style="font:15px Arial;max-width:640px"><h2 style="margin:0 0 6px;color:#b91c1c">⚡ ${esc(title.slice(0, 120))}</h2>` +
  `<p style="font-size:20px;margin:6px 0"><b>${fmt(price)}</b> · ${esc(why)}</p><p>${esc(where)}${check ? ` · ${esc(check)}` : ''}</p>` +
  `<p><a href="${esc(url)}" style="background:#b91c1c;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Open the listing</a></p>` +
  `<p style="color:#6b7280">${esc(R.buyNote)}</p></div>`);
// --if-due: the outside timer fires every 15 min; a full scan runs when the last one is an hour old (15 min in a
// sale season), and the runs in between only check the deal channels
const lastScan = readJson('lastscan.json', {}).t;
// every 15 min all year (the parallel scan takes ~15 min; minutes are free on a public repo): glitches don't wait for sales
// lastscan.json is stamped when combine FINISHES (~3-8 min after the :02 trigger), so 14 min skipped every other
// 15-min slot (full scans ran every 30 min); dispatches are 15 min apart and the concurrency group stops overlaps
const due = !lastScan || Date.now() - Date.parse(lastScan) >= 5 * 60e3;
const has = (f) => process.argv.includes(f);
// --due-check (parallel scan.yml's gate job): just report whether a full scan is due, as a step output
if (has('--due-check')) {
  console.log('full scan due:', due, '(last', lastScan || 'never', ')');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\n`);
  process.exit(0);
}
const run = has('--samsung-only') ? samsungOnly : has('--community-only') || (has('--if-due') && !due) ? communityOnly : main;
console.log('mode', run.name, SALE ? '(sale: ' + SALE.name + ')' : '');
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
