import * as normalizeCardColors from './stages/normalize-card-colors.js';
import * as linkPreview from './stages/link-preview.js';
import * as boardLint from './stages/board-lint.js';

const STAGES = {
  'normalize-card-colors': normalizeCardColors,
  'link-preview': linkPreview,
  'board-lint': boardLint,
};

const PIPELINE_BY_SOURCE = {
  edumaps:   ['normalize-card-colors', 'link-preview', 'board-lint'],
  taskcards: ['normalize-card-colors', 'link-preview', 'board-lint'],
  padlet:    ['normalize-card-colors', 'link-preview', 'board-lint'],
};

export async function runPipeline(board, logger, cfg = {}) {
  const stageNames = PIPELINE_BY_SOURCE[board.sourceType] || PIPELINE_BY_SOURCE.edumaps;
  const warnings = [];

  for (const stageName of stageNames) {
    const stage = STAGES[stageName];
    if (!stage) continue;
    try {
      const result = await stage.run(board, logger, cfg);
      if (result?.warnings?.length) warnings.push(...result.warnings);
      if (result?.info && logger) logger.info(result.info);
    } catch (err) {
      if (logger) logger.warn(`[${stageName}] Stage-Fehler (nicht kritisch): ${err.message}`);
    }
  }

  for (const w of warnings) {
    if (logger) logger.warn(w);
  }
  return warnings;
}
