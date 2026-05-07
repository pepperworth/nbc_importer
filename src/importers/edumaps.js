import fetch from 'node-fetch';
import { parseHTML } from 'linkedom';
import QRCode from 'qrcode';
import { BaseImporter, ImporterError } from './base.js';
import {
  parseDocument, buildExport, collectMediaUrls, injectFileData, stripInternalFields,
} from '../../edumaps-parser.js';

const EDUMAPS_HOSTS = new Set(['edumaps.de']);
const EDUMAPS_SUFFIXES = ['.edumaps.de'];
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; NBC-Importer/0.1; +https://nbc.almostready.dev)';

function assertEdumapsUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch { throw new ImporterError(`Ungültige URL: ${rawUrl}`); }
  if (parsed.protocol !== 'https:') throw new ImporterError(`Nur https:// erlaubt — bekam ${parsed.protocol}`);
  const host = parsed.hostname.toLowerCase();
  if (!EDUMAPS_HOSTS.has(host) && !EDUMAPS_SUFFIXES.some(s => host.endsWith(s))) {
    throw new ImporterError(`Host nicht erlaubt: ${host}`);
  }
  return parsed;
}

async function fetchEdumapsHtml(initialUrl) {
  let currentUrl = initialUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    assertEdumapsUrl(currentUrl);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(currentUrl, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': FETCH_USER_AGENT },
      });
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new ImporterError('Edumaps-Redirect ohne Location-Header.');
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!res.ok) throw new ImporterError(`Edumaps-Board konnte nicht geladen werden: HTTP ${res.status}`);
    const html = await res.text();
    return { html, finalUrl: currentUrl };
  }
  throw new ImporterError('Edumaps-Board: zu viele Weiterleitungen.');
}

export async function renderQrCodesInline(columns, logger) {
  let count = 0;
  for (const col of columns) {
    for (const card of col.cards) {
      for (const el of (card.elements || [])) {
        if (el.type !== 'qrCode') continue;
        try {
          const buf = await QRCode.toBuffer(el.content, {
            type: 'png', errorCorrectionLevel: 'M', scale: 10, margin: 4,
          });
          el.type = 'file';
          el.fileData = `data:image/png;base64,${buf.toString('base64')}`;
          el.filename = el.filename || el.fileName;
          el.caption = el.caption || el.content;
          delete el.fileName;
          count++;
        } catch (e) {
          if (logger) logger.err(`QR-Code "${el.content}" konnte nicht gerendert werden: ${e.message}`);
        }
      }
    }
  }
  if (count > 0 && logger) logger.ok(`✓ ${count} QR-Code${count === 1 ? '' : 's'} gerendert`);
  return count;
}

export class EdumapsImporter extends BaseImporter {
  get name() { return 'edumaps'; }

