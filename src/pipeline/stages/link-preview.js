import fetch from 'node-fetch';

export const name = 'link-preview';

const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 5_000;
const CONCURRENCY = 5;
const UA = 'nbc-import-linkpreview/1.0 (+https://nbc.almostready.dev)';
const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^localhost$/i,
  /^0\./,
];

function isPrivateOrLocalhost(hostname) {
  return PRIVATE_RANGES.some(re => re.test(hostname));
}

function isSafePublicUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (isPrivateOrLocalhost(u.hostname)) return false;
    return true;
  } catch { return false; }
}

async function fetchHtml(url) {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!isSafePublicUrl(current)) return '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      });
    } catch { return ''; } finally { clearTimeout(timer); }
    if ([301,302,303,307,308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return '';
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) return '';
    const ct = res.headers.get('content-type') || '';
    if (!ct.toLowerCase().includes('html')) return '';
    const buf = [];
    let total = 0;
    for await (const chunk of res.body) {
      buf.push(chunk);
      total += chunk.length;
      if (total >= MAX_HTML_BYTES) break;
    }
    return Buffer.concat(buf).toString('utf-8', 0, MAX_HTML_BYTES);
  }
  return '';
}

function parseOg(html) {
  const meta = (names) => {
    for (const name of names) {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
      const m = re.exec(html) || new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i').exec(html);
      if (m) return m[1].trim();
    }
    return '';
  };
  let title = meta(['og:title','twitter:title']);
  if (!title) { const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html); if (m) title = m[1].trim(); }
  const description = meta(['og:description','twitter:description','description']);
  let imageUrl = meta(['og:image','og:image:url','twitter:image']);
  return { title, description, imageUrl };
}

async function resolveOne(url) {
  if (!isSafePublicUrl(url)) return null;
  try {
    const html = await fetchHtml(url);
    if (!html) return null;
    const og = parseOg(html);
    if (!og.title && !og.description && !og.imageUrl) return null;
    return og;
  } catch { return null; }
}

async function pooled(tasks, concurrency) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

export async function run(board, logger, _cfg = {}) {
  const linkEls = [];
  for (const col of board.columns) {
    for (const card of col.cards) {
      for (const el of (card.elements || [])) {
        if (el.type === 'link' && el.url) linkEls.push(el);
      }
    }
  }

  const unique = [...new Map(linkEls.map(el => [el.url, el])).entries()];
  const needsFetch = unique.filter(([, el]) => !el.title || !el.description || !el.imageUrl);
  if (!needsFetch.length) return { warnings: [], info: null };

  const resolved = await pooled(needsFetch.map(([url]) => () => resolveOne(url)), CONCURRENCY);
  const cache = new Map();
  needsFetch.forEach(([url], i) => { if (resolved[i]) cache.set(url, resolved[i]); });

  let enriched = 0;
  for (const el of linkEls) {
    const preview = cache.get(el.url);
    if (!preview) continue;
    let changed = false;
    if (!el.title && preview.title) { el.title = preview.title; changed = true; }
    if (!el.description && preview.description) { el.description = preview.description; changed = true; }
    if (!el.imageUrl && preview.imageUrl) { el.imageUrl = preview.imageUrl; changed = true; }
    if (changed) enriched++;
  }

  if (logger && enriched) logger.info(`[link-preview] ${enriched}/${linkEls.length} Links angereichert`);
  return { warnings: [], info: enriched ? `[link-preview] ${enriched} Links angereichert` : null };
}
