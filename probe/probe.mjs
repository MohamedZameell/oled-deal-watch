// one-off: which community deal sources answer GitHub runner IPs?
import { chromium } from 'playwright';
const urls = [
  'https://www.reddit.com/r/IndianGaming/search.json?q=oled&restrict_sr=1&sort=new&limit=25',
  'https://www.reddit.com/r/IndianGaming/search.rss?q=oled&restrict_sr=1&sort=new',
  'https://www.reddit.com/r/IndianGaming/new/.rss',
  'https://old.reddit.com/r/IndianGaming/search?q=oled&restrict_sr=on&sort=new',
  'https://www.reddit.com/r/IndianGaming/search/?q=oled&sort=new',
  'https://api.pullpush.io/reddit/search/submission/?q=oled&subreddit=IndianGaming&size=10',
  'https://www.desidime.com/search?q=oled+monitor',
  'https://www.desidime.com/new',
  'https://www.desidime.com/deals.atom',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
for (const u of urls) {
  try { const r = await fetch(u, { headers: { 'user-agent': UA } }); const t = await r.text(); console.log('FETCH', r.status, u, '|', t.slice(0, 160).replace(/\s+/g, ' ')); }
  catch (e) { console.log('FETCH ERR', u, e.message); }
}
const b = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined });
const ctx = await b.newContext({ userAgent: UA, locale: 'en-IN' });
const p = await ctx.newPage();
for (const u of urls) {
  try { const r = await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }); await p.waitForTimeout(3000);
    const t = await p.evaluate(() => document.body ? document.body.innerText : document.documentElement.textContent);
    console.log('CHROME', r && r.status(), u, '|', (await p.title()).slice(0, 60), '|', t.slice(0, 200).replace(/\s+/g, ' ')); }
  catch (e) { console.log('CHROME ERR', u, e.message.slice(0, 80)); }
}
await b.close();
