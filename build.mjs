#!/usr/bin/env node
// Persian news aggregator — fetches RSS, stores an archive, renders a static site.
// One command: node build.mjs
// Output goes to ./site — plain HTML, uploadable to any host (Iranian shared hosting included).

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import dns from 'node:dns';

// Some Iranian hosts (isna.ir, irna.ir) advertise IPv6 that never connects from here.
dns.setDefaultResultOrder('ipv4first');

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, 'site');
const ARCHIVE = path.join(ROOT, 'archive.json');

const cfg = JSON.parse(await readFile(path.join(ROOT, 'feeds.json'), 'utf8'));
const BASE = process.env.BASE ?? cfg.base ?? '';
const AI_KEY = process.env.GEMINI_API_KEY || '';
const AI_MODEL = process.env.GEMINI_MODEL || cfg.aiModel || 'gemini-2.5-flash';
const REWRITE_PER_RUN = Number(process.env.REWRITE_PER_RUN || cfg.rewritePerRun || 12);
const PER_PAGE = 40;
const UA = 'Mozilla/5.0 (compatible; NewsReader/1.0)';
// Article pages are pickier than feeds: yjc.ir and khabaronline reject anything that
// doesn't look like a browser. isna.ir and irna.ir sit behind an interstitial for
// non-Iranian IPs, so their full text only becomes reachable once hosting is in Iran.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ---------------------------------------------------------------- fetching */

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(feed.url, { headers: { 'User-Agent': UA }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------------- parsing */

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '‌', laquo: '«', raquo: '»' };

function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => entities[n.toLowerCase()] ?? m);
}

function stripTags(s = '') {
  return decode(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

function attr(xml, name, key) {
  const m = xml.match(new RegExp(`<${name}[^>]*\\s${key}=["']([^"']+)["']`, 'i'));
  return m ? decode(m[1]) : '';
}

function findImage(itemXml, description) {
  return (
    attr(itemXml, 'enclosure', 'url') ||
    attr(itemXml, 'media:content', 'url') ||
    attr(itemXml, 'media:thumbnail', 'url') ||
    (decode(description).match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? '')
  );
}

function parseItems(xml, feed) {
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = stripTags(tag(b, 'title'));
    let link = stripTags(tag(b, 'link')) || attr(b, 'link', 'href');
    if (!title || !link) continue;
    const descRaw = tag(b, 'description') || tag(b, 'content:encoded') || tag(b, 'summary');
    const published = decode(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || '');
    const when = published ? new Date(published) : new Date();
    out.push({
      id: createHash('sha1').update(link).digest('hex').slice(0, 12),
      title,
      link: link.trim(),
      excerpt: stripTags(descRaw).slice(0, 400),
      image: findImage(b, descRaw),
      date: isNaN(when) ? new Date().toISOString() : when.toISOString(),
      source: feed.name,
      sourceId: feed.id,
      category: feed.category,
    });
  }
  return out;
}

/* --------------------------------------------- full article + AI rewrite */

// The feeds only carry a summary. Pull the real body text off the source page.
async function fetchArticle(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'fa,en;q=0.8' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<figure[\s\S]*?<\/figure>/gi, ' ');
    const paras = [...clean.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)]
      .map((m) => stripTags(m[1]))
      .filter((t) => t.length > 60 && !/^(کد خبر|انتهای پیام|منبع|copyright)/i.test(t));
    const ogImage = clean.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || '';
    return { text: paras.join('\n\n').slice(0, 6000), image: decode(ogImage) };
  } finally {
    clearTimeout(timer);
  }
}

const PROMPT = `تو یک خبرنگار فارسی‌زبان هستی. متن خبر زیر را بازنویسی کن.

قواعد:
- کاملاً با کلمات و ساختار جمله‌های خودت بنویس، نه کپی متن اصلی.
- هیچ واقعیت، عدد، نام، تاریخ یا نقل‌قولی را تغییر نده و چیزی از خودت اضافه نکن.
- لحن خبری و بی‌طرف باشد. بدون نظر شخصی و بدون تبلیغ.
- سه تا پنج پاراگراف کوتاه.
- یک تیتر تازه بنویس که معنی همان خبر را برساند ولی عین تیتر اصلی نباشد.
- نام خبرگزاری یا وب‌سایت را داخل متن نیاور.
- خروجی فقط JSON باشد: {"title": "...", "body": "پاراگراف‌ها با \\n\\n جدا شوند"}

تیتر اصلی: `;

