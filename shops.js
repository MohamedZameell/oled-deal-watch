// Shop catalogue APIs: plain HTTP, no browser. Shopify shops publish their catalogue as JSON (the storefront itself
// reads it), with the real selling price AND live stock per product:
//   Elitehubs, TPS Technologies:  /collections/<name>/products.json?limit=250
// config.json: "api": { "type": "shopify" | "woo", "urls": [...] } on a source. Used two ways:
//   - the 5-minute fast check reads every such shop (seconds, no browser), so a glitch price there pings within
//     5 minutes instead of waiting for the next full scan;
//   - the full scan asks the API first and only opens the browser when it returns nothing.
// Only in-stock products are returned, marked apiChecked (price + stock straight from the shop: no page check needed).
// WooCommerce shops have the same kind of API (/wp-json/wc/store/v1/products?search=oled&per_page=100), but
// PrimeABGB and PCStudio answer GitHub's IPs with HTTP 403 (tested 2026-11-10; fine from a home IP), so they have
// no "api" entry and stay on the browser scrape. The reader is kept for a Woo shop that doesn't wall the runner.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const text = (s) => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/[″“”]/g, '"').replace(/\s+/g, ' ').trim();

// Shopify products.json -> items. A product is in stock when any variant is; the price is the cheapest in-stock variant.
export function parseShopify(json, origin) {
  const items = []; let oos = 0;
  for (const p of json?.products || []) {
    const live = (p.variants || []).filter((v) => v.available && +v.price > 0);
    if (!live.length) { oos++; continue; }
    const v = live.reduce((a, b) => (+b.price < +a.price ? b : a));
    const price = Math.round(+v.price); const mrp = Math.round(+v.compare_at_price || 0);
    items.push({ title: text(p.title), price, mrp: mrp > price ? mrp : 0, url: `${origin}/products/${p.handle}`, apiChecked: true });
  }
  return { items, oos };
}

// WooCommerce Store API -> items. Prices come in minor units (currency_minor_unit decimals); 0 = "call for price".
export function parseWoo(json) {
  const items = []; let oos = 0;
  for (const p of Array.isArray(json) ? json : []) {
    const unit = 10 ** (p.prices?.currency_minor_unit || 0);
    const price = Math.round(+(p.prices?.price || 0) / unit); const mrp = Math.round(+(p.prices?.regular_price || 0) / unit);
    if (!p.is_in_stock || !p.is_purchasable || !price) { oos++; continue; }
    items.push({ title: text(p.name), price, mrp: mrp > price ? mrp : 0, url: p.permalink, apiChecked: true });
  }
  return { items, oos };
}

// every URL of one shop's API -> { items, errors, blockedUrls, oos } (same shape as a browser scrape).
// Shopify collections are followed page by page (250 per page, at most 4 pages).
export async function shopApi(src, { timeoutMs = 25000 } = {}) {
  const items = []; const errors = []; let oos = 0;
  const get = async (u) => {
    const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'en-IN,en;q=0.9' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  for (const url of src.api?.urls || []) {
    try {
      if (src.api.type === 'woo') { const r = parseWoo(await get(url)); items.push(...r.items); oos += r.oos; continue; }
      const origin = new URL(url).origin;
      for (let page = 1; page <= 4; page++) {
        const j = await get(url + (url.includes('?') ? '&' : '?') + 'page=' + page);
        const r = parseShopify(j, origin); items.push(...r.items); oos += r.oos;
        if ((j.products || []).length < 250) break;
      }
    } catch (e) { errors.push('api ' + String(e.message).slice(0, 50)); }
  }
  // the same product can sit in two collections
  const seen = new Set(); const unique = items.filter((i) => !seen.has(i.url) && seen.add(i.url));
  return { items: unique, errors, blockedUrls: [], oos };
}