  matches(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      return EDUMAPS_HOSTS.has(host) || EDUMAPS_SUFFIXES.some(s => host.endsWith(s));
    } catch { return false; }
  }

  async fetchPull(url, logger) {
    const JOB_SOFT_CAP_MS = 5 * 60 * 1000;
    const deadline = Date.now() + JOB_SOFT_CAP_MS;

    logger.step(`Lade Edumaps-Board: ${url}`);
    const { html, finalUrl } = await fetchEdumapsHtml(url);

    logger.info('Board wird geparst...');
    const { document } = parseHTML(html);
    const pathname = new URL(finalUrl).pathname;
    const { columns, boardTitle, boardType } = parseDocument(document, pathname);

    if (!columns || columns.length === 0 || columns.every(c => !c.cards || c.cards.length === 0)) {
      throw new ImporterError('Keine Inhalte auf der Seite gefunden. Ist die URL öffentlich und ein Board?');
    }
    logger.ok(`✓ ${boardType} "${boardTitle}" — ${columns.length} Spalten`);

    const mediaMap = collectMediaUrls(columns);
    const entries = [...mediaMap.entries()];
    if (entries.length > 0) logger.step(`${entries.length} Mediendateien werden geladen...`);

    const dataMap = new Map();
    for (let i = 0; i < entries.length; i++) {
      if (Date.now() > deadline) throw new ImporterError('Zeitlimit (5 min) überschritten');
      const [fileName, mediaUrl] = entries[i];
      const absolute = new URL(mediaUrl, finalUrl).toString();
      try {
        assertEdumapsUrl(absolute);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15_000);
        const res = await fetch(absolute, { signal: ctrl.signal, headers: { 'User-Agent': FETCH_USER_AGENT } });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = res.headers.get('content-type') || 'application/octet-stream';
        dataMap.set(fileName, `data:${mime};base64,${buf.toString('base64')}`);
        logger.info(`  [${i + 1}/${entries.length}] ${fileName} (${(buf.length / 1024).toFixed(0)} KB)`);
      } catch (e) {
        logger.err(`  [${i + 1}/${entries.length}] ${fileName}: ${e.message}`);
      }
    }

    const exportData = buildExport(columns, boardTitle);
    injectFileData(exportData.columns, dataMap);
    await renderQrCodesInline(exportData.columns, logger);
    stripInternalFields(exportData.columns);

    const extraNotes = [];
    if (exportData.totalInternalLinks > 0) extraNotes.push(`${exportData.totalInternalLinks} interne Links`);
    if (exportData.totalQrCodes > 0) extraNotes.push(`${exportData.totalQrCodes} QR-Codes`);
    if (exportData.totalCollaborativeTextEditors > 0) extraNotes.push(`${exportData.totalCollaborativeTextEditors} Etherpads`);
    if (exportData.totalCardsColored > 0) extraNotes.push(`${exportData.totalCardsColored} farbige Karten`);
    const extras = extraNotes.length ? `, ${extraNotes.join(', ')}` : '';
    logger.ok(`✓ JSON erstellt — ${exportData.totalCards} Karten, ${exportData.totalFiles} Dateien, ${exportData.totalLinks} Links${extras}`);

    return edumapsExportToIntermediate(exportData, url);
  }

  parsePush(payload) {
    if (!payload || !payload.columns || !payload.boardTitle) {
      throw new ImporterError('Payload muss ein Edumaps-Export-JSON sein (boardTitle + columns).');
    }
    return edumapsExportToIntermediate(payload, payload.sourceUrl || '');
  }
}

export function edumapsExportToIntermediate(exportData, sourceUrl) {
  const columns = exportData.columns.map(col => ({
    title: col.title || '',
    cards: (col.cards || []).map(card => {
      const elements = (card.elements || [])
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(el => edumapsElementToIntermediate(el))
        .filter(Boolean);
      const mapped = {
        title: card.title || '',
        elements,
      };
      if (card.anchorId) mapped.anchorId = card.anchorId;
      if (card.backgroundColorRaw) mapped.backgroundColorRaw = card.backgroundColorRaw;
      if (card.backgroundColor) mapped.backgroundColor = card.backgroundColor;
      if (card.role) mapped.role = card.role;
      return mapped;
    }),
  }));

  return {
    sourceUrl: sourceUrl || exportData.sourceUrl || '',
    sourceType: 'edumaps',
    title: exportData.boardTitle || 'Edumaps Board',
    layout: 'columns',
    columns,
    subtitle: null,
  };
}

function edumapsElementToIntermediate(el) {
  switch (el.type) {
    case 'text':
      return { type: 'richText', text: el.content || '', inputFormat: 'richTextCk5' };
    case 'richText':
      return { type: 'richText', text: el.text || el.content || '', inputFormat: el.inputFormat || 'richTextCk5' };
    case 'link':
      return { type: 'link', url: el.url || '', title: el.title || '', description: '', imageUrl: '' };
    case 'file':
      return {
        type: 'file',
        filename: el.fileName || el.filename || 'datei',
        fileData: el.fileData,
        caption: el.content || '',
        mimetype: el.mimeType || el.mimetype || 'application/octet-stream',
      };
    case 'internalLink':
      return { type: 'internalLink', anchor: el.anchor || '', title: el.title || '' };
    case 'collaborativeTextEditor':
      return { type: 'collaborativeTextEditor', title: el.title || '', originalUrl: el.originalUrl || '' };
    case 'qrCode':
      return { type: 'qrCode', content: el.content || '', filename: el.fileName || el.filename || 'qrcode.png', caption: el.caption || '' };
    default:
      return null;
  }
}
