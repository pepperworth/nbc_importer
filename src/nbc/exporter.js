import {
  apiRequest, setLinkContent, uploadFile, createShareToken,
  parseDataUrl, downloadFileForUpload, NBC_ORIGIN, BASE_URL,
} from './client.js';

// Build share-import URL from the configured base (works for prod + staging)
function buildShareUrl(token) {
  return `${NBC_ORIGIN}/rooms?import=${token}&importedType=columnBoard`;
}
import { renderQrCodesInline } from '../importers/edumaps.js';

const WIDGET_WARNING_MARKER = '⚠️ Edumaps-Element';

function countWidgetWarnings(columns) {
  let count = 0;
  for (const col of columns) {
    for (const card of col.cards) {
      for (const el of (card.elements || [])) {
        if (el.type === 'richText' && (el.text || '').includes(WIDGET_WARNING_MARKER)) count++;
      }
    }
  }
  return count;
}

function stripWidgetWarnings(columns) {
  let removed = 0;
  for (const col of columns) {
    for (const card of col.cards) {
      card.elements = (card.elements || []).filter(el => {
        if (el.type === 'richText' && (el.text || '').includes(WIDGET_WARNING_MARKER)) { removed++; return false; }
        return true;
      });
    }
  }
  return removed;
}

export async function exportBoard(jwt, schoolId, board, logger, options = {}) {
  const { importColors = false, omitWidgetWarnings = false } = options;

  logger.step(`Board: "${board.title}" — ${board.columns.length} Spalten`);

  await renderQrCodesInline(board.columns, logger);

  let warningCount = countWidgetWarnings(board.columns);
  if (omitWidgetWarnings) {
    const removed = stripWidgetWarnings(board.columns);
    if (removed > 0) { logger.info(`${removed} Platzhalter-Hinweise zu nicht abbildbaren Modulen entfernt.`); warningCount = 0; }
  }

  logger.info('Room wird erstellt...');
  const room = await apiRequest(jwt, 'POST', '/rooms', { name: board.title, color: 'blue-grey', features: [] });
  logger.ok(`✓ Room erstellt: ${room.id}`);

  const nbcBoard = await apiRequest(jwt, 'POST', '/boards', {
    title: board.title, parentId: room.id, parentType: 'room', layout: board.layout || 'columns',
  });
  logger.ok(`✓ Board erstellt: ${nbcBoard.id}`);

  const anchorToCardId = new Map();
  const pendingInternalLinks = [];
  const pendingAnchorTexts = [];
  let totalFiles = 0, totalLinks = 0, totalColumns = 0;
  const totalColCount = board.columns.length;

  for (const [ci, col] of board.columns.entries()) {
    logger.step(`[${ci + 1}/${totalColCount}] Spalte "${col.title}"`);
    const column = await apiRequest(jwt, 'POST', `/boards/${nbcBoard.id}/columns`);
    await apiRequest(jwt, 'PATCH', `/columns/${column.id}/title`, { title: col.title || '' });
    totalColumns++;

    for (const card of col.cards) {
      const cardRes = await apiRequest(jwt, 'POST', `/columns/${column.id}/cards`);
      await apiRequest(jwt, 'PATCH', `/cards/${cardRes.id}/title`, { title: card.title || '' });
      logger.info(`  Karte "${card.title || '(ohne Titel)'}"`);

      if (importColors && card.backgroundColor && card.backgroundColor !== 'transparent') {
        try {
          await apiRequest(jwt, 'PATCH', `/cards/${cardRes.id}/color`, { backgroundColor: card.backgroundColor });
          logger.info(`    ✓ Farbe ${card.backgroundColor}`);
        } catch (e) {
          logger.err(`    Farbe ${card.backgroundColor} konnte nicht gesetzt werden: ${e.message}`);
        }
      }

      if (card.anchorId) anchorToCardId.set(card.anchorId, cardRes.id);

      const elements = (card.elements || []).sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const [elIdx, el] of elements.entries()) {
        await exportElement(el, elIdx, cardRes.id, { jwt, schoolId, board: nbcBoard, anchorToCardId, pendingInternalLinks, pendingAnchorTexts, logger });
        if (el.type === 'link' || el.type === 'internalLink') totalLinks++;
        if (el.type === 'file') totalFiles++;
      }
    }
  }

  const resolveAnchor = (key) =>
    anchorToCardId.has(key)
      ? `${NBC_ORIGIN}/boards/${nbcBoard.id}#card-${anchorToCardId.get(key)}`
      : `${NBC_ORIGIN}/boards/${nbcBoard.id}`;

  if (pendingInternalLinks.length > 0) {
    logger.step(`${pendingInternalLinks.length} interne Karten-Links werden aufgelöst...`);
    for (const { elemId, anchor, title } of pendingInternalLinks) {
      const key = anchor.replace(/^#/, '');
      await setLinkContent(jwt, elemId, resolveAnchor(key), title || key);
      if (anchorToCardId.has(key)) logger.info(`  ✓ "${title}" → #card-${anchorToCardId.get(key)}`);
      else logger.warn(`  "${title}" (Anker #${key} nicht gefunden, Link zeigt auf Board)`);
    }
  }

  if (pendingAnchorTexts.length > 0) {
    logger.step(`${pendingAnchorTexts.length} Text-Elemente mit internen Links werden aufgelöst...`);
    for (const { elemId, rawText } of pendingAnchorTexts) {
      const resolved = rawText.replace(/__ANCHOR__([^"]+)/g, (_, key) => resolveAnchor(key));
      await apiRequest(jwt, 'PATCH', `/elements/${elemId}/content`, {
        data: { type: 'richText', content: { text: resolved, inputFormat: 'richTextCk5' } },
      });
    }
  }

  let shareToken = null, shareExpiresAt = null;
  try {
    logger.info('Share-Link wird erstellt...');
    const share = await createShareToken(jwt, room.id);
    shareToken = share.token;
    shareExpiresAt = share.expiresAt || null;
    const note = shareExpiresAt ? ` (gültig bis ${new Date(shareExpiresAt).toLocaleString('de-DE')})` : '';
    logger.ok(`✓ Share-Link erstellt${note}`);
  } catch (err) {
    logger.err(`Share-Link konnte nicht erstellt werden: ${err.message}`);
  }

  const roomUrl = `${NBC_ORIGIN}/rooms/${room.id}`;
  const shareUrl = shareToken ? buildShareUrl(shareToken) : null;
  const totalCards = board.columns.reduce((s, c) => s + c.cards.length, 0);
  logger.ok(`✓ Fertig! ${shareUrl || roomUrl}`);

  return {
    roomId: room.id, boardId: nbcBoard.id,
    shareToken, shareExpiresAt, roomUrl, shareUrl,
    summary: { columns: totalColumns, cards: totalCards, files: totalFiles, links: totalLinks },
  };
}

async function exportElement(el, elIdx, cardId, ctx) {
  const { jwt, schoolId, board, pendingInternalLinks, pendingAnchorTexts, logger } = ctx;

  if (el.type === 'richText') {
    const elem = await apiRequest(jwt, 'POST', `/cards/${cardId}/elements`, { type: 'richText', toPosition: elIdx });
    const text = el.text || '';
    await apiRequest(jwt, 'PATCH', `/elements/${elem.id}/content`, {
      data: { type: 'richText', content: { text, inputFormat: el.inputFormat || 'richTextCk5' } },
    });
    if (text.includes('__ANCHOR__')) pendingAnchorTexts.push({ elemId: elem.id, rawText: text });
    logger.info(`    ✓ Text-Element`);

  } else if (el.type === 'link') {
    const elem = await apiRequest(jwt, 'POST', `/cards/${cardId}/elements`, { type: 'link', toPosition: elIdx });
    await setLinkContent(jwt, elem.id, el.url, el.title || el.url, el.description || '');
    logger.info(`    ✓ Link "${el.url}"`);

  } else if (el.type === 'internalLink') {
    const elem = await apiRequest(jwt, 'POST', `/cards/${cardId}/elements`, { type: 'link', toPosition: elIdx });
    pendingInternalLinks.push({ elemId: elem.id, anchor: el.anchor || '', title: el.title || '' });
    logger.info(`    ✓ Interner Link "${el.title}" (wird nach Import aufgelöst)`);

  } else if (el.type === 'collaborativeTextEditor') {
    await apiRequest(jwt, 'POST', `/cards/${cardId}/elements`, { type: 'collaborativeTextEditor', toPosition: elIdx });
    if (el.originalUrl) {
      const noteElem = await apiRequest(jwt, 'POST', `/cards/${cardId}/elements`, { type: 'link', toPosition: elIdx + 1 });
      await setLinkContent(jwt, noteElem.id, el.originalUrl, `Original-Pad: ${el.title || 'Teamtext'}`, 'Inhalt aus dem Original-Pad bitte manuell rüberkopieren.');
    }
    logger.info(`    ✓ Etherpad "${el.title || 'Teamtext'}"`);

  } else if (el.type === 'videoConference') {
    await apiRequest(jwt, 'POST', `/cards/${cardId}/elements`, { type: 'videoConference', toPosition: elIdx });
    logger.info(`    ✓ Videokonferenz`);

  } else if (el.type === 'file') {
    const elem = await apiRequest(jwt, 'POST', `/cards/${cardId}/elements`, { type: 'file', toPosition: elIdx });
    let buffer, mimeType;
    if (el.fileData) {
      ({ mimeType, buffer } = parseDataUrl(el.fileData));
    } else if (el.sourceUrl) {
      try {
        ({ buffer, mimeType } = await downloadFileForUpload(el.sourceUrl, logger));
      } catch (e) {
        logger.err(`    Datei "${el.filename}" konnte nicht heruntergeladen werden: ${e.message}`);
        return;
      }
    } else {
      logger.warn(`    Datei "${el.filename}" hat weder fileData noch sourceUrl — übersprungen.`);
      return;
    }
    const filename = el.filename || 'datei';
    await uploadFile(jwt, schoolId, elem.id, filename, mimeType || el.mimetype || 'application/octet-stream', buffer);
    await apiRequest(jwt, 'PATCH', `/elements/${elem.id}/content`, {
      data: { type: 'file', content: { caption: el.caption || '', alternativeText: filename.replace(/\.[^.]+$/, '') } },
    });
    logger.info(`    ✓ Datei "${filename}"`);
  }
}