async function rewriteWithAI(title, text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${AI_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${PROMPT}${title}\n\nمتن خبر:\n${text}` }] }],
      generationConfig: { temperature: 0.5, responseMimeType: 'application/json', maxOutputTokens: 2048 },
    }),
  });
  if (res.status === 429) throw Object.assign(new Error('quota'), { quota: true });
  if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const out = JSON.parse(raw);
  if (!out.title || !out.body || out.body.length < 200) throw new Error('AI returned too little');
  return { title: String(out.title).trim(), body: String(out.body).trim() };
}

/* ---------------------------------------------------------------- dedupe */

// Iranian outlets republish each other's wires, so the same story lands 4-5 times.
// Key on the first words of the normalised title.
function dedupeKey(title) {
  return title
    .replace(/[‌‏‎]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/[یي]/g, 'ی')
    .replace(/[كک]/g, 'ک')
    .trim()
    .split(' ')
    .slice(0, 7)
    .join(' ');
}

/* ---------------------------------------------------------------- helpers */

const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

function faDate(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-u-ca-persian', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Tehran' })
    .formatToParts(d)
    .reduce((a, p) => ((a[p.type] = p.value), a), {});
  const time = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tehran' }).format(d);
  const month = JALALI_MONTHS[(+parts.month || 1) - 1];
  return `${toFa(parts.day)} ${month} ${toFa(String(parts.year).replace(/\D/g, ''))} · ${time}`;
}

function toFa(n) {
  return String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);
}

function esc(s = '') {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relTime(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'همین الان';
  if (mins < 60) return `${toFa(mins)} دقیقه پیش`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${toFa(hrs)} ساعت پیش`;
  return `${toFa(Math.round(hrs / 24))} روز پیش`;
}

/* ------------------------------------------------------------------- CSS */

const CSS = `
:root{
  --bg:#FFFFFF; --panel:#F6F7F9; --ink:#14181F; --soft:#606A7B; --line:#E4E7EC;
  --brand:#0E7C66; --brand-ink:#0A6553; --brand-soft:#E6F3F0; --hot:#C2410C;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#0E1116; --panel:#161B22; --ink:#E8ECF2; --soft:#96A1B2; --line:#232A34;
    --brand:#3FBFA0; --brand-ink:#5FD3B6; --brand-soft:#122A25; --hot:#F08A5D;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Vazirmatn,"IRANSans",Tahoma,"Segoe UI",sans-serif;font-size:16px;line-height:1.8;direction:rtl}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
.wrap{max-width:1080px;margin:0 auto;padding-inline:16px}

header.site{border-bottom:1px solid var(--line);background:var(--bg);position:sticky;top:0;z-index:5}
header.site .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:10px 22px;padding-block:14px}
.logo{font-size:20px;font-weight:700;letter-spacing:-.02em}
.logo b{color:var(--brand)}
.tagline{color:var(--soft);font-size:13px;margin-inline-start:-14px}
nav.cats{display:flex;flex-wrap:wrap;gap:16px;margin-inline-start:auto}
nav.cats a{font-size:14.5px;color:var(--soft);padding-bottom:2px;border-bottom:2px solid transparent}
nav.cats a:hover,nav.cats a.on{color:var(--ink);border-bottom-color:var(--brand)}
.updated{font-size:12px;color:var(--soft);width:100%;border-top:1px dashed var(--line);padding-top:8px}
.updated .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--brand);margin-inline-end:6px}

main{padding-block:24px 48px}
.lead{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:26px;padding-bottom:26px;border-bottom:1px solid var(--line);margin-bottom:26px}
.lead .big h2{font-size:clamp(1.35rem,3.4vw,2rem);line-height:1.45;margin:10px 0 8px;letter-spacing:-.015em}
.lead .big p{color:var(--soft);margin:0;font-size:15.5px}
.lead .big .thumb{aspect-ratio:16/9;overflow:hidden;border-radius:8px;background:var(--panel)}
.lead .big .thumb img{width:100%;height:100%;object-fit:cover}
.side{display:flex;flex-direction:column;gap:0}
.side a.row{display:grid;grid-template-columns:1fr auto;gap:6px 12px;padding:13px 0;border-bottom:1px solid var(--line)}
.side a.row:first-child{border-top:1px solid var(--line)}
.side a.row h3{margin:0;font-size:15px;font-weight:500;line-height:1.65}
.side a.row .meta{grid-column:1/-1}

.meta{font-size:12px;color:var(--soft);display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.src{background:var(--brand-soft);color:var(--brand-ink);padding:2px 8px;border-radius:3px;font-size:11.5px}
.cat{color:var(--hot);font-size:11.5px}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(255px,1fr));gap:22px}
.card{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg);display:flex;flex-direction:column}
.card .thumb{aspect-ratio:16/9;background:var(--panel);overflow:hidden}
.card .thumb img{width:100%;height:100%;object-fit:cover}
.card .body{padding:14px 15px 15px;display:flex;flex-direction:column;gap:8px;flex:1}
.card h3{margin:0;font-size:15.5px;font-weight:600;line-height:1.65;letter-spacing:-.01em}
.card p{margin:0;color:var(--soft);font-size:14px;flex:1}
.card .meta{margin-top:auto}

.section-head{display:flex;align-items:baseline;gap:12px;margin:34px 0 16px}
.section-head h2{font-size:1.15rem;margin:0}
.section-head .rule{flex:1;height:1px;background:var(--line)}
.section-head a{font-size:13px;color:var(--brand-ink)}

.pager{display:flex;gap:10px;justify-content:center;margin-top:36px}
.pager a,.pager span{padding:8px 15px;border:1px solid var(--line);border-radius:5px;font-size:14px;color:var(--soft)}
.pager a:hover{border-color:var(--brand);color:var(--ink)}
.pager .now{background:var(--brand-soft);color:var(--brand-ink);border-color:var(--brand-soft)}

article.single{max-width:720px;margin:0 auto}
article.single h1{font-size:clamp(1.5rem,4vw,2.1rem);line-height:1.5;margin:14px 0 12px;letter-spacing:-.015em}
article.single .hero{aspect-ratio:16/9;border-radius:8px;overflow:hidden;background:var(--panel);margin-block:18px}
article.single .hero img{width:100%;height:100%;object-fit:cover}
article.single .text{font-size:17px}
.sourcebox{margin-top:30px;padding:16px 18px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:14.5px}
.sourcebox a{color:var(--brand-ink);text-decoration:underline}
.more{margin-top:44px}

footer.site{border-top:1px solid var(--line);margin-top:50px;padding-block:24px 36px;color:var(--soft);font-size:13px}
footer.site .wrap{display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:space-between}

@media (max-width:760px){
  .lead{grid-template-columns:1fr;gap:20px}
  .tagline{display:none}
  nav.cats{margin-inline-start:0;width:100%;overflow-x:auto;white-space:nowrap}
}
`;

/* --------------------------------------------------------------- templates */

function layout({ title, description, body, canonical, cats, active }) {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<link rel="alternate" type="application/rss+xml" title="${esc(cfg.siteName)}" href="${BASE}/rss.xml">
<style>${CSS}</style>
</head>
<body>
<header class="site"><div class="wrap">
  <a class="logo" href="${BASE}/">${esc(cfg.siteName)}<b>.</b></a>
  <span class="tagline">${esc(cfg.siteTagline)}</span>
  <nav class="cats">
    <a href="${BASE}/" class="${active === 'home' ? 'on' : ''}">خانه</a>
    ${cats.map((c) => `<a href="${BASE}/c/${encodeURIComponent(c)}/" class="${active === c ? 'on' : ''}">${esc(c)}</a>`).join('\n    ')}
  </nav>
  <div class="updated"><span class="dot"></span>آخرین به‌روزرسانی: ${faDate(new Date().toISOString())}</div>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="site"><div class="wrap">
  <div>${esc(cfg.siteName)} — خبرها از خبرگزاری‌های رسمی جمع‌آوری می‌شود و منبع هر خبر ذکر شده است.</div>
  <div><a href="${BASE}/rss.xml">RSS</a> · <a href="${BASE}/sitemap.xml">نقشه سایت</a></div>
</div></footer>
</body>
</html>`;
}

function cardHtml(it) {
  return `<a class="card" href="${BASE}/n/${it.id}.html">
  ${it.image ? `<div class="thumb"><img src="${esc(it.image)}" alt="" loading="lazy"></div>` : ''}
  <div class="body">
    <h3>${esc(it.title)}</h3>
    <p>${esc(it.excerpt.slice(0, 120))}…</p>
    <div class="meta"><span class="src">${esc(it.source)}</span><span class="cat">${esc(it.category)}</span><span>${relTime(it.date)}</span></div>
  </div>
</a>`;
}

function rowHtml(it) {
  return `<a class="row" href="${BASE}/n/${it.id}.html">
  <h3>${esc(it.title)}</h3>
  <div class="meta"><span class="src">${esc(it.source)}</span><span>${relTime(it.date)}</span></div>
</a>`;
}

function listPage({ items, cats, active, title, description, page = 1, pages = 1, base = BASE + '/' }) {
  const [first, ...rest] = items;
  const side = rest.slice(0, 6);
  const grid = rest.slice(6);
  const body = `
${
  first
    ? `<section class="lead">
  <a class="big" href="${BASE}/n/${first.id}.html">
    ${first.image ? `<div class="thumb"><img src="${esc(first.image)}" alt=""></div>` : ''}
    <h2>${esc(first.title)}</h2>
    <p>${esc(first.excerpt.slice(0, 190))}…</p>
    <div class="meta"><span class="src">${esc(first.source)}</span><span class="cat">${esc(first.category)}</span><span>${relTime(first.date)}</span></div>
  </a>
  <div class="side">${side.map(rowHtml).join('\n')}</div>
</section>`
    : '<p>هنوز خبری دریافت نشده است.</p>'
}
<div class="section-head"><h2>${esc(title)}</h2><span class="rule"></span></div>
<div class="grid">${grid.map(cardHtml).join('\n')}</div>
${
  pages > 1
    ? `<div class="pager">
  ${page > 1 ? `<a href="${base}${page - 1 === 1 ? '' : `page/${page - 1}/`}">قبلی</a>` : ''}
  <span class="now">صفحه ${toFa(page)} از ${toFa(pages)}</span>
  ${page < pages ? `<a href="${base}page/${page + 1}/">بعدی</a>` : ''}
</div>`
    : ''
}`;
  return layout({ title: `${title} — ${cfg.siteName}`, description, body, cats, active });
}

function articlePage(it, related, cats) {
  const body = `<article class="single">
  <div class="meta"><span class="src">${esc(it.source)}</span><span class="cat">${esc(it.category)}</span><span>${faDate(it.date)}</span></div>
  <h1>${esc(it.title)}</h1>
  ${it.image ? `<div class="hero"><img src="${esc(it.image)}" alt=""></div>` : ''}
  <div class="text">${(it.body || it.excerpt)
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para.trim())}</p>`)
    .join('\n')}</div>
  <div class="sourcebox">
    ${it.body ? 'این خبر بر پایهٔ گزارش' : 'خلاصهٔ این خبر از'} <b>${esc(it.source)}</b> ${it.body ? 'تهیه شده است.' : 'منتشر شده است.'}
    <a href="${esc(it.link)}" target="_blank" rel="noopener nofollow">مشاهدهٔ خبر در ${esc(it.source)}</a>
  </div>
  <div class="more">
    <div class="section-head"><h2>خبرهای مرتبط</h2><span class="rule"></span></div>
    <div class="grid">${related.map(cardHtml).join('\n')}</div>
  </div>
</article>`;
  return layout({
    title: `${it.title} — ${cfg.siteName}`,
    description: it.excerpt.slice(0, 155),
    body,
    canonical: `${cfg.siteUrl}/n/${it.id}.html`,
    cats,
    active: it.category,
  });
}

