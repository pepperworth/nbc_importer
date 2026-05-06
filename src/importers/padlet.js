import fetch from 'node-fetch';
import { BaseImporter, ImporterError } from './base.js';

const PADLET_HOSTS = new Set(['padlet.com', 'padlet.org']);
const PADLET_SUFFIXES = ['.padlet.com', '.padlet.org'];
const PADLET_UPLOAD_HOSTS = new Set(['padlet-uploads.storage.googleapis.com']);
const PADLET_UPLOAD_SUFFIXES = ['.padletusercontent.com'];
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_UA = 'Mozilla/5.0 (compatible; NBC-Importer/0.1; +https://nbc.almostready.dev)';

function isPadletHost(host) {
  return PADLET_HOSTS.has(host) || PADLET_SUFFIXES.some(s => host.endsWith(s));
}

function looksLikePadletUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (!isPadletHost(host)) return false;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length > 0 && !['api','_','assets','static'].includes(parts[0]);
  } catch { return false; }
}

async function getWithRedirects(url, label) {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const host = new URL(current).hostname.toLowerCase();
    if (!isPadletHost(host)) throw new ImporterError(`${label}-URL abgelehnt: nicht erlaubter Host ${host}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': FETCH_UA } });
    } finally { clearTimeout(timer); }
    if ([301,302,303,307,308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new ImporterError(`${label}-Redirect ohne Location-Header.`);
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new ImporterError(`${label}: zu viele Weiterleitungen.`);
}

async function getJson(url, label) {
  const res = await getWithRedirects(url, label);
  if (res.status !== 200) throw new ImporterError(`${label} antworten mit HTTP ${res.status}.`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new ImporterError(`${label} haben kein gültiges JSON.`); }
  if (typeof data !== 'object' || data === null) throw new ImporterError(`${label}: kein JSON-Objekt.`);
  return data;
}

function extractPreloadLinks(html, baseUrl) {
  const result = { startingStateUrl: '', wishesUrl: '' };
  const re = /<link\s+([^>]+)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = {};
    const attrRe = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    let am;
    while ((am = attrRe.exec(m[1])) !== null) {
      attrs[am[1].toLowerCase()] = am[2] ?? am[3] ?? am[4] ?? '';
    }
    if (!attrs.href) continue;
    const abs = new URL(attrs.href, baseUrl).toString();
    if (attrs.id === 'starting-state-preload') result.startingStateUrl = abs;
    else if (attrs.id === 'wishes-preload') result.wishesUrl = abs;
  }
  return result;
}

function jsonApiData(payload) {
  if (payload && typeof payload === 'object' && Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function nextWishesUrl(payload, currentUrl) {
  const meta = payload?.meta;
  if (!meta) return '';
  const next = meta.next;
  if (!next) return '';
  if (typeof next === 'string' && (next.startsWith('http://') || next.startsWith('https://'))) return next;
  const u = new URL(currentUrl);
  const params = new URLSearchParams(u.search);
  params.set('page_start', String(next));
  u.search = params.toString();
  return u.toString();
}

async function getPaginatedWishes(firstUrl) {
  const all = [];
  let url = firstUrl;
  const seen = new Set();
  let lastPayload = {};
  while (url && !seen.has(url)) {
    seen.add(url);
    const payload = await getJson(url, 'Padlet-Posts');
    lastPayload = payload;
    all.push(...jsonApiData(payload));
    url = nextWishesUrl(payload, url) || '';
  }
  return { ...lastPayload, data: all };
}

function boardLayout(wall) {
  return ['timeline','timeline_v2'].includes(wall?.viz) ? 'list' : 'columns';
}

function number(v, def) { const n = parseFloat(v); return isNaN(n) ? def : n; }

function wishSortKey(attrs) {
  return [-(number(attrs.sort_index, 0) || 0), number(attrs.created_at, 0) || 0, String(attrs.id || attrs.hashid || '')].toString();
}

function timelineSortKey(attrs) {
  return [number(attrs.sort_index, 0) || 0, number(attrs.created_at, 0) || 0, String(attrs.id || attrs.hashid || '')].toString();
}

function wishTitle(attrs, index) {
  for (const c of [attrs.headline, attrs.subject]) {
    const v = String(c || '').replace(/\n/g, ' ').trim();
    if (v && v.toLowerCase() !== 'empty') return v.replace(/\s+/g, ' ').slice(0, 160);
  }
  const excerpt = plainText(String(attrs.body || '')).slice(0, 80);
  if (excerpt && excerpt.toLowerCase() !== 'empty') return excerpt;
  return '';
}

function plainText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function normalizeRichText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/<[a-z][\s\S]*>/i.test(raw)) return raw; // trust padlet HTML
  return `<p>${escapeHtml(raw).replace(/\n/g, '<br>')}</p>`;
}

function isPadletUploadUrl(value) {
  if (!value) return false;
  try {
    const u = new URL(value);
    if (!['http:','https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    return PADLET_UPLOAD_HOSTS.has(host) || PADLET_UPLOAD_SUFFIXES.some(s => host.endsWith(s));
  } catch { return false; }
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return ['http:','https:'].includes(u.protocol) && !!u.hostname;
  } catch { return false; }
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.split('/').pop() || '').trim();
    return name || 'padlet-anhang';
  } catch { return 'padlet-anhang'; }
}

function ensureExt(filename, url) {
  if (filename.includes('.')) return filename;
  try {
    const ext = new URL(url).pathname.split('.').pop();
    if (ext && ext.length <= 5) return `${filename}.${ext}`;
  } catch {}
  return filename;
}

function bestPadletFileUrl(attachment, attachmentLink) {
  if (attachmentLink && typeof attachmentLink === 'object') {
    for (const key of ['url','id','canonical_url']) {
      const u = attachmentLink[key];
      if (u && isPadletUploadUrl(String(u))) return String(u);
    }
  }
  if (isPadletUploadUrl(attachment)) return attachment;
  return '';
}

function mapAttachment(attrs, fallbackTitle) {
  const attachmentLink = attrs.attachment_link;
  const attachment = String(attrs.attachment || '').trim();
  const caption = String(attrs.attachment_caption || '').trim();
  const fileUrl = bestPadletFileUrl(attachment, attachmentLink);

  if (fileUrl) {
    const link = attachmentLink && typeof attachmentLink === 'object' ? attachmentLink : {};
    let filename = String(link.title || '').trim();
    if (!filename) filename = filenameFromUrl(fileUrl);
    else filename = ensureExt(filename, fileUrl);
    const mimetype = String(link.content_type || '').trim() || 'application/octet-stream';
    return [{
      type: 'file', sourceUrl: fileUrl, filename, mimetype,
      sizeBytes: link.size != null ? parseInt(link.size, 10) : null,
      caption,
    }];
  }

  if (attachmentLink && typeof attachmentLink === 'object') {
    const url = String(attachmentLink.canonical_url || attachmentLink.url || attachmentLink.id || attachment).trim();
    if (!isHttpUrl(url)) return [];
    const title = String(attachmentLink.title || caption || fallbackTitle || url).trim();
    const description = String(attachmentLink.description || '').trim();
    let imageUrl = '';
    const preview = attachmentLink.preview_image;
    if (preview && typeof preview === 'object') imageUrl = String(preview.url || '').trim();
    imageUrl = (isHttpUrl(imageUrl) ? imageUrl : '') || String(attachmentLink.display_url || '').trim();
    return [{ type: 'link', url, title, description, imageUrl: isHttpUrl(imageUrl) ? imageUrl : '' }];
  }

  if (isHttpUrl(attachment)) return [{ type: 'link', url: attachment, title: caption || fallbackTitle || attachment, description: '', imageUrl: '' }];
  return [];
}

function mapWish(attrs, index, includeTitle = true) {
  const title = wishTitle(attrs, index);
  const elements = [];
  const body = normalizeRichText(attrs.body);
  if (body) elements.push({ type: 'richText', text: body, inputFormat: 'richTextCk5Simple' });
  elements.push(...mapAttachment(attrs, title));
  return { title: includeTitle ? title : '', elements };
}

function mapTableColumns(wishes) {
  const sorted = [...wishes].sort((a, b) => wishSortKey(a.attributes || {}) > wishSortKey(b.attributes || {}) ? 1 : -1);
  if (!sorted.length) return [{ title: 'Tabelle', cards: [] }];
  return sorted.map((w, i) => ({
    title: wishTitle(w.attributes || {}, i),
    cards: [mapWish(w.attributes || {}, i, false)],
  }));
}

function mapTimelineColumns(wishes) {
  const sorted = [...wishes].sort((a, b) => timelineSortKey(a.attributes || {}) > timelineSortKey(b.attributes || {}) ? 1 : -1);
  if (!sorted.length) return [{ title: 'Timeline', cards: [] }];
  return sorted.map((w, i) => ({
    title: `Zeitpunkt ${i + 1}`,
    cards: [mapWish(w.attributes || {}, i)],
  }));
}

function mapColumns(wall, sections, wishes) {
  if (wall?.viz === 'table') return mapTableColumns(wishes);
  if (['timeline','timeline_v2'].includes(wall?.viz)) return mapTimelineColumns(wishes);

  const sectionAttrs = sections.map(s => s.attributes).filter(Boolean);
  sectionAttrs.sort((a, b) => (number(a.sort_index, 0) - number(b.sort_index, 0)) || String(a.title||'').localeCompare(String(b.title||'')));

  const sectionIndex = {};
  const columns = [];
  for (const sec of sectionAttrs) {
    const idx = columns.length;
    columns.push({ title: String(sec.title || `Section ${idx + 1}`).trim(), cards: [] });
    if (sec.id != null) sectionIndex[String(sec.id)] = idx;
    if (sec.hashid) sectionIndex[String(sec.hashid)] = idx;
  }
  if (!columns.length) columns.push({ title: 'Posts', cards: [] });

  const unassigned = [];
  const sorted = [...wishes].sort((a, b) => wishSortKey(a.attributes || {}) > wishSortKey(b.attributes || {}) ? 1 : -1);
  for (let i = 0; i < sorted.length; i++) {
    const attrs = sorted[i].attributes || {};
    const card = mapWish(attrs, i);
    const secKey = String(attrs.wall_section_id ?? attrs.wall_section_hashid ?? '');
    const ci = sectionIndex[secKey];
    if (ci == null) {
      if (columns.length === 1 && !sectionAttrs.length) columns[0].cards.push(card);
      else unassigned.push(card);
    } else {
      columns[ci].cards.push(card);
    }
  }

  if (unassigned.length) {
    const defaultId = String(wall?.wish_arrangement?.default_section_id || '');
    const di = sectionIndex[defaultId];
    if (di != null) columns[di].cards.push(...unassigned);
    else columns.push({ title: 'Ohne Section', cards: unassigned });
  }

  return columns;
}

function normalizePayload(payload) {
  if (typeof payload !== 'object' || payload === null) throw new ImporterError('Padlet-Payload ungültig.');
  const state = payload.starting_state || payload.startingState || (payload.wall ? payload : null);
  if (!state) throw new ImporterError('Padlet-Payload enthält keinen Starting-State.');
  const wall = state.wall;
  if (!wall || typeof wall !== 'object') throw new ImporterError('Padlet-Payload enthält keine Board-Metadaten.');

  const wishesRaw = payload.wishes || payload.wishes_payload || {};
  const wishes = jsonApiData(wishesRaw).filter(item => item && typeof item.attributes === 'object');

  const sectionsRaw = payload.sections || payload.sections_payload || {};
  const sections = jsonApiData(sectionsRaw).filter(item => item && typeof item.attributes === 'object');

  const sourceUrl = String(
    payload.source_url || payload.sourceUrl || wall?.links?.show || wall?.links?.app || `padlet://${wall.hashid || wall.id || 'board'}`
  ).trim();
  const title = String(wall.title || wall.headline || 'Padlet').trim();
  const columns = mapColumns(wall, sections, wishes);
  const description = normalizeRichText(wall.description);

  if (description) {
    if (!columns.length) columns.push({ title: 'Posts', cards: [] });
    columns[0].cards.unshift({
      title: 'Beschreibung',
      elements: [{ type: 'richText', text: description, inputFormat: 'richTextCk5Simple' }],
      role: 'importer_description',
    });
  }

  return {
    sourceUrl,
    sourceType: 'padlet',
    title: title || 'Padlet',
    layout: boardLayout(wall),
    columns: columns.length ? columns : [{ title: 'Posts', cards: [] }],
    subtitle: description || null,
  };
}

