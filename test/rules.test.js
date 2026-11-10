// Deal rules. Each "regression" case is a false alert (or a missed listing) that really happened; it must stay fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelKey, specKey, inches, retailerOf, median, keepListings, judgeModel, pushHistory, notRecent } from '../rules.js';

const cfg = { minPrice: 12000, maxPrice: 250000, crazyThreshold: 0.65, nearMissThreshold: 0.8, historyThreshold: 0.7, bannedBrands: ['LYVON'] };
const usual = { AW2726DM: 40300, '27G50SF': 42499, 'LEGION27Q-10': 41999 };
const ctx = { cfg, knownOled: new Set(Object.keys(usual)), usualPrice: (k) => usual[k] || 0 };
const keep = (title, price, extra = {}, src = { name: 'Shop', kind: 'text' }) => keepListings(src, [{ title, price, url: 'https://shop.example/p/' + encodeURIComponent(title), ...extra }], ctx);

test('modelKey: the same Samsung panel under its retail code and its Odyssey name is one model', () => {
  assert.equal(modelKey('Samsung Odyssey OLED G5 LS27FG502SWXXL 27 Inch Monitor'), '27G50SF');
  assert.equal(modelKey('Samsung 27" Odyssey OLED G5 G50SF QHD 180Hz'), '27G50SF');
  assert.equal(modelKey('SAMSUNG Odyssey G9 LS49DG930SWXXL 49 Inch'), '49G93SD');
});
test('modelKey: one key per model across the shops (titles as the shops print them)', () => {
  for (const [title, key] of [
    ['Alienware AW2726DM 27-Inch QD-OLED Gaming Monitor 240Hz QHD Display', 'AW2726DM'],
    ['Dell Alienware AW2725D 27" 280Hz 0.03ms QHD QD-OLED Gaming Monitor', 'AW2725D'],
    ['AOC Agon Pro AG276QZD2 27 Inch QHD OLED Monitor (AG276QZD2)', 'AG276QZD2'],
    ['LG UltraGear 27GX790A-B 27" 480Hz OLED QHD 1440P Gaming Monitor', '27GX790A'],
    ['Msi Mag 341CQP QD-OLED 34 Inch UWQHD Curved Gaming Monitor', 'MAG341CQP'],
    ['MSI MPG 341CQPX QD-OLED 34" 2K UWQHD 240Hz', 'MPG341CQPX'],
    ['ASUS ROG Strix OLED 27 inch XG27AQDMES QHD 240Hz Gaming Monitor', 'XG27AQDMES'],
    ['ASUS ROG Swift PG27AQDM 27" 240Hz 1440p Gaming Monitor', 'PG27AQDM'],
    ['VIEWSONIC XG2738 27 Inch 2K QHD 240Hz Oled Panel', 'XG2738'],
    ['Gigabyte AORUS FO27Q2 27 inch Inch OLED 1440p 240 Hz Gaming Monitor Black', 'FO27Q2'],
    ['BenQ MOBIUZ EX271UZ 27 Inch 4K QD-OLED Gaming Monitor', 'EX271UZ'],
    ['Lenovo Legion 27Q-10 OLED 67.31cms (26.5) Monitor', 'LEGION27Q-10'],
  ]) assert.equal(modelKey(title), key, title);
});
test('modelKey: the IPS Lenovo LOQ 27Q-10 is not the Legion OLED', () => {
  assert.equal(modelKey('Lenovo LOQ 27Q-10 27 inch QHD IPS Monitor'), null);
});
test('specKey groups a code-less title by brand, size, resolution and refresh', () => {
  assert.equal(specKey('Acer - Predator 27" QD-OLED QHD 240Hz Gaming Monitor'), '~ACER 27" QHD 240Hz');
  assert.equal(specKey('Some OLED monitor'), null);
});
test('inches reads inch, quote and cm sizes', () => {
  assert.equal(inches('Legion 27Q-10 OLED 26.5-inch QHD'), 26.5);
  assert.equal(inches('MSI MAG 341CQP 34" UWQHD'), 34);
  assert.equal(Math.round(inches('Lenovo OLED 68.4 cm Monitor')), 27);
  assert.equal(inches('ASUS ROG Swift OLED PG27AQWP-W'), 0);
});
test('retailerOf: "Amazon.in", "DealSea · Amazon" and "amazon" are one shop', () => {
  assert.equal(retailerOf('Amazon.in'), 'amazon'); assert.equal(retailerOf('DealSea · Amazon'), 'amazon');
});
test('median', () => { assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 1, 2, 3]), 2.5); });

