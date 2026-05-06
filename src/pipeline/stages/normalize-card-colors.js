import { hexToNbcColor } from '../colors.js';

export const name = 'normalize-card-colors';

export function run(board, _logger) {
  let mapped = 0;
  for (const col of board.columns) {
    for (const card of col.cards) {
      const raw = card.backgroundColorRaw;
      if (!raw || card.backgroundColor) continue;
      const color = hexToNbcColor(raw);
      if (color) { card.backgroundColor = color; mapped++; }
    }
  }
  return { warnings: [], info: mapped ? `[colors] ${mapped} Karte(n) farblich zugeordnet` : null };
}