export class PadletImporter extends BaseImporter {
  get name() { return 'padlet'; }

  matches(url) { return looksLikePadletUrl(url); }

  async fetchPull(url, logger) {
    if (!this.matches(url)) throw new ImporterError('Keine Padlet-URL gefunden.');
    logger.step(`Lade Padlet-Board: ${url}`);

    const pageRes = await getWithRedirects(url, 'Padlet');
    if (pageRes.status === 404) throw new ImporterError('Padlet nicht gefunden.');
    if ([401, 403].includes(pageRes.status)) throw new ImporterError('Padlet ist nicht öffentlich zugänglich.');
    if (pageRes.status >= 400) throw new ImporterError(`Padlet antwortet mit HTTP ${pageRes.status}.`);

    const html = await pageRes.text();
    const finalUrl = String(pageRes.url || url);
    const preload = extractPreloadLinks(html, finalUrl);

    if (!preload.startingStateUrl || !preload.wishesUrl) {
      throw new ImporterError('Padlet-Daten konnten nicht gefunden werden. Das Board ist eventuell privat oder Padlet hat das Seitenformat geändert.');
    }

    const state = await getJson(preload.startingStateUrl, 'Padlet-Metadaten');
    const wall = state?.wall;
    if (!wall || typeof wall !== 'object') throw new ImporterError('Padlet-Metadaten enthalten kein Board.');

    const wishes = await getPaginatedWishes(preload.wishesUrl);
    let sections = { data: [] };
    if (wall.id != null) {
      const sectUrl = new URL(`/api/10/wall_sections?wall_id=${encodeURIComponent(wall.id)}`, finalUrl).toString();
      try { sections = await getJson(sectUrl, 'Padlet-Sections'); } catch { sections = { data: [] }; }
    }

    logger.info('Board wird geparst...');
    const board = normalizePayload({ source_url: url, starting_state: state, wishes, sections });
    const totalCards = board.columns.reduce((s, c) => s + c.cards.length, 0);
    logger.ok(`✓ "${board.title}" — ${board.columns.length} Spalten, ${totalCards} Karten`);
    return board;
  }
}