test('keepListings keeps an OLED monitor and gives it a model key and shop', () => {
  const [it] = keep('Alienware AW2726DM 27-Inch QD-OLED Gaming Monitor', 39799);
  assert.equal(it.key, 'AW2726DM'); assert.equal(it.retailer, 'shop'); assert.equal(it.generic, false); assert.equal(it.risky, false);
});
test('regression: banned brand LYVON never becomes a listing (a 43" "OLED" at Rs 25,886 pinged the price target)', () => {
  assert.equal(keep('LYVON 43 inch OLED Smart Monitor 4K', 25886).length, 0);
});
test('keepListings drops accessories, laptops, coolers, PSUs and other panels', () => {
  assert.equal(keep('VESA adapter compatible with Alienware AW2726DM OLED monitor', 14999).length, 0);
  assert.equal(keep('Asus ZENBOOK S14 OLED 14.0 Inch Laptop ROG', 156264).length, 0);
  assert.equal(keep('Lian Li Hydroshift II OLED AIO CPU Cooler 360mm Aorus', 30900).length, 0);
  assert.equal(keep('Asus ROG THOR 3000W Titanium ATX 3.1 Fully Modular SMPS With Magnetic OLED', 95500).length, 0);
  assert.equal(keep('Samsung Odyssey G5 27 inch IPS Monitor LS27FG502SWXXL', 21999).length, 0);   // known code, but names an IPS panel
});
test('keepListings: price outside the plausible band is a misread, not a deal', () => {
  assert.equal(keep('Samsung Odyssey OLED G9 49 inch Monitor', 2995).length, 0);   // a bundle add-on price
  assert.equal(keep('Samsung Odyssey OLED G9 49 inch Monitor', 2470000).length, 0);
});
test('keepListings: a known OLED model whose title never says OLED is kept unless absurdly cheap', () => {
  assert.equal(keep('Dell Alienware AW2726DM 27 Gaming Monitor', 39799).length, 1);
  assert.equal(keep('Dell Alienware AW2726DM 27 Gaming Monitor stand', 13000).length, 0);   // under half the usual price
});
test('keepListings flags open-box / repackaged units as risky', () => {
  assert.equal(keep('Samsung Odyssey OLED G5 LS27FG502SW (repackaged) Monitor', 25680)[0].risky, true);
});
test('keepListings: one product per URL, the longer title wins (Flipkart lists each twice)', () => {
  const url = 'https://flipkart.example/p/itm1';
  const out = keepListings({ name: 'Flipkart', kind: 'flipkart' }, [{ title: 'Alienware AW2726DM QD-OLED Mon...', price: 39799, url }, { title: 'Alienware AW2726DM QD-OLED Monitor 27 inch', price: 39799, url }], ctx);
  assert.equal(out.length, 1); assert.match(out[0].title, /27 inch/);
});

