// OLED deal watch: scrape retailers, compare every listing against what OTHER sellers charge for the same
// model, re-open the product page to confirm price + stock, then email the anomalies.
// One engine for every region; config.json holds the region, sources and thresholds.
// Usage: node scan.js [--dry] [--verify-sample]
//   --dry            print the digest instead of sending it, and don't persist state
//   --verify-sample  also run the product-page check on the 3 cheapest listings (tests the verifier)
//   --community-only only the community feeds (deal channels, Reddit), Telegram pings, no browser or email
// Env: CONFIG, STATE_DIR, CDP_URL (drive an existing browser), BROWSER_CHANNEL (e.g. chrome),
//      MAIL_VIA_GH (relay mail through that repo's mail.yml), FORCE_EMAIL, DEBUG_ITEMS
import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
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
// sale seasons (Big Billion Days, Great Indian Festival, ...): full scans every 15 min instead of hourly, smaller discounts alert
const SALE = (cfg.saleWindows || []).find((w) => Date.now() >= Date.parse(w.from) && Date.now() < Date.parse(w.to) + DAY);
if (SALE) Object.assign(cfg, cfg.saleOverrides || {});

const MONITOR_OK = /monitor|odyssey|ultragear|alienware|aorus|\brog\b|mpg|mag\s?\d|agon|legion|evnia|mobiuz|xeneon|viewfinity|predator|nitro|xg\d{4}|\bAW\d{4}/i;
const NOT_MONITOR = /watch|laptop|notebook|\btv\b|television|smartphone|phone|zenbook|ideapad|vivobook|cooler|ryujin|portable monitor|tablet|soundbar|headphone|projector|keyboard|mouse/i;
// model-code searches ("PG27AQWP", "27Q-10") also return parts and look-alike models: a VESA adapter "compatible with"
// the monitor, Lenovo's IPS LOQ 27Q-10, Samsung's IPS G5. Titles naming a non-OLED panel or an accessory are dropped.
const ACCESSORY = /compatible with|\badapter\b|bracket|wall mount|monitor arm|mount kit|screen (protector|guard)|replacement|power supply|charger|\bcable\b|dust cover/i;
const NON_OLED_PANEL = /\b(IPS|VA|TN|mini[\s-]?LED)\b/i;
const RISKY_CONDITION = /open[\s-]?box|refurb|renewed|repackag|pre[\s-]?owned|\bused\b|b[\s-]?grade|display unit|demo/i;
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
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// "Amazon.com", "DealSea · Amazon" and "amazon" are the same retailer
const retailerOf = (name) => String(name).toLowerCase().replace(/^dealsea · /, '').replace(/\.(com|in)$/, '').replace(/[^a-z0-9&]/g, '');
// product URLs often carry the full name + model code that a cut-off listing title lost
// (Samsung "Odyssey OLED G9 Gaming Monitor with 240..." -> ".../odyssey-oled-g9-g93sd-49-inch-oled-dual-qhd-ls49dg930swxxl/")
const urlWords = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/[-_/.]+/g, ' '); } catch { return ''; } };
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function modelKey(title) {
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
const BRANDS = /\b(ACER|ALIENWARE|DELL|ASUS|SAMSUNG|LG|MSI|GIGABYTE|AORUS|AOC|PHILIPS|HP|OMEN|LENOVO|CORSAIR|SONY|BENQ|VIEWSONIC|KTC|INNOCN|SCEPTRE|XIAOMI|ZOWIE)\b/;
function specKey(title) {
  const t = title.toUpperCase();
  const brand = (t.match(BRANDS) || [])[1]; const size = (t.match(/\b(\d{2})(?:\.\d)?\s?(?:"|”|″|''|-?\s?INCH|IN\b)/) || [])[1];
  if (!brand || !size) return null;
  const res = /4K|UHD|3840/.test(t) ? '4K' : /5K|5120/.test(t) ? '5K' : /QHD|1440|2560/.test(t) ? 'QHD' : /FHD|1080/.test(t) ? 'FHD' : '';
  const hz = Math.max(0, ...[...t.matchAll(/(\d{3})\s?HZ/g)].map((m) => +m[1]));
  return `~${brand} ${size}" ${res}${hz ? ' ' + hz + 'Hz' : ''}`.replace(/\s+/g, ' ');
}
const seeds = Object.fromEntries(Object.entries(cfg.streetPriceSeeds || {}).map(([k, v]) => [modelKey(k) || k, v]));
// models already known to be OLED: a model-code search ("AW2726DM") also finds listings whose title never says OLED
const savedHistory = readJson('history.json', {});
const knownOled = new Set([...Object.keys(seeds), ...Object.keys(savedHistory)].filter((k) => !k.startsWith('~')).map((k) => modelKey(k) || k));
const usualPrice = (key) => seeds[key] || (savedHistory[key]?.length ? median(savedHistory[key].slice(-48).map((h) => h.price)) : 0);

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
  return { title, text, url: a.href.split('?')[0] };
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

async function scrapeSource(ctx, src, deskCtx = ctx) {
  if (src.kind === 'samsungapi') return samsungApi(src);
  const items = []; const errors = []; const blockedUrls = [];
  const page = await ctx.newPage();
  // Amazon serves a bot wall to a cold session far more often than to one that opened the homepage first
  const warmup = async () => { if (src.warmup) { await page.goto(src.warmup, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await page.waitForTimeout(3000); } };
  await warmup();
  for (const url of src.urls) {
    try {
      // some sites (Amazon from datacenter IPs) block at random: retry with fresh cookies and a growing pause
      let body = '', blocked = true, tries = 0;
      while (blocked && tries < (src.retries || 1)) {
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
      if (blocked) { errors.push('blocked/captcha'); blockedUrls.push(url); continue; }
      const before = items.length;
      if (src.kind === 'amazon') {
        for (const r of (await page.evaluate(amazonExtract)).filter((x) => x.price.includes(CUR))) items.push({ title: r.title, price: money(r.price), mrp: money(r.mrp), url: r.url });
      } else if (src.kind === 'flipkart' || src.kind === 'bestbuy') {
        for (const r of await page.evaluate(src.kind === 'bestbuy' ? bestbuyExtract : flipkartExtract)) {
          const a = amountsIn(r.text); if (!a.length) continue;
          items.push({ title: r.title, price: a[0], mrp: a[1] > a[0] ? a[1] : 0, url: r.url });
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
  // plain RSS 2.0 (TechEnclave's Flash Deals category: new deal threads)
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

const postLine = (p) => `${esc(p.where)}: ${esc(p.title.slice(0, 140))}${p.price ? ` (${fmt(p.price)}${p.ref ? `, normally ~${fmt(p.ref)}` : ''})` : ''}`;
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
  const newPosts = newCommunityPosts(community, readJson('history.json', {}), new Date().toISOString());
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
async function verifyDeal(ctx, it) {
  if (it.apiChecked) return 'verified';   // price + stock came from the store's own API this run (Samsung)
  const page = await ctx.newPage();
  try {
    await page.goto(it.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(5000);
    const text = await page.evaluate(() => document.body.innerText);
    if (BLOCKED.test(text.slice(0, 1500))) return 'unverified (page blocked)';
    const top = text.slice(0, 6000);
    const seen = amountsIn(text).some((n) => Math.abs(n - it.price) <= Math.max(1, it.price * 0.005));
    if (OUT_OF_STOCK.test(top) && !/add to (cart|bag)|buy now/i.test(top)) return 'out of stock';
    return seen ? 'verified' : 'unverified (price not on page)';
  } catch (e) {
    return 'unverified (page failed to load)';
  } finally { await page.close().catch(() => {}); }
}

// --samsung-only: the Samsung shop API alone, every 5 min, Telegram only. Plain HTTP, ~5 s. Samsung's
// repackaged/staff-store stock is the kind that sells out within hours (the ₹25,680 G5 lasted about a day).
// Pings: any repackaged unit in stock, a crazy price vs the usual one, a 10%+ drop, or anything under the price target.
async function samsungOnly() {
  const src = cfg.sources.find((s) => s.kind === 'samsungapi');
  const { items, errors } = await samsungApi(src);
  console.log('Samsung API items', items.length, errors.join(','));
  const history = readJson('history.json', {}); const steady = readJson('steady.json', {}); const fast = readJson('fast.json', {});
  const now = new Date().toISOString(); const pings = [];
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
    pings.push(`⚡ <b>Samsung</b>: ${esc(it.title.slice(0, 100))}\n<b>${fmt(it.price)}</b>, ${esc(why)} · <a href="${esc(it.url)}">${esc(source)}</a>`);
  }
  writeJson('fast.json', fast);
  console.log('pings', pings.length);
  if (DRY) { console.log(pings.join('\n\n') || '(nothing to send)'); return; }
  await sendTelegram(pings.join('\n\n'));
}

async function main() {
  writeJson('lastscan.json', { t: new Date().toISOString() });
  const CDP = process.env.CDP_URL;
  const ua = { locale: R.browserLocale, timezoneId: R.timeZone };
  const browser = CDP ? await chromium.connectOverCDP(CDP)
    : await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.BROWSER_PATH || undefined });
  const ctx = CDP ? browser.contexts()[0] : await browser.newContext({ ...ua, viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
  // Amazon.in answers desktop browsers from GitHub's datacenter IPs with a 503 "rush hour" page; a phone-shaped browser gets real results.
  const mobileCtx = CDP ? ctx : await browser.newContext({ ...ua, isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });

  const health = []; const all = [];
  const scraped = [];
  for (const src of cfg.sources) scraped.push([src, await scrapeSource(src.mobile ? mobileCtx : ctx, src, ctx)]);
  // Amazon.in blocks GitHub's IPs in waves: the searches that hit the wall often go through a few minutes later
  for (const [src, r] of scraped) {
    if (!r.blockedUrls.length || !src.retries) continue;
    const again = await scrapeSource(src.mobile ? mobileCtx : ctx, { ...src, urls: r.blockedUrls }, ctx);
    console.log('SECOND PASS', src.name, r.blockedUrls.length, 'blocked ->', again.blockedUrls.length, 'still blocked');
    r.items.push(...again.items);
    if (!again.blockedUrls.length) r.errors = r.errors.filter((e) => e !== 'blocked/captcha');
  }
  for (const [src, { items, errors }] of scraped) {
    if (process.env.DEBUG_ITEMS) console.log(src.name, JSON.stringify(items.slice(0, 6)).slice(0, 1800));
    // one product per URL (+ store): Flipkart lists each product twice, once with a cut-off title
    const byUrl = new Map();
    for (const i of items) { const k = i.url ? i.url + '|' + (i.store || '') : Symbol(); if (!byUrl.has(k) || byUrl.get(k).title.length < i.title.length) byUrl.set(k, i); }
    const good = [...byUrl.values()].filter((i) => {
      const full = i.title + ' ' + urlWords(i.url);
      if (!i.title || !MONITOR_OK.test(full) || NOT_MONITOR.test(i.title) || ACCESSORY.test(i.title) || i.price < cfg.minPrice || i.price > cfg.maxPrice) return false;
      if (/oled/i.test(full)) return true;
      // no "OLED" anywhere: only a known OLED model, no other panel type named, and not absurdly cheap for that model
      const key = modelKey(full); const usual = usualPrice(key);
      return knownOled.has(key) && !NON_OLED_PANEL.test(i.title) && (!usual || i.price >= usual * 0.5);
    });
    for (const g of good) {
      const source = g.store ? `${src.name} · ${g.store}` : src.name;
      const key = modelKey(g.title) || modelKey(urlWords(g.url)); const spec = key ? null : specKey(g.title);
      all.push({ ...g, source, retailer: retailerOf(source), feed: !!src.feed, key: key || spec, generic: !key, risky: RISKY_CONDITION.test(g.title) });
    }
    health.push({ name: src.name, found: good.length, errors: [...new Set(errors)] });
    console.log(src.name, 'raw', items.length, 'kept', good.length, errors.length ? 'ERR ' + [...new Set(errors)].join(',') : '');
  }

  const community = await fetchCommunity();

  // cheapest listing per (model, source, condition)
  const best = new Map();
  for (const it of all) {
    if (!it.key) continue;
    const k = it.key + '|' + it.source + '|' + (it.risky ? 'r' : 'n');
    if (!best.has(k) || best.get(k).price > it.price) best.set(k, it);
  }
  const mine = [...best.values()];

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
    if (p && it.price <= p.price * (cfg.dropThreshold || 0.9) && Date.parse(now) - Date.parse(p.seen) < 3 * DAY) it.dropFrom = p.price;
    if (!p || Math.abs(it.price - p.price) > p.price * 0.02) steady[k] = { price: it.price, since: now, seen: now }; else p.seen = now;
    it.steadyDays = (Date.parse(now) - Date.parse(steady[k].since)) / DAY;
  }
  for (const [k, p] of Object.entries(steady)) if (Date.parse(now) - Date.parse(p.seen) > 14 * DAY) delete steady[k];
  const crazy = []; const near = [];
  for (const [key, list] of Object.entries(byModel)) {
    const hist = (history[key] || []).map((h) => h.price);
    const histRef = hist.length >= 6 ? median(hist) : 0;
    const lowestSeen = hist.length ? Math.min(...hist) : 0;
    for (const it of list) {
      if (it.peer || it.generic) continue;
      // "normal" = what OTHER retailers charge (never the listing itself, never deal-feed or open-box prices),
      // plus the seeded street price and this model's own price history
      const others = list.filter((x) => x.retailer !== it.retailer && !x.risky && !x.feed).map((x) => x.price);
      const signals = [...others, ...(seeds[key] ? [seeds[key]] : []), ...(histRef ? [histRef] : [])];
      if (!signals.length) continue;
      const ref = median(signals);
      const vsRef = it.price / ref; const vsHist = histRef ? it.price / histRef : 1;
      const rec = { ...it, ref, basis: signals.length, lowestSeen, pct: Math.round((1 - vsRef) * 100), suspect: vsRef < 0.25 };
      // an alert needs 2+ independent prices: a single comparison is often a brand store's list price
      // (Samsung.com "From $499" vs a normal $329 street price) and would cry wolf
      const isCrazy = vsRef <= cfg.crazyThreshold || (vsHist <= cfg.historyThreshold && vsRef < 0.9);
      if (isCrazy && signals.length >= 2 && !(it.steadyDays >= 3)) crazy.push(rec);
      else if (isCrazy || vsRef <= cfg.nearMissThreshold) near.push(rec);
    }
    // history tracks the best NORMAL price (no open-box, no deal-feed) from this scanner's own sources
    const normal = list.filter((x) => !x.peer && !x.risky && !x.feed).map((x) => x.price);
    if (normal.length) { (history[key] ||= []).push({ t: now, price: Math.min(...normal) }); history[key] = history[key].slice(-120); }
  }

  // alert only on new or ≥5% lower prices, or the same deal again after a week; skip what the other scanner already sent
  const aKey = (c) => c.key + '|' + c.retailer;
  const prevOf = (store, c) => { const v = store[aKey(c)]; return typeof v === 'number' ? { price: v, t: now } : v; };
  const notRecent = (p, price) => !p || price < p.price * 0.95 || Date.now() - Date.parse(p.t) > 7 * DAY;
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
    if (c.check === 'out of stock' || (c.suspect && c.check !== 'verified')) dropped.push(c); else fresh.push(c);
  }
  // price-target alerts: any desktop OLED below a fixed price, whatever the "normal" price says
  // (size check keeps small portable OLED panels out; titles give inches or cm)
  const inches = (t) => { const m = t.match(/(\d{2}(?:\.\d)?)\s*(?:-?\s?inch|in\b|["”])/i); if (m) return +m[1];
    const c = t.match(/(\d{2,3}(?:\.\d+)?)\s*cm/i); return c ? +c[1] / 2.54 : 0; };
  const below = [];
  if (cfg.priceAlertBelow) {
    const shown = new Set(fresh.map(aKey));
    const targets = mine.filter((x) => !x.feed && x.price < cfg.priceAlertBelow && !/portable/i.test(x.title) &&
      (inches(x.title) >= 24 || (!inches(x.title) && !x.generic)) && !shown.has(aKey(x)))
      .filter((x) => notRecent(alerted['below|' + aKey(x)], x.price) && notRecent(fastPinged[aKey(x)], x.price))
      .sort((a, b) => a.price - b.price);
    for (const c of targets.slice(0, 5)) {
      const srcCfg = cfg.sources.find((s) => c.source.startsWith(s.name));
      c.check = await verifyDeal(srcCfg?.mobile ? mobileCtx : ctx, c);
      console.log('VERIFY-BELOW', c.key, c.source, fmt(c.price), '->', c.check);
      if (c.check !== 'out of stock') below.push(c);
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
    if (c.check !== 'out of stock') drops.push(c);
  }
  if (VERIFY_SAMPLE) {
    for (const c of mine.filter((x) => !x.feed).sort((a, b) => a.price - b.price).slice(0, 3)) console.log('SAMPLE-VERIFY', c.key, c.source, fmt(c.price), '->', await verifyDeal(ctx, c), c.url);
  }
  if (CDP) { /* leave the user's browser running */ } else await browser.close();

  for (const c of fresh) alerted[aKey(c)] = { price: c.price, t: now };
  for (const c of below) alerted['below|' + aKey(c)] = { price: c.price, t: now };
  for (const c of drops) alerted['drop|' + aKey(c)] = { price: c.price, t: now };
  writeJson('history.json', history); writeJson('alerted.json', alerted); writeJson('steady.json', steady);
  writeJson('snapshot.json', { t: now, items: mine.filter((x) => !x.feed).map(({ key, generic, source, retailer, price, risky, title, url }) => ({ key, generic, source, retailer, price, risky, title, url })) });

  const newPosts = newCommunityPosts(community, history, now);
  const broken = brokenSources([...health, ...community.health]);

  // ---------- email ----------
  const stamp = new Date().toLocaleString(R.numberLocale, { timeZone: R.timeZone, dateStyle: 'medium', timeStyle: 'short' });
  const th = 'style="text-align:left;padding:6px 8px;background:#f3f4f6;border-bottom:1px solid #e5e7eb"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top"';
  const badge = (c) => !c.check ? '' : c.check === 'verified' ? '<span style="color:#15803d">✓ price + stock checked</span>' : `<span style="color:#b45309">⚠ ${esc(c.check)}</span>`;
  const row = (c) => `<tr><td ${td}><b>${esc(c.title.slice(0, 90))}</b>${c.risky ? ' <span style="color:#b45309">⚠ open-box/refurb/used?</span>' : ''}<br>${badge(c)}</td>` +
    `<td ${td}><b>${fmt(c.price)}</b></td><td ${td}>${fmt(c.ref)}<br><small style="color:#6b7280">from ${c.basis} price${c.basis > 1 ? 's' : ''}</small></td>` +
    `<td ${td}>${c.pct}% below${c.lowestSeen ? `<br><small style="color:#6b7280">lowest seen ${fmt(c.lowestSeen)}</small>` : ''}${c.steadyDays >= 3 ? `<br><small style="color:#6b7280">this price for ${c.steadyDays > 200 ? 'a while' : Math.floor(c.steadyDays) + ' days'}</small>` : ''}</td><td ${td}><a href="${esc(c.url)}">${esc(c.source)}</a></td></tr>`;
  const tbl = (rows) => `<table style="border-collapse:collapse;font:14px Arial;width:100%"><tr><th ${th}>Item</th><th ${th}>Price</th><th ${th}>Normal</th><th ${th}></th><th ${th}>Where</th></tr>${rows.map(row).join('')}</table>`;
  const cheapest = Object.entries(byModel).map(([key, list]) => ({ key, ...list.filter((x) => !x.peer && !x.risky).sort((a, b) => a.price - b.price)[0] }))
    .filter((x) => x.price).sort((a, b) => a.price - b.price).slice(0, 8);
  const bad = health.filter((h) => !h.found);
  let html = `<div style="font:14px Arial;max-width:820px;color:#111"><h2 style="margin:0 0 4px">${esc(R.title)}</h2><div style="color:#6b7280">${stamp} ${R.tzLabel}</div>`;
  if (SALE) html += `<p style="background:#fef3c7;padding:6px 8px">🛍️ <b>${esc(SALE.name)}</b>: scanning every 15 min, alerting from ${Math.round((1 - cfg.crazyThreshold) * 100)}% below.</p>`;
  html += fresh.length ? `<h3 style="color:#b91c1c">🚨 Crazy deals (≥${Math.round((1 - cfg.crazyThreshold) * 100)}% below what other sellers charge)</h3>${tbl(fresh)}<p>${esc(R.buyNote)}</p>`
    : `<h3>No new crazy deal this run.</h3>`;
  if (below.length) html += `<h3 style="color:#b91c1c">🎯 Under ${fmt(cfg.priceAlertBelow)}</h3><ul>${below.map((c) => `<li><b>${fmt(c.price)}</b> ${esc(c.title.slice(0, 90))}${c.risky ? ' ⚠ open-box/refurb?' : ''} · ${badge(c)} · <a href="${esc(c.url)}">${esc(c.source)}</a></li>`).join('')}</ul>`;
  if (drops.length) html += `<h3 style="color:#b45309">📉 Sudden price drops</h3><ul>${drops.map((c) => `<li><b>${fmt(c.price)}</b> <s style="color:#6b7280">${fmt(c.dropFrom)}</s> ${esc(c.title.slice(0, 90))}${c.risky ? ' ⚠ open-box/refurb?' : ''} · ${badge(c)} · <a href="${esc(c.url)}">${esc(c.source)}</a></li>`).join('')}</ul>`;
  if (dropped.length) html += `<p style="color:#6b7280">Skipped ${dropped.length} deal${dropped.length > 1 ? 's' : ''} that failed the page check: ${dropped.map((c) => `${esc(c.key)} ${fmt(c.price)} at ${esc(c.source)} (${esc(c.check)})`).join('; ')}.</p>`;
  if (near.length) html += `<h3>Near-misses (${Math.round((1 - cfg.nearMissThreshold) * 100)}%+ below, or a bigger drop with only one price to compare)</h3>${tbl(near.sort((a, b) => b.pct - a.pct).slice(0, 8))}`;
  if (newPosts.length) html += `<h3>💬 New community posts</h3><ul>${newPosts.map((p) => `<li><a href="${esc(p.url)}">${postLine(p)}</a></li>`).join('')}</ul>`;
  if (broken.length) html += `<h3 style="color:#b45309">⚠ Sources that stopped working</h3><ul>${broken.map((h) => `<li>${esc(h.name)}: nothing found for ${h.runs} runs in a row${h.errors.length ? ' (' + esc(h.errors.join(', ')) + ')' : ''}. Probably a layout change or a new bot wall: scan.js needs a fix.</li>`).join('')}</ul>`;
  html += `<h3>Cheapest prices right now</h3><table style="border-collapse:collapse;font:14px Arial;width:100%"><tr><th ${th}>Model</th><th ${th}>Price</th><th ${th}>Where</th></tr>${cheapest.map((c) => `<tr><td ${td}>${esc(c.title.slice(0, 80))}</td><td ${td}><b>${fmt(c.price)}</b>${c.mrp > c.price ? ` <s style="color:#6b7280">${fmt(c.mrp)}</s>` : ''}</td><td ${td}><a href="${esc(c.url)}">${esc(c.source)}</a></td></tr>`).join('')}</table>`;
  html += `<h3>Source health</h3><ul>${[...health, ...community.health].map((h) => `<li>${h.found ? '✅' : '❌'} ${esc(h.name)}: ${h.found} items${h.errors.length ? ' (' + esc(h.errors.join(', ')) + ')' : ''}</li>`).join('')}`;
  if (cfg.peerSnapshot) html += `<li>${peerAgeH < 26 ? '✅' : '⚠️'} ${esc(cfg.peerLabel)}: ${peer ? `last ran ${peerAgeH < 1 ? 'under an hour' : Math.round(peerAgeH) + 'h'} ago, ${peer.items.length} listings` : 'no run recorded yet'}${peerAgeH >= 26 ? ' (not running: is the laptop on?)' : ''}</li>`;
  html += `</ul><p style="color:#6b7280">${esc(R.footer)}</p></div>`;
  const subject = fresh.length ? `🚨 ${R.subjectTag} crazy deal: ${fresh[0].title.slice(0, 40)} ${fmt(fresh[0].price)} (${fresh[0].pct}% below)`
    : below.length ? `🎯 ${R.subjectTag} under ${fmt(cfg.priceAlertBelow)}: ${below[0].title.slice(0, 40)} ${fmt(below[0].price)}`
    : drops.length ? `📉 ${R.subjectTag} price drop: ${drops[0].title.slice(0, 40)} ${fmt(drops[0].dropFrom)} → ${fmt(drops[0].price)}`
    : newPosts.length ? `💬 ${R.subjectTag} community post: ${newPosts[0].title.slice(0, 60)}`
    : `${R.subjectTag} digest ${stamp}: no crazy deal (${cheapest[0] ? 'low ' + fmt(cheapest[0].price) : 'no data'})${bad.length > 3 ? ' ⚠ many sources failed' : ''}${broken.length ? ' ⚠ ' + broken.map((h) => h.name).join(', ') + ' stopped working' : ''}`;

  // Telegram: instant phone ping for what's worth acting on (deals, posts, broken sources); digests stay in email
  const tg = [
    ...fresh.map((c) => `🚨 <b>Crazy deal</b>: ${esc(c.title.slice(0, 90))}\n<b>${fmt(c.price)}</b>, ${c.pct}% below ~${fmt(c.ref)}${c.risky ? ' (open-box/refurb?)' : ''} · <a href="${esc(c.url)}">${esc(c.source)}</a>`),
    ...below.map((c) => `🎯 <b>Under ${fmt(cfg.priceAlertBelow)}</b>: ${esc(c.title.slice(0, 90))}\n<b>${fmt(c.price)}</b>${c.risky ? ' (open-box/refurb?)' : ''}${c.check === 'verified' ? ' ✓ checked' : ''} · <a href="${esc(c.url)}">${esc(c.source)}</a>`),
    ...drops.map((c) => `📉 <b>Price drop</b>: ${esc(c.title.slice(0, 90))}\n<b>${fmt(c.price)}</b>, was ${fmt(c.dropFrom)} here${c.risky ? ' (open-box/refurb?)' : ''}${c.check === 'verified' ? ' ✓ checked' : ''} · <a href="${esc(c.url)}">${esc(c.source)}</a>`),
    ...newPosts.map(postTg), ...broken.map(brokenTg),
  ].join('\n\n');

  if (DRY) {
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
  if (cfg.emailMode === 'alerts-only' && !fresh.length && !below.length && !drops.length && !newPosts.length && !broken.length && !dailyDigest && !process.env.FORCE_EMAIL) { console.log('no alert; skipping email'); return; }
  if (process.env.MAIL_VIA_GH) {
    const { execFileSync } = await import('node:child_process');
    execFileSync('gh', ['workflow', 'run', 'mail.yml', '-R', process.env.MAIL_VIA_GH, '--json'], { input: JSON.stringify({ subject, html }) });
    console.log('email relayed via GitHub:', subject);
    return;
  }
  const { GMAIL_USER, GMAIL_APP_PASSWORD, MAIL_TO } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !MAIL_TO) throw new Error('Missing GMAIL_USER / GMAIL_APP_PASSWORD / MAIL_TO');
  const tx = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  await tx.sendMail({ from: `${R.title} <${GMAIL_USER}>`, to: MAIL_TO, subject, html });
  if (dailyDigest) writeJson('digest.json', { date: today });
  console.log('email sent:', subject);
}
// --if-due: the outside timer fires every 15 min; a full scan runs when the last one is an hour old (15 min in a
// sale season), and the runs in between only check the deal channels
const lastScan = readJson('lastscan.json', {}).t;
const due = !lastScan || Date.now() - Date.parse(lastScan) >= (SALE ? 14 : 55) * 60e3;
const has = (f) => process.argv.includes(f);
const run = has('--samsung-only') ? samsungOnly : has('--community-only') || (has('--if-due') && !due) ? communityOnly : main;
console.log('mode', run.name, SALE ? '(sale: ' + SALE.name + ')' : '');
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
