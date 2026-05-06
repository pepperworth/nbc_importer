// Meta-Spalte „Über diesen Bereich" — quellen-agnostisch.

const META_COLUMN_TITLE = 'Über diesen Bereich';
const IMPORTER_DESCRIPTION_ROLE = 'importer_description';

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sourceLinkCard(board) {
  const url = (board.sourceUrl || '').trim();
  if (!url || url.startsWith('taskcards://') || url.startsWith('padlet://') || url.startsWith('edumaps://')) return null;
  return {
    title: 'Quelle',
    elements: [{ type: 'link', url, title: url, description: '', imageUrl: '' }],
  };
}

function descriptionCard(board) {
  const subtitle = (board.subtitle || '').trim();
  if (!subtitle) return null;
  return {
    title: 'Beschreibung',
    elements: [{ type: 'richText', text: subtitle, inputFormat: 'richTextCk5' }],
  };
}

function etherpadLinksCard(board) {
  const pads = [];
  for (const col of board.columns) {
    for (const card of col.cards) {
      for (const el of (card.elements || [])) {
        if (el.type === 'collaborativeTextEditor' && el.originalUrl) {
          pads.push({ title: el.title || 'Etherpad', url: el.originalUrl });
        }
      }
    }
  }
  if (!pads.length) return null;
  const items = pads.map(p => `<li><a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a></li>`).join('');
  const text = `<p><strong>Etherpads aus dem Original</strong> (Inhalt bitte manuell in den NBC-Pad kopieren):</p><ul>${items}</ul>`;
  return {
    title: 'Etherpads',
    elements: [{ type: 'richText', text, inputFormat: 'richTextCk5' }],
  };
}

function droppedWidgetsCard(_board, droppedWidgetCount) {
  if (!droppedWidgetCount) return null;
  const text = `<p>${droppedWidgetCount} Element(e) konnten nicht in die NBC übertragen werden (z.B. Quizze, Umfragen, Countdowns).</p>`;
  return {
    title: 'Nicht übertragene Elemente',
    elements: [{ type: 'richText', text, inputFormat: 'richTextCk5' }],
  };
}

function dropCardsByRole(board, role) {
  for (const col of board.columns) {
    col.cards = col.cards.filter(c => c.role !== role);
  }
}

export function applyMetaColumn(board, { enabled = false, droppedWidgetCount = 0 } = {}) {
  if (!enabled) return false;
  dropCardsByRole(board, IMPORTER_DESCRIPTION_ROLE);

  const builders = [
    () => sourceLinkCard(board),
    () => descriptionCard(board),
    () => etherpadLinksCard(board),
    () => droppedWidgetsCard(board, droppedWidgetCount),
  ];

  const cards = builders.map(b => b()).filter(Boolean);
  if (!cards.length) return false;
  board.columns.unshift({ title: META_COLUMN_TITLE, cards });
  return true;
}