const L = (retailer, price, extra = {}) => ({ key: 'AW2726DM', retailer, price, title: 'AW2726DM', ...extra });
const judge = (list, o = {}) => judgeModel(list, { hist: [], seed: 0, bhK: undefined, cfg, ...o });
test('judgeModel: a price 35%+ under what two other shops charge is crazy', () => {
  const { crazy } = judge([L('a', 25000), L('b', 40000), L('c', 41000)]);
  assert.equal(crazy.length, 1); assert.equal(crazy[0].retailer, 'a'); assert.equal(crazy[0].pct, 38);
});
test('judgeModel: one comparison price is never enough to alert (it becomes a near-miss)', () => {
  const { crazy, near } = judge([L('a', 25000), L('b', 40000)]);
  assert.equal(crazy.length, 0); assert.equal(near.length, 1);
});
test('regression: a price a shop has held for 3+ days is its normal price, not a flash sale (Elitehubs PG27AQWP)', () => {
  const { crazy, near } = judge([L('a', 25000, { steadyDays: 12 }), L('b', 40000), L('c', 41000)]);
  assert.equal(crazy.length, 0); assert.equal(near.length, 1);
});
test('judgeModel: open-box and deal-feed prices never set the "normal" price', () => {
  const { crazy } = judge([L('a', 39000), L('b', 40000), L('c', 22000, { risky: true }), L('d', 21000, { feed: true })]);
  assert.deepEqual(crazy.map((c) => c.retailer).sort(), ['c', 'd']);   // the cheap ones are judged against the normal shops, never the other way round
});
test('judgeModel: seed and history count as signals; a normal price is not flagged', () => {
  const hist = Array(10).fill(40000);
  assert.equal(judge([L('a', 25000)], { hist, seed: 40300 }).crazy.length, 1);
  const r = judge([L('a', 39500)], { hist, seed: 40300 });
  assert.equal(r.crazy.length + r.near.length, 0);
});
test('judgeModel: under a quarter of normal is marked suspect (must pass the page check to alert)', () => {
  assert.equal(judge([L('a', 9000), L('b', 40000), L('c', 41000)]).crazy[0].suspect, true);
});

test('pushHistory keeps one point per hour (its lowest price) and at most 120 points', () => {
  let h = [];
  h = pushHistory(h, '2026-11-10T10:02:00.000Z', 40000);
  h = pushHistory(h, '2026-11-10T10:17:00.000Z', 39000);
  h = pushHistory(h, '2026-11-10T10:47:00.000Z', 40000);
  assert.deepEqual(h, [{ t: '2026-11-10T10:02:00.000Z', price: 39000 }]);
  h = pushHistory(h, '2026-11-10T11:02:00.000Z', 40000);
  assert.equal(h.length, 2);
  for (let i = 0; i < 300; i++) h = pushHistory(h, new Date(Date.UTC(2026, 10, 11) + i * 3600e3).toISOString(), 40000);
  assert.equal(h.length, 120);
});
test('regression: four scans an hour must not shrink the "usual price" window (48 points = 2 days, not 12 hours)', () => {
  let h = []; const t0 = Date.UTC(2026, 10, 1);
  for (let i = 0; i < 4 * 48; i++) h = pushHistory(h, new Date(t0 + i * 15 * 60e3).toISOString(), 40000);   // 2 days of 15-minute scans
  assert.equal(h.length, 48);
  assert.equal((Date.parse(h.at(-1).t) - Date.parse(h[0].t)) / 3600e3, 47);
});
test('notRecent: re-alert only when 5%+ cheaper or after a week', () => {
  const now = Date.parse('2026-11-10T00:00:00Z'); const p = { price: 30000, t: '2026-11-08T00:00:00Z' };
  assert.equal(notRecent(undefined, 30000, now), true);
  assert.equal(notRecent(p, 30000, now), false);
  assert.equal(notRecent(p, 29000, now), false);
  assert.equal(notRecent(p, 28000, now), true);
  assert.equal(notRecent({ ...p, t: '2026-11-01T00:00:00Z' }, 30000, now), true);
});

