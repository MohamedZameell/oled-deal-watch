const API = 'https://search-new.bitbns.com/buyhatke';
const H = { 'content-type': 'application/json', origin: 'https://buyhatke.com', referer: 'https://buyhatke.com/' };
const post = async (param) => { const r = await fetch(`${API}/thunder/priceData`, { method: 'POST', headers: H, body: JSON.stringify({ param }), signal: AbortSignal.timeout(30000) }); const t = await r.text(); let d = {}; try { d = JSON.parse(t).data || {}; } catch {} return { s: r.status, d, t }; };
// 1) well-known non-OLED Amazon ASINs (echo, fire stick, kindle, etc.)
const asins = ['B09B8V1LZ3', 'B08XVYZ1Y5', 'B0BDYBRNGX', 'B0CHX1W1XY', 'B09V3HN1KC', 'B07WHQWXZ7', 'B0B5V47VK4', 'B08CFSZLQ4'];
let r = await post(asins.map((a) => [63, a]));
console.log('amazon misc ASINs: http', r.s, 'answered', Object.keys(r.d).length, 'of', asins.length, r.t.slice(0, 100));
// 2) random products from several BuyHatke categories, then priceData for each
for (const ln of [1398, 1, 2, 3, 5, 10, 20, 100, 500]) {
  try {
    const c = await fetch(`${API}/getCategoryProducts?ln=${ln}&sort=aiscore-desc&limit=15&page=1`, { headers: H, signal: AbortSignal.timeout(30000) });
    const j = JSON.parse(await c.text()); const items = j.data?.categories?.[0]?.items || []; if (!items.length) console.log('raw', ln, JSON.stringify(j).slice(0, 150));
    if (!items.length) { console.log('cat', ln, 'http', c.status, 'items 0'); continue; }
    const pos = {}; items.forEach((x) => { pos[x.pos] = (pos[x.pos] || 0) + 1; });
    const p = await post(items.map((x) => [x.pos, x.pid]));
    console.log('cat', ln, 'items', items.length, 'sample', String(items[0].prod).slice(0, 40), 'pos', JSON.stringify(pos), '-> priceData answered', Object.keys(p.d).length);
  } catch (e) { console.log('cat', ln, 'err', String(e.message).slice(0, 60)); }
}
