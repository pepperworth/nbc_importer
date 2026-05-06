export const name = 'board-lint';

const PREFIX = '[Strukturprüfung]';
const HTML_TAG_RE = /<[^>]+>/g;

function isCardEmpty(card) {
  if (!card.elements || !card.elements.length) return true;
  for (const el of card.elements) {
    if (el.type !== 'richText') return false;
    const withoutTags = (el.text || '').replace(HTML_TAG_RE, '');
    const stripped = withoutTags.replace(/&nbsp;|&#160;/g, ' ').trim();
    if (stripped) return false;
  }
  return true;
}

export function run(board, _logger, cfg = {}) {
  const maxElements = cfg.oversizedCardMaxElements || 20;
  const maxCards = cfg.oversizedBoardMaxCards || 200;
  const maxWarnings = cfg.maxWarnings || 50;
  const warnings = [];

  const totalCards = board.columns.reduce((s, c) => s + c.cards.length, 0);
  if (totalCards > maxCards) {
    warnings.push(`${PREFIX} Board: ungewöhnlich viele Karten (${totalCards}, Schwelle ${maxCards}).`);
  }

  for (const col of board.columns) {
    const colLabel = (col.title || '').trim() || '(ohne Spaltentitel)';
    const untitled = col.cards.filter(c => !(c.title || '').trim()).length;
    if (untitled === 1) warnings.push(`${PREFIX} Spalte „${colLabel}": eine Karte hat keinen Titel.`);
    else if (untitled > 1) warnings.push(`${PREFIX} Spalte „${colLabel}": ${untitled} Karten ohne Titel.`);

    for (const card of col.cards) {
      const cardLabel = (card.title || '').trim() || '(ohne Titel)';
      if (isCardEmpty(card)) warnings.push(`${PREFIX} Karte „${cardLabel}" in Spalte „${colLabel}": kein sichtbarer Inhalt.`);
      if ((card.elements || []).length > maxElements) {
        warnings.push(`${PREFIX} Karte „${cardLabel}" in Spalte „${colLabel}": sehr viele Elemente (${card.elements.length}, Schwelle ${maxElements}).`);
      }
    }

    const titleCounts = {};
    for (const card of col.cards) {
      const t = (card.title || '').trim().toLowerCase();
      if (!t) continue;
      titleCounts[t] = (titleCounts[t] || 0) + 1;
    }
    for (const [lower, count] of Object.entries(titleCounts)) {
      if (count > 1) {
        const original = col.cards.find(c => (c.title || '').trim().toLowerCase() === lower)?.title || lower;
        warnings.push(`${PREFIX} Spalte „${colLabel}": Titel „${original}" kommt ${count}× vor — möglicher Copy-Paste-Versehen.`);
      }
    }
  }

  const capped = maxWarnings > 0 && warnings.length > maxWarnings;
  const final = capped ? [...warnings.slice(0, maxWarnings), `${PREFIX} Weitere ${warnings.length - maxWarnings} Strukturhinweise unterdrückt.`] : warnings;
  return { warnings: final, info: final.length ? `[lint] ${final.length} Hinweis(e)` : null };
}
