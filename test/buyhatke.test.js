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