/* ------------------------------------------------------------------- build */

async function write(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

console.log('گرفتن فیدها…');
const results = await Promise.allSettled(cfg.feeds.map(async (f) => parseItems(await fetchFeed(f), f)));

let fresh = [];
results.forEach((r, i) => {
  const f = cfg.feeds[i];
  if (r.status === 'fulfilled') {
    fresh.push(...r.value);
    console.log(`  ✓ ${f.name}: ${r.value.length}`);
  } else {
    console.log(`  ✗ ${f.name}: ${r.reason?.message || r.reason}`);
  }
});

const archive = existsSync(ARCHIVE) ? JSON.parse(await readFile(ARCHIVE, 'utf8')) : [];
const byId = new Map(archive.map((it) => [it.id, it]));
const seenTitles = new Set(archive.map((it) => dedupeKey(it.title)));
let added = 0;
for (const it of fresh) {
  const k = dedupeKey(it.title);
  if (byId.has(it.id) || seenTitles.has(k)) continue;
  byId.set(it.id, it);
  seenTitles.add(k);
  added++;
}

// Rewrite the newest stories that have not been rewritten yet.
// Only new ones cost anything, so a run is cheap once the archive is warm.
if (AI_KEY) {
  const queue = [...byId.values()]
    .filter((it) => !it.body && !it.aiFailed)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, REWRITE_PER_RUN);
  console.log(`بازنویسی ${queue.length} خبر…`);
  for (const it of queue) {
    try {
      const art = await fetchArticle(it.link);
      const source = art.text.length > 400 ? art.text : it.excerpt;
      if (source.length < 180) throw new Error('متن کافی نبود');
      const out = await rewriteWithAI(it.title, source);
      it.originalTitle = it.title;
      it.title = out.title;
      it.body = out.body;
      it.excerpt = out.body.replace(/\s+/g, ' ').slice(0, 300);
      if (!it.image && art.image) it.image = art.image;
      console.log(`  ✓ ${out.title.slice(0, 48)}`);
      await new Promise((r) => setTimeout(r, 4000)); // stay inside the free tier's rate limit
    } catch (e) {
      if (e.quota) {
        console.log('  … سهمیه رایگان امروز تمام شد، بقیه در اجرای بعدی');
        break;
      }
      it.aiFailed = (it.aiFailed || 0) + 1;
      console.log(`  ✗ ${e.message}`);
    }
  }
} else {
  console.log('بدون کلید هوش مصنوعی — فقط خلاصهٔ خبرگزاری نمایش داده می‌شود.');
}

