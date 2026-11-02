// Free AI judge for the scanner: a small open model (Qwen2.5 3B by default) run by Ollama ON THE GITHUB RUNNER
// itself. No account, key, quota or server: the runner is a free 4-core/16 GB Linux box. (GitHub Models, the
// hosted option, was retired on 30 Jul 2026.) Ollama is installed and the model pulled lazily, only on a run that
// has something new to judge; every answer is cached in state/ai.json, so most runs never start it.
// Every function degrades to "no opinion" (empty result) when the model is unavailable or too slow, so the
// scanner's rule-based filters always keep working on their own.
// Locally: start `ollama serve` yourself (or set AI_URL to any OpenAI-compatible server) to get the same behaviour.
import fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';

const DAY = 24 * 3600e3;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function createAI({ cfg, stateDir, dry }) {
  // qwen3:4b won a 3-model test on the runner (2026-11-02): best at product kind, condition, verdicts and posts.
  // No small model reliably knows a monitor's panel type from its name, so the scanner never drops on "panel".
  const conf = { model: 'qwen3:4b', batch: 15, maxNewTitles: 25, budgetMs: 6 * 60e3, ...(cfg.ai || {}) };
  if (process.env.AI_MODEL) conf.model = process.env.AI_MODEL;
  const base = process.env.AI_URL || 'http://127.0.0.1:11434';
  const file = `${stateDir}/ai.json`;
  let st; try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { st = {}; }
  st.titles ||= {}; st.posts ||= {};
  const today = new Date().toISOString().slice(0, 10);
  if (st.day !== today) { st.day = today; st.calls = 0; }
  let disabled = conf.enabled === false || process.env.AI_OFF === '1';
  let ready = null; let deadline = 0;

  const up = () => fetch(`${base}/api/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  // start the model server once per run, the first time something actually needs judging
  async function ensure() {
    ready ||= (async () => {
      const t0 = Date.now();
      if (!(await up())) {
        if (!process.env.CI) { console.log('AI off (no Ollama at', base + '; run `ollama serve` to enable)'); return false; }
        try {
          execSync('command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh', { stdio: 'ignore', timeout: 180000, shell: '/bin/bash' });
          if (!(await up())) spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref();
          for (let i = 0; i < 30 && !(await up()); i++) await sleep(1000);
        } catch (e) { console.log('AI install failed', String(e.message).slice(0, 100)); return false; }
        if (!(await up())) { console.log('AI server did not start'); return false; }
      }
      const r = await fetch(`${base}/api/pull`, { method: 'POST', body: JSON.stringify({ model: conf.model, stream: false }), signal: AbortSignal.timeout(300000) }).catch((e) => ({ ok: false, statusText: e.message }));
      if (!r.ok) { console.log('AI model pull failed', r.status || '', r.statusText); return false; }
      console.log(`AI ready: ${conf.model} in ${Math.round((Date.now() - t0) / 1000)} s`);
      deadline = Date.now() + conf.budgetMs;   // CPU inference is slow: cap the total time the AI may add to a run
      return true;
    })();
    return ready;
  }

  // JSON-schema output: Ollama constrains generation to exactly this shape, so a small model can't wander off
  // into endless whitespace (loose "json" mode once ran a verdict to the token cap: 300 s and no answer)
  const S = (props) => ({ type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: Object.keys(props), properties: props } } } });
  const str = { type: 'string' }; const strN = { type: ['string', 'null'] }; const en = (...v) => ({ type: 'string', enum: v });
  const SCHEMA = {
    classify: S({ i: { type: 'integer' }, w: str, kind: en('monitor', 'portable', 'accessory', 'tv', 'laptop', 'other'), panel: en('oled', 'lcd', 'unknown'),
      model: strN, cond: en('new', 'renewed', 'open-box', 'used', 'unknown'), size: { type: ['number', 'null'] } }),
    judge: S({ i: { type: 'integer' }, verdict: en('buy', 'good', 'meh', 'check'), note: str }),
    posts: S({ i: { type: 'integer' }, deal: { type: 'boolean' }, model: strN, price: { type: ['number', 'null'] }, note: str }),
  };
  async function ask(system, user, kind, maxTokens) {
    if (disabled || !(await ensure())) { disabled = true; return null; }
    if (Date.now() > deadline) { console.log('AI time budget used up for this run'); disabled = true; return null; }
    st.calls++;
    try {
      const r = await fetch(`${base}/api/chat`, { method: 'POST', signal: AbortSignal.timeout(Math.max(10000, deadline - Date.now())),
        body: JSON.stringify({ model: conf.model, stream: false, format: SCHEMA[kind], ...(/qwen3|r1|think/i.test(conf.model) ? { think: false } : {}), options: { temperature: 0, num_ctx: 8192, num_predict: maxTokens },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
      if (!r.ok) { console.log('AI HTTP', r.status, (await r.text()).slice(0, 200)); return null; }
      const j = await r.json();
      return JSON.parse(j.message?.content || '{}');
    } catch (e) { console.log('AI error', String(e.message).slice(0, 100)); return null; }
  }
  const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);

  // ---- 1. what is each listing, really? ----
  // One verdict per distinct title, cached for 60 days: OLED or not, desktop monitor or not, model code, condition.
  const CLASSIFY = `You label product listings from Indian online shops. For EVERY numbered listing output one object:
- "w": the first word of that listing, copied exactly.
- "kind": what the product itself is:
    "monitor"   = a normal computer monitor you put on a desk (any size, gaming or office, curved or flat, 24" to 57"),
    "portable"  = a small portable / USB-C / travel monitor (usually 13-18 inch),
    "accessory" = an arm, mount, stand, cable, adapter, screen guard, or anything "compatible with" a monitor,
    "tv", "laptop" or "other".
- "panel": "oled" if the screen is OLED, QD-OLED or WOLED (also when the title only gives a model you know is OLED),
    "lcd" if it is IPS, VA, TN, Mini-LED or plain LED, "unknown" if you are not sure.
- "model": the manufacturer's model code from the title, e.g. "AW2726DM", "34GS95QE", "PG27AQDM", "LS27FG502SW", "MAG 271QPX"; null if none.
- "cond": "new", "renewed", "open-box", "used" or "unknown". Renewed/refurbished/repackaged = "renewed".
- "size": screen size in inches (number) or null.
Example: 0. "LG 27GS95QE 27 inch OLED Gaming Monitor" -> {"i":0,"w":"LG","kind":"monitor","panel":"oled","model":"27GS95QE","cond":"new","size":27}
Example: 1. "Monitor Arm for Samsung Odyssey OLED G8" -> {"i":1,"w":"Monitor","kind":"accessory","panel":"unknown","model":null,"cond":"new","size":null}
Answer only JSON: {"items":[ one object per listing, with its number as "i" ]}`;
  // models answer in slightly different shapes: take the first array found, or a lone object
  const listOf = (res) => (Array.isArray(res) ? res : Object.values(res || {}).find(Array.isArray)
    || (res && typeof res === 'object' && ('verdict' in res || 'kind' in res || 'deal' in res) ? [res] : []));
  const alnum = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  async function classify(titles) {
    const out = new Map(); const todo = [];
    for (const t of new Set(titles)) { const c = st.titles[norm(t)]; if (c) { c.seen = today; out.set(t, c); } else todo.push(t); }
    // CPU inference: at most maxNewTitles new titles per run; the rest get their verdict on the next runs
    const now = todo.slice(0, conf.maxNewTitles);
    for (let i = 0; i < now.length; i += conf.batch) {
      const chunk = now.slice(i, i + conf.batch);
      const res = await ask(CLASSIFY, chunk.map((t, k) => `${k}. ${t.slice(0, 220)}`).join('\n'), 'classify', 90 * chunk.length + 50);
      if (!res) break;
      let rejected = 0;
      listOf(res).forEach((it, k) => {
        const t = chunk[Number.isInteger(it.i) ? it.i : k]; if (t === undefined) return;
        // the answer must name this listing's first word: a shifted or mixed-up answer would label the wrong product
        // (a LYVON 43" "OLED panel" once inherited the AW2726DM model code of a neighbouring line)
        if (!it.w || alnum(t.split(/\s+/)[0]) !== alnum(it.w)) { rejected++; return; }
        // a model code counts only if it is really in the title: small models invent plausible ones
        const m = alnum(it.model);
        const model = m.length >= 4 && alnum(t).includes(m) ? it.model : null;
        const c = { kind: it.kind || 'unknown', panel: it.panel || 'unknown', model, cond: it.cond || 'unknown', size: +it.size || null, seen: today };
        st.titles[norm(t)] = c; out.set(t, c);
      });
      if (rejected) console.log('AI classify: rejected', rejected, 'answers that did not match their listing');
    }
    console.log('AI classify', titles.length, 'titles,', todo.length, 'new,', out.size, 'known');
    return out;
  }

  // ---- 2. is this alert actually worth acting on? ----
  const JUDGE = `You are a sharp Indian PC-hardware deal hunter. The buyer wants an OLED desktop monitor at an unusually low price
(normal street prices are roughly ₹38-45k for 27" 1440p QD-OLED; they will only buy a genuinely great deal).
For each alert you get the listing, its price, what other shops charge, this model's tracked price history and flags.
The percentages are already computed for you (pctBelowTypical, pctBelowLowestTracked, pctBelowCheapestOtherShop): trust them.
Judge it:
  "buy"   = pctBelowLowestTracked >= 8, or pctBelowTypical >= 25, and the condition is new and nothing looks off;
  "good"  = pctBelowLowestTracked >= 3, or pctBelowTypical >= 12;
  "meh"   = smaller savings than that;
  "check" = something looks off: condition is not new, pageCheck is not "verified", or pctBelowCheapestOtherShop >= 45 (too good to be true).
Write a note of at most 18 words giving the most useful fact. Use ONLY facts present in that alert's data: compare its price
with otherShops, lowestTracked and typicalPrice in rupees. Never invent sellers, warranty, condition or stock information.
Answer only JSON: {"items":[{"i":<index>,"verdict":"buy|good|meh|check","note":"..."}]}`;
  async function judge(alerts) {
    if (!alerts.length) return new Map();
    const res = await ask(JUDGE, JSON.stringify(alerts.map((a, i) => ({ i, ...a }))), 'judge', 130 * alerts.length + 60);
    const out = new Map();
    listOf(res).forEach((it, k) => {
      const i = Number.isInteger(it.i) ? it.i : k; const v = String(it.verdict || '').toLowerCase();
      if (alerts[i] && ['buy', 'good', 'meh', 'check'].includes(v)) out.set(i, { verdict: v, note: String(it.note || '').slice(0, 160) });
    });
    console.log('AI judge', alerts.length, 'alerts ->', out.size, 'verdicts', out.size ? '' : 'raw: ' + JSON.stringify(res).slice(0, 300));
    return out;
  }

  // ---- 3. is a community post an actual OLED-monitor deal? ----
  const POSTS = `You filter Indian deal-channel and Reddit posts for someone hunting an OLED desktop monitor deal.
For each post: "deal": true only if it offers or reports a specific OLED desktop monitor (24"+) at a price/discount right now
(not questions, reviews, build threads, TVs, laptops, phones, portable monitors). "model": model code or null.
"price": the offer price in rupees as a number or null. "note": at most 12 words, e.g. "AW2726DM ₹34,999 Amazon with HDFC card".
Answer only JSON: {"items":[{"i":<index>,"deal":true|false,"model":...,"price":...,"note":"..."}]}`;
  async function posts(list) {
    const out = new Map(); const todo = [];
    for (const p of list) { const c = st.posts[p.id]; if (c) out.set(p.id, c); else todo.push(p); }
    for (let i = 0; i < todo.length; i += 20) {
      const chunk = todo.slice(i, i + 20);
      const res = await ask(POSTS, chunk.map((p, k) => `${k}. [${p.where}] ${p.title} ${p.body ? '| ' + p.body.slice(0, 500) : ''}`).join('\n'), 'posts', 70 * chunk.length + 40);
      if (!res) break;
      listOf(res).forEach((it, k) => {
        const p = chunk[Number.isInteger(it.i) ? it.i : k]; if (!p || typeof it.deal !== 'boolean') return;
        const c = { deal: it.deal, model: it.model || null, price: +it.price || 0, note: String(it.note || '').slice(0, 120), t: today };
        st.posts[p.id] = c; out.set(p.id, c);
      });
    }
    if (list.length) console.log('AI posts', list.length, '->', [...out.values()].filter((c) => c.deal).length, 'deals');
    return out;
  }

  function save() {
    if (dry) return;
    const cutoff = new Date(Date.now() - 60 * DAY).toISOString().slice(0, 10);
    for (const [k, v] of Object.entries(st.titles)) if ((v.seen || '') < cutoff) delete st.titles[k];
    for (const [k, v] of Object.entries(st.posts)) if ((v.t || '') < cutoff) delete st.posts[k];
    fs.writeFileSync(file, JSON.stringify(st, null, 1));
  }
  return { classify, judge, posts, save, get on() { return !disabled; }, get calls() { return st.calls; } };
}
