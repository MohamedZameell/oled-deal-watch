// Shop catalogue APIs: shapes as Elitehubs/TPS (Shopify) and PrimeABGB/PCStudio (WooCommerce) return them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShopify, parseWoo } from '../shops.js';

test('Shopify: cheapest in-stock variant, sold-out products skipped, struck-out price kept as MRP', () => {
  const { items, oos } = parseShopify({ products: [
    { title: 'MSI MAG 341CQP QD-OLED 34" UWQHD', handle: 'msi-mag341cqp', variants: [{ price: '77159.00', available: true, compare_at_price: '199999.00' }] },
    { title: 'Two variants', handle: 'two', variants: [{ price: '50000.00', available: false }, { price: '52000.00', available: true }, { price: '55000.00', available: true }] },
    { title: 'Sold out', handle: 'gone', variants: [{ price: '52498.00', available: false, compare_at_price: '128847.00' }] },
  ] }, 'https://shop.example');
  assert.equal(oos, 1);
  assert.deepEqual(items[0], { title: 'MSI MAG 341CQP QD-OLED 34" UWQHD', price: 77159, mrp: 199999, url: 'https://shop.example/products/msi-mag341cqp', apiChecked: true });
  assert.equal(items[1].price, 52000);
  assert.equal(items.length, 2);
});
test('WooCommerce: out of stock and "call for price" (0) skipped, HTML entities decoded', () => {
  const p = (name, price, extra = {}) => ({ name, permalink: 'https://shop.example/' + price, is_in_stock: true, is_purchasable: true,
    prices: { price: String(price), regular_price: '119999', currency_minor_unit: 0 }, ...extra });
  const { items, oos } = parseWoo([p('BenQ MOBIUZ EX271UZ 27&#8243; 4K OLED &amp; HDR', 87516), p('Sold out', 54590, { is_in_stock: false }), p('Call for price', 0)]);
  assert.equal(oos, 2); assert.equal(items.length, 1);
  assert.equal(items[0].title, 'BenQ MOBIUZ EX271UZ 27" 4K OLED & HDR');
  assert.equal(items[0].price, 87516); assert.equal(items[0].mrp, 119999); assert.equal(items[0].apiChecked, true);
});
test('WooCommerce: prices in minor units (paise) are converted', () => {
  const { items } = parseWoo([{ name: 'X OLED Monitor', permalink: 'u', is_in_stock: true, is_purchasable: true, prices: { price: '4650000', regular_price: '4650000', currency_minor_unit: 2 } }]);
  assert.equal(items[0].price, 46500); assert.equal(items[0].mrp, 0);
});
test('bad or empty answers give no items instead of throwing', () => {
  assert.deepEqual(parseShopify(null, 'https://x').items, []); assert.deepEqual(parseWoo({ message: 'error' }).items, []);
});

import { parseFlipkart } from '../shops.js';
test('Flipkart search HTML: one item per card with price, MRP, clean product link; ad tiles and sold-out cards skipped', () => {
  const card = (pid, inner) => `<div data-id="${pid}" style="width:25%"><div>${inner}</div></div>`;
  const html = '<html><body>' + [
    card('MONHQ99FGWPGW9V8', '<a class="x" title="Samsung Odyssey G5 QD-OLED 68.58 cm (27 inch) Quad HD OLED Panel Monitor (LS27FG502SWXXL)" href="/samsung-odyssey-g5-qd-oled/p/itm123abc?pid=MONHQ99FGWPGW9V8&amp;lid=L1">Samsung Odyssey G5 QD-OLED...</a><svg><path d="M5 6.4"/></svg><div>4.8</div><div>(13)</div><div>₹41,700</div><div>₹<!-- -->49,500</div><div>15% off</div>'),
    card('MONHHAATHYP8EVTS', '<a title="Samsung Odyssey OLED G9 124.3 cm (49 inch) Curved DQHD OLED Panel Gaming Monitor" href="/samsung-odyssey-oled-g9/p/itm9?pid=MONHHAATHYP8EVTS">x</a><div>₹1,65,920</div>'),
    card('MONADTILE0000001', '<img alt="Frontech Ultima Series DUAL PORTS HDMI"/><svg></svg>'),
    card('MONSOLDOUT000001', '<a title="LG UltraGear 68.58 cm (27 inch) Quad HD OLED Panel Gaming Monitor" href="/lg-ultragear/p/itm7?pid=MONSOLDOUT000001">x</a><div>₹79,999</div><div>Currently unavailable</div>'),
  ].join('') + '</body></html>';
  const items = parseFlipkart(html);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { title: 'Samsung Odyssey G5 QD-OLED 68.58 cm (27 inch) Quad HD OLED Panel Monitor (LS27FG502SWXXL)', price: 41700, mrp: 49500,
    url: 'https://www.flipkart.com/samsung-odyssey-g5-qd-oled/p/itm123abc?pid=MONHQ99FGWPGW9V8', pid: 'MONHQ99FGWPGW9V8' });
  assert.equal(items[1].price, 165920); assert.equal(items[1].mrp, 0);
  assert.deepEqual(parseFlipkart('<html>blocked</html>'), []);
});