const all = [...byId.values()].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, cfg.maxArchive);
await writeFile(ARCHIVE, JSON.stringify(all, null, 1), 'utf8');
console.log(`${added} خبر تازه · ${all.length} خبر در آرشیو`);

if (existsSync(OUT)) await rm(OUT, { recursive: true });
const cats = [...new Set(all.map((i) => i.category))];

// homepage + pagination
const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
for (let p = 1; p <= Math.min(pages, 12); p++) {
  const slice = all.slice((p - 1) * PER_PAGE, p * PER_PAGE);
  const html = listPage({
    items: slice,
    cats,
    active: 'home',
    title: p === 1 ? 'تازه‌ترین خبرها' : `تازه‌ترین خبرها — صفحه ${toFa(p)}`,
    description: cfg.siteTagline,
    page: p,
    pages: Math.min(pages, 12),
  });
  await write(p === 1 ? path.join(OUT, 'index.html') : path.join(OUT, 'page', String(p), 'index.html'), html);
}

// category pages
for (const c of cats) {
  const items = all.filter((i) => i.category === c).slice(0, PER_PAGE * 3);
  await write(path.join(OUT, 'c', c, 'index.html'), listPage({ items, cats, active: c, title: c, description: `اخبار ${c}` }));
}

// article pages
for (const it of all) {
  const related = all.filter((x) => x.category === it.category && x.id !== it.id).slice(0, 6);
  await write(path.join(OUT, 'n', `${it.id}.html`), articlePage(it, related, cats));
}

