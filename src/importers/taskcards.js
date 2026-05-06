import fetch from 'node-fetch';
import { BaseImporter, ImporterError } from './base.js';

const TASKCARDS_GRAPHQL_URL = 'https://www.taskcards.de/graphql';
const TASKCARDS_BASE_URL = 'https://www.taskcards.de';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const LAYOUT_BY_TYPE = { 0: 'kanban', 1: 'timeline', 2: 'chalkboard', 3: 'worldmap', 4: 'story' };
const SINGLE_COL_TITLE = { chalkboard: 'Tafel', worldmap: 'Weltkarte', story: 'Blog', cards: 'Karten' };

const BOARD_QUERY = `query ($id: String!) {
  board(id: $id) {
    id name description type
    lists { id name position color }
    cards {
      id title description link videoConference color created modified
      attachments { id filename length mimetype downloadLink previewLink }
      chalkBoardPosition { height width left top }
      kanbanPosition { listId position }
      timeLinePosition { position }
      storyPosition { position }
      worldMapPosition { lat lng }
    }
  }
}`;

const SAFE_TAGS = new Set(['a','b','blockquote','br','code','div','em','h1','h2','h3','h4','h5','h6',
  'i','li','ol','p','pre','s','span','strong','sub','sup','u','ul']);
const VOID_TAGS = new Set(['br']);
const DROP_TAGS = new Set(['script','style','iframe','object','embed']);
const SAFE_ATTRS = { a: new Set(['href','title']), br: new Set() };
const REQUIRED_ATTRS = { a: new Set(['href']) };
const SAFE_URL_SCHEMES = new Set(['http','https','mailto']);

function sanitizeRichText(raw) {
  if (!raw) return '';
  raw = String(raw).trim();
  if (!raw) return '';
  if (!/<[a-z][\s\S]*>/i.test(raw)) {
    return `<p>${escapeHtml(raw).replace(/\n/g, '<br>')}</p>`;
  }
  const result = [];
  let dropDepth = 0;
  const suppressedOpens = [];

  const parser = new (class {
    feed(html) {
      const tagRe = /<(!--[\s\S]*?--|\/?\s*[a-zA-Z][^>]*)>|([^<]+)/g;
      let m;
      while ((m = tagRe.exec(html)) !== null) {
        const tag = m[1];
        if (!tag) { if (!dropDepth) result.push(escapeHtml(m[2])); continue; }
        if (tag.startsWith('!--')) continue;
        if (tag.startsWith('/')) {
          const name = tag.slice(1).trim().toLowerCase();
          if (DROP_TAGS.has(name) && dropDepth) { dropDepth--; continue; }
          if (dropDepth || !SAFE_TAGS.has(name)) continue;
          if (VOID_TAGS.has(name)) continue;
          const idx = suppressedOpens.lastIndexOf(name);
          if (idx !== -1) { suppressedOpens.splice(idx, 1); continue; }
          result.push(`</${name}>`);
        } else {
          const spaceIdx = tag.search(/[\s/]/);
          const name = (spaceIdx === -1 ? tag : tag.slice(0, spaceIdx)).toLowerCase();
          if (DROP_TAGS.has(name)) { dropDepth++; continue; }
          if (dropDepth || !SAFE_TAGS.has(name)) continue;
          const attrs = SAFE_ATTRS[name] || new Set();
          const rendered = [];
          const attrRe = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
          let am;
          while ((am = attrRe.exec(tag)) !== null) {
            const aname = am[1].toLowerCase();
            if (!attrs.has(aname)) continue;
            let aval = am[2] ?? am[3] ?? am[4] ?? '';
            if (aname === 'href') {
              aval = sanitizeUrl(aval);
              if (!aval) continue;
            }
            rendered.push([aname, aval]);
          }
          const required = REQUIRED_ATTRS[name];
          if (required) {
            const present = new Set(rendered.map(([k]) => k));
            if (![...required].every(r => present.has(r))) {
              if (!VOID_TAGS.has(name)) suppressedOpens.push(name);
              continue;
            }
          }
          const attrStr = rendered.map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
          result.push(VOID_TAGS.has(name) ? `<${name}${attrStr}>` : `<${name}${attrStr}>`);
        }
      }
    }
  })();
  parser.feed(raw);
  return result.join('').trim();
}