import { typicalPrice } from '../rules.js';
test('typicalPrice: median of the last 30 days of daily lows; nothing until 7 days are recorded', () => {
  const now = Date.parse('2026-11-10T12:00:00Z'); const day = (n) => new Date(now - n * 864e5).toISOString().slice(0, 10);
  const days = {}; for (let i = 0; i < 20; i++) days[day(i)] = 38449;
  assert.equal(typicalPrice(days, now), 38449);
  assert.equal(typicalPrice(Object.fromEntries(Object.entries(days).slice(0, 6)), now), 0);
  assert.equal(typicalPrice(undefined, now), 0);
});
test('typicalPrice: a one-day glitch does not move it, old days fall out of the window', () => {
  const now = Date.parse('2026-11-10T12:00:00Z'); const day = (n) => new Date(now - n * 864e5).toISOString().slice(0, 10);
  const days = {}; for (let i = 0; i < 20; i++) days[day(i)] = 40000;
  days[day(3)] = 24000;                                    // glitch day
  for (let i = 40; i < 100; i++) days[day(i)] = 55000;     // what it cost two months ago
  assert.equal(typicalPrice(days, now), 40000);
});
test('regression: a shop that is often unreachable must not make its normal price look like a deal (XG27ACDMS 61,335 vs 125,999)', () => {
  // the cheapest shop has listed it at 61,335 for a month; the usual price is that, not the dearer shop the scan saw last
  const now = Date.parse('2026-11-10T12:00:00Z'); const days = {};
  for (let i = 0; i < 29; i++) days[new Date(now - i * 864e5).toISOString().slice(0, 10)] = 61335;
  const usual = typicalPrice(days, now);
  assert.equal(usual, 61335);
  assert.equal(61335 <= usual * 0.65, false);   // no "51% below usual" ping when that shop comes back
});

test('keepListings: an item can name its real source (Amazon price read from Amazon itself is not a "BuyHatke" price)', () => {
  const src = { name: 'BuyHatke', kind: 'buyhatke' };
  const [a, b] = keepListings(src, [
    { title: 'Alienware AW2726DM QD-OLED Monitor', price: 39799, url: 'https://www.amazon.in/dp/B0GYG3VLMR', store: 'Amazon', sourceName: 'Amazon (direct)' },
    { title: 'Alienware AW2726DM QD-OLED Monitor', price: 38449, url: 'https://www.flipkart.com/x/p/itm1?pid=MON1', store: 'Flipkart' },
  ], ctx);
  assert.equal(a.source, 'Amazon (direct)'); assert.equal(a.retailer, 'amazon');
  assert.equal(b.source, 'BuyHatke · Flipkart'); assert.equal(b.retailer, 'flipkart');
});

test('lowListings: an OLED monitor under the minimum price is kept for an "unconfirmed" ping, junk is not', async () => {
  const { lowListings } = await import('../rules.js');
  const src = { name: 'Flipkart', kind: 'flipkart' };
  const items = [
    { title: 'Alienware AW2726DM 27 inch QD-OLED Gaming Monitor', price: 3999, url: 'https://shop.example/p/1' },      // the glitch
    { title: 'Alienware AW2726DM 27 inch QD-OLED Gaming Monitor', price: 39799, url: 'https://shop.example/p/2' },     // normal price: not this rule's job
    { title: 'Alienware AW2726DM QD-OLED Monitor + Logitech Webcam', price: 2995, url: 'https://shop.example/p/3' },   // bundle = add-on's price
    { title: 'Screen protector compatible with AW2726DM OLED monitor', price: 899, url: 'https://shop.example/p/4' },  // accessory
    { title: 'Samsung 27 inch OLED Gaming Monitor 240Hz', price: 4999, url: 'https://shop.example/p/5' },              // no model code
    { title: 'Alienware AW2726DM QD-OLED Monitor (Refurbished)', price: 5000, url: 'https://shop.example/p/6' },       // open-box/refurb
    { title: 'LYVON AW2726DM OLED Monitor', price: 4000, url: 'https://shop.example/p/7' },                            // banned brand
    { title: 'Alienware AW2726DM QD-OLED Monitor', price: 99, url: 'https://shop.example/p/8' },                       // under the floor
  ];
  const low = lowListings(src, items, ctx);
  assert.deepEqual(low.map((i) => i.url), ['https://shop.example/p/1']);
  assert.equal(low[0].key, 'AW2726DM');
});