// rss + sitemap + robots
const rssItems = all
  .slice(0, 50)
  .map(
    (it) => `  <item>
    <title>${esc(it.title)}</title>
    <link>${cfg.siteUrl}/n/${it.id}.html</link>
    <guid>${cfg.siteUrl}/n/${it.id}.html</guid>
    <pubDate>${new Date(it.date).toUTCString()}</pubDate>
    <description>${esc(it.excerpt.slice(0, 300))}</description>
  </item>`
  )
  .join('\n');
await write(
  path.join(OUT, 'rss.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${esc(cfg.siteName)}</title>
  <link>${cfg.siteUrl}</link>
  <description>${esc(cfg.siteTagline)}</description>
  <language>fa-IR</language>
${rssItems}
</channel></rss>`
);

await write(
  path.join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${cfg.siteUrl}/</loc></url>
${cats.map((c) => `  <url><loc>${cfg.siteUrl}/c/${encodeURIComponent(c)}/</loc></url>`).join('\n')}
${all.slice(0, 1000).map((it) => `  <url><loc>${cfg.siteUrl}/n/${it.id}.html</loc><lastmod>${it.date.slice(0, 10)}</lastmod></url>`).join('\n')}
</urlset>`
);

await write(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${cfg.siteUrl}/sitemap.xml\n`);

console.log(`ساخته شد: ${path.join(OUT, 'index.html')}`);