function sanitizeUrl(value) {
  try {
    const u = new URL(value.trim());
    if (!SAFE_URL_SCHEMES.has(u.protocol.replace(':', ''))) return '';
    if (['http','https'].includes(u.protocol.replace(':', '')) && !u.hostname) return '';
    return value.trim();
  } catch { return ''; }
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function textExcerpt(value, length = 80) {
  const raw = String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return raw.slice(0, length);
}

function parseBoardLink(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = (parsed.hostname || '').toLowerCase();
  if (host !== 'taskcards.de' && !host.endsWith('.taskcards.de')) return null;
  const candidates = [parsed.pathname, parsed.hash];
  for (const c of candidates) {
    const m = (c || '').match(/\/board\/([^/?#]+)/);
    if (m && UUID_RE.test(m[1])) {
      const token = new URLSearchParams(parsed.search).get('token') || '';
      return { boardId: m[1], token };
    }
  }
  return null;
}

function extractBoardPayload(payload) {
  if (typeof payload !== 'object' || payload === null) throw new ImporterError('Taskcards-Payload ungültig.');
  const sourceUrl = String(payload.source_url || payload.sourceUrl || '').trim();
  const data = payload.data;
  if (typeof data === 'object' && data !== null && data.board) {
    if (!data.board) throw new ImporterError('Taskcards-Board nicht gefunden.');
    return { sourceUrl, board: data.board };
  }
  if (looksLikeTaskcardsBoard(payload)) return { sourceUrl, board: payload };
  const board = payload.board;
  if (board && looksLikeTaskcardsBoard(board)) return { sourceUrl, board };
  throw new ImporterError('Taskcards-Payload enthält keine Boarddaten.');
}

function looksLikeTaskcardsBoard(v) {
  if (!v || typeof v !== 'object') return false;
  return 'name' in v || 'lists' in v || 'cards' in v;
}

function inferLayout(board) {
  const cards = asArray(board.cards);
  if (board.lists || cards.some(c => typeof c.kanbanPosition === 'object' && c.kanbanPosition)) return 'kanban';
  if (cards.some(c => typeof c.timeLinePosition === 'object' && c.timeLinePosition)) return 'timeline';
  if (cards.some(c => typeof c.chalkBoardPosition === 'object' && c.chalkBoardPosition)) return 'chalkboard';
  if (cards.some(c => typeof c.worldMapPosition === 'object' && c.worldMapPosition)) return 'worldmap';
  if (cards.some(c => typeof c.storyPosition === 'object' && c.storyPosition)) return 'story';
  return 'cards';
}

function boardLayout(board) {
  const t = board.type;
  if (t == null) return inferLayout(board);
  const n = parseInt(t, 10);
  if (LAYOUT_BY_TYPE[n]) return LAYOUT_BY_TYPE[n];
  throw new ImporterError(`Unbekanntes Taskcards-Layout: ${t}`);
}

function mapColumns(board, cards, layout) {
  if (layout === 'kanban') return mapKanbanColumns(board, cards);
  if (layout === 'timeline') return mapTimelineColumns(cards);
  return mapSingleColumn(cards, layout);
}

function mapKanbanColumns(board, cards) {
  const lists = asArray(board.lists)
    .filter(l => typeof l === 'object')
    .sort((a, b) => (toNum(a.position, 0) - toNum(b.position, 0)) || String(a.name||'').localeCompare(String(b.name||'')));
  const listIndexById = {};
  lists.forEach((l, i) => { if (l.id) listIndexById[String(l.id)] = i; });
  const columns = lists.map((l, i) => ({ title: String(l.name || `Spalte ${i+1}`).trim(), cards: [] }));
  if (columns.length) {
    const unassigned = [];
    const sorted = [...cards].sort((a, b) => cardSortKey(a, 'kanban') > cardSortKey(b, 'kanban') ? 1 : -1);
    sorted.forEach((apiCard, i) => {
      const mapped = mapCard(apiCard, i);
      const listId = String((apiCard.kanbanPosition || {}).listId || '');
      const ci = listIndexById[listId];
      if (ci == null) unassigned.push(mapped);
      else columns[ci].cards.push(mapped);
    });
    if (unassigned.length) columns.push({ title: 'Ohne Spalte', cards: unassigned });
    return columns;
  }
  return mapSingleColumn(cards, 'cards');
}

function mapTimelineColumns(cards) {
  const sorted = [...cards].sort((a, b) => cardSortKey(a, 'timeline') > cardSortKey(b, 'timeline') ? 1 : -1);
  if (!sorted.length) return [{ title: 'Timeline', cards: [] }];
  return sorted.map((c, i) => ({ title: `Zeitpunkt ${i + 1}`, cards: [mapCard(c, i)] }));
}

function mapSingleColumn(cards, layout) {
  const title = SINGLE_COL_TITLE[layout] || 'Karten';
  const sorted = [...cards].sort((a, b) => cardSortKey(a, layout) > cardSortKey(b, layout) ? 1 : -1);
  return [{ title, cards: sorted.map((c, i) => mapCard(c, i)) }];
}

function mapCard(apiCard, index) {
  const title = cardTitle(apiCard, index);
  const elements = [];
  const coordsHtml = worldMapCoordsHtml(apiCard);
  if (coordsHtml) elements.push({ type: 'richText', text: coordsHtml, inputFormat: 'richTextCk5Simple' });
  if (hasVideoConference(apiCard)) elements.push({ type: 'videoConference', title: title || 'Videokonferenz' });
  const desc = sanitizeRichText(apiCard.description);
  if (desc) elements.push({ type: 'richText', text: desc, inputFormat: 'richTextCk5Simple' });
  const link = normalizeUrl(apiCard.link);
  if (link) elements.push({ type: 'link', url: link, title: title || link, description: '', imageUrl: '' });
  for (const att of asArray(apiCard.attachments)) {
    if (typeof att !== 'object') continue;
    const fe = mapAttachment(att);
    if (fe) elements.push(fe);
  }
  const raw = apiCard.color && typeof apiCard.color === 'string' && apiCard.color.trim() ? apiCard.color.trim() : null;
  return { title, elements, backgroundColorRaw: raw };
}

function mapAttachment(att) {
  const filename = String(att.filename || 'Anhang').trim() || 'Anhang';
  const sourceUrl = String(att.downloadLink || att.previewLink || '').trim();
  if (!sourceUrl) return { type: 'richText', text: `<p>Anhang ohne Download-Link: ${escapeHtml(filename)}</p>`, inputFormat: 'richTextCk5Simple' };
  return {
    type: 'file',
    sourceUrl,
    filename,
    mimetype: String(att.mimetype || 'application/octet-stream'),
    sizeBytes: att.length != null ? parseInt(att.length, 10) : null,
    caption: '',
  };
}

function cardTitle(apiCard, index) {
  const candidates = [apiCard.title, apiCard.link, firstAttachmentFilename(apiCard), textExcerpt(apiCard.description)];
  for (const c of candidates) {
    const v = String(c || '').replace(/\n/g, ' ').trim();
    if (v) return v.replace(/\s+/g, ' ').slice(0, 160);
  }
  return `Karte ${index + 1}`;
}

function firstAttachmentFilename(apiCard) {
  for (const a of asArray(apiCard.attachments)) {
    if (a && a.filename) return String(a.filename);
  }
  return '';
}

function cardSortKey(apiCard, layout) {
  const kanban = apiCard.kanbanPosition && typeof apiCard.kanbanPosition === 'object' ? apiCard.kanbanPosition : {};
  const timeline = apiCard.timeLinePosition && typeof apiCard.timeLinePosition === 'object' ? apiCard.timeLinePosition : {};
  const story = apiCard.storyPosition && typeof apiCard.storyPosition === 'object' ? apiCard.storyPosition : {};
  const chalk = apiCard.chalkBoardPosition && typeof apiCard.chalkBoardPosition === 'object' ? apiCard.chalkBoardPosition : {};
  const worldmap = apiCard.worldMapPosition && typeof apiCard.worldMapPosition === 'object' ? apiCard.worldMapPosition : {};
  let primary = 0, secondary = 0;
  if (layout === 'timeline') primary = toNum(timeline.position, 0);
  else if (layout === 'story') primary = toNum(story.position, 0);
  else if (layout === 'chalkboard') { primary = toNum(chalk.top, 0); secondary = toNum(chalk.left, 0); }
  else if (layout === 'worldmap') { primary = toNum(worldmap.lng, 0); secondary = toNum(worldmap.lat, 0); }
  else {
    primary = toNum(kanban.position, null) ?? toNum(timeline.position, null) ?? toNum(story.position, null) ?? toNum(chalk.top, 0);
    secondary = toNum(chalk.left, 0);
  }
  return [primary || 0, secondary || 0, toNum(apiCard.created, 0), String(apiCard.id || '')].toString();
}

function worldMapCoordsHtml(apiCard) {
  const pos = apiCard.worldMapPosition;
  if (!pos || typeof pos !== 'object') return '';
  if (pos.lat == null || pos.lng == null) return '';
  return `<p><strong>Koordinaten:</strong> ${escapeHtml(String(pos.lat))}, ${escapeHtml(String(pos.lng))}</p>`;
}

function hasVideoConference(apiCard) {
  const v = apiCard.videoConference;
  if (typeof v === 'boolean') return v;
  return ['moderator','public'].includes(String(v || '').trim().toLowerCase());
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (!['http:','https:'].includes(u.protocol) || !u.hostname) return '';
    return raw;
  } catch { return ''; }
}

function asArray(v) { return Array.isArray(v) ? v : []; }
function toNum(v, def) { const n = parseFloat(v); return isNaN(n) ? def : n; }

function normalizePayload(payload) {
  const { sourceUrl, board } = extractBoardPayload(payload);
  const layout = boardLayout(board);
  const title = String(board.name || 'TaskCards Board').trim() || 'TaskCards Board';
  const cards = asArray(board.cards).filter(c => typeof c === 'object');
  const columns = mapColumns(board, cards, layout);

  const description = sanitizeRichText(board.description);
  if (description) {
    if (!columns.length) columns.push({ title: 'Karten', cards: [] });
    columns[0].cards.unshift({
      title: 'Beschreibung',
      elements: [{ type: 'richText', text: description, inputFormat: 'richTextCk5Simple' }],
      role: 'importer_description',
    });
  }

  return {
    sourceUrl: sourceUrl || `taskcards://${board.id || 'board'}`,
    sourceType: 'taskcards',
    title,
    layout: layout === 'story' ? 'list' : 'columns',
    columns,
    subtitle: description || null,
  };
}

async function postGraphQL(payload, xToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (xToken) headers['x-token'] = xToken;
  const res = await fetch(TASKCARDS_GRAPHQL_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (res.status !== 200) throw new ImporterError(`Taskcards GraphQL antwortet mit HTTP ${res.status}.`);
  const data = await res.json();
  const errors = data.errors;
  if (Array.isArray(errors) && errors.length) {
    const msg = typeof errors[0] === 'object' ? errors[0].message : null;
    throw new ImporterError(`Taskcards GraphQL-Fehler: ${msg || 'Unbekannt'}`);
  }
  return data;
}

export class TaskcardsImporter extends BaseImporter {
  get name() { return 'taskcards'; }

  matches(url) { return parseBoardLink(url) !== null; }

  async fetchPull(url, logger) {
    const boardLink = parseBoardLink(url);
    if (!boardLink) throw new ImporterError('Kein Taskcards-Board in der URL gefunden.');
    logger.step(`Lade Taskcards-Board: ${url}`);

    const visitor = await postGraphQL({ query: 'mutation { createVisitor { id noActive } }' }, null);
    const xToken = visitor?.data?.createVisitor?.id;
    if (!xToken) throw new ImporterError('Taskcards hat keinen Visitor-Token geliefert.');

    if (boardLink.token) {
      const path = `${TASKCARDS_BASE_URL}/api/boards/${encodeURIComponent(boardLink.boardId)}/permissions/${encodeURIComponent(boardLink.token)}/accesses`;
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-token': xToken },
        body: JSON.stringify({ password: '' }),
      });
      if (![200, 201, 204, 409].includes(r.status)) {
        throw new ImporterError(`Taskcards-Zugriff konnte nicht freigeschaltet werden: HTTP ${r.status}.`);
      }
    }

    const payload = await postGraphQL(
      { operationName: null, variables: { id: boardLink.boardId }, query: BOARD_QUERY },
      xToken,
    );
    payload.source_url = url;
    logger.info('Board wird geparst...');
    const board = normalizePayload(payload);
    const totalCards = board.columns.reduce((s, c) => s + c.cards.length, 0);
    logger.ok(`✓ "${board.title}" — ${board.columns.length} Spalten, ${totalCards} Karten`);
    return board;
  }

  parsePush(payload) {
    return normalizePayload(payload);
  }
}
