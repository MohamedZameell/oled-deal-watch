import test from 'node:test';
import assert from 'node:assert/strict';
import { exGst, fakeDiscount } from '../buyhatke.js';

test('regression: an Amazon Business price without 18% GST is not a drop (AW2726DM 39,799 -> 33,728)', () => {
  assert.equal(exGst(33728, 39799), true);
  assert.equal(exGst(33728, undefined, 0, 39799), true);
  assert.equal(exGst(35000, 39799), false);   // a real 12% drop
});
const day = (n, now) => new Date(now - n * 864e5).toISOString().slice(0, 10);
test('fakeDiscount: price raised in the last 3 weeks, then "dropped" back to normal', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const series = [[day(90, now), day(15, now), 40000], [day(15, now), day(1, now), 48000], [day(1, now), day(0, now), 40500]];
  assert.deepEqual(fakeDiscount(series, 40500, now), { normal: 40000, hikedTo: 48000 });
  assert.equal(fakeDiscount(series, 33000, now), null);                                  // well under the old normal: a real drop
  assert.equal(fakeDiscount([[day(10, now), day(0, now), 40000]], 36000, now), null);   // too little history to judge
});

import { parseAzSearch } from '../buyhatke.js';
test('Amazon search results: asin, price and clean product link; rows without a price or asin skipped', () => {
  const items = parseAzSearch({ results: [
    { asin: 'B0G12R9WG3', title: 'Samsung 27" Odyssey QD-OLED G5  Gaming Monitor (Smartchoice)', price: { amount: 39999, currency: 'INR', list_price: 49500 }, is_sponsored: false },
    { asin: 'B0NOPRICE1', title: 'Currently unavailable OLED monitor', price: null },
    { asin: 'bad', title: 'x', price: { amount: 5 } },
  ] });
  assert.deepEqual(items, [{ title: 'Samsung 27" Odyssey QD-OLED G5 Gaming Monitor (Smartchoice)', price: 39999, mrp: 49500, url: 'https://www.amazon.in/dp/B0G12R9WG3' }]);
  assert.deepEqual(parseAzSearch({ error: 'amazon blocked the request' }), []);
});

import { azVerdict } from '../buyhatke.js';
test('azVerdict: Amazon\'s own answer decides whether a search hit may ping', () => {
  assert.equal(azVerdict({ price: 24000, inStock: true }, 24000), 'verified');
  assert.equal(azVerdict({ price: 24100, inStock: true }, 24000), 'verified');        // within 1%
  assert.equal(azVerdict({ price: 46899, inStock: true }, 38999), 'price changed');   // search/non-India price vs the real one (G6, 2026-11-07)
  assert.equal(azVerdict({ price: 0, inStock: false }, 24000), 'out of stock');
  assert.equal(azVerdict({ price: 24000, inStock: false }, 24000), 'out of stock');
  assert.equal(azVerdict({ price: 95990, inStock: null }, 95990), 'stock unknown');   // third-party offers only
});

import { parseAzOffers, cheapestNew, sideOffers } from '../buyhatke.js';
test('Amazon offers: third-party-only listings resolve to the cheapest New offer (B0CZSGWLD5)', () => {
  const offers = parseAzOffers({ offers: [
    { condition: 'New', price: { amount: 110779 }, seller: { name: 'STS Shop' } },
    { condition: 'New', price: { amount: 95990 }, seller: { name: 'ShopForBest' } },
    { condition: 'Used - Like New', price: { amount: 70000 }, seller: { name: 'Second Life' } },
    { condition: 'New', price: { amount: 2995 }, seller: { name: 'Webcam add-on' } },   // not a monitor price
  ] });
  assert.equal(offers.length, 3);
  assert.deepEqual(cheapestNew(offers), { cond: 'New', price: 95990, seller: 'ShopForBest' });
  assert.equal(cheapestNew([{ cond: 'Used - Good', price: 50000, seller: 'x' }]), false);   // nothing new to buy
  assert.equal(cheapestNew(null), null);                                                    // no answer: unknown
  assert.deepEqual(parseAzOffers({ error: 'blocked' }), []);
});
test('Amazon offers: used/renewed and cheaper-seller offers are listed, the buy-box offer itself is not', () => {
  const offers = [{ cond: 'New', price: 46899, seller: 'Clicktech' }, { cond: 'New', price: 44000, seller: 'Other' }, { cond: 'Used - Very Good', price: 39000, seller: 'Warehouse' }, { cond: 'New', price: 49000, seller: 'Dearer' }];
  assert.deepEqual(sideOffers(offers, 46899).map((o) => o.seller), ['Other', 'Warehouse']);
  assert.deepEqual(sideOffers(null, 46899), []);
});

import { parseBhPage, bhPageFresh } from '../buyhatke.js';
// shape copied from the live G5 page (2026-11-16): product block ends with inStock + pid, history timeline further down
const BH_HTML = 'x{prod:"Samsung 27 Odyssey G5",link:"http://www.amazon.in/gp/product/B0G12R9WG3",cur_price:36499,site_pos:63,inStock:1,pid:"B0G12R9WG3",internalPid:1},'
  + '{prod:"other",link:"x",price:39999,position:63,PID:"B0OTHER",oos:0},predictedData:{history:[{from:"2026-10-28 00:34:43",to:"2026-11-11 00:16:10",price:39999},{from:"2026-11-12 09:18:11",to:"2026-11-14 01:30:07",price:36499}],scores:[1]}';
test('parseBhPage: price, stock and history date of the product itself', () => {
  assert.deepEqual(parseBhPage(BH_HTML, 'B0G12R9WG3'), { price: 36499, inStock: true, asOf: '2026-11-14' });
  assert.equal(parseBhPage(BH_HTML, 'B0NOTTHERE'), null);          // some other product's page / half-rendered page
  assert.equal(parseBhPage('', 'B0G12R9WG3'), null);
  assert.equal(parseBhPage(BH_HTML.replace('cur_price:36499', 'cur_price:2995'), 'B0G12R9WG3'), null);   // add-on price, not a monitor
  assert.equal(parseBhPage(BH_HTML.replace('inStock:1', 'inStock:0'), 'B0G12R9WG3').inStock, false);
});
test('bhPageFresh: the page is a cache, a history that stopped days ago is not trusted', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.equal(bhPageFresh({ price: 1, asOf: '2026-11-14' }, now), true);
  assert.equal(bhPageFresh({ price: 1, asOf: '2026-11-08' }, now), false);   // 11-08: the July-stale era
  assert.equal(bhPageFresh({ price: 1, asOf: null }, now), false);
  assert.equal(bhPageFresh(null, now), false);
});
