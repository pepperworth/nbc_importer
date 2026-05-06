import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../config.yaml');

let _cfg;

function load() {
  if (_cfg) return _cfg;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    _cfg = yaml.load(raw) || {};
  } catch {
    _cfg = {};
  }
  return _cfg;
}

export function getLintConfig() {
  const c = load();
  return {
    oversizedCardMaxElements: c?.lint?.oversized_card_max_elements ?? 20,
    oversizedBoardMaxCards: c?.lint?.oversized_board_max_cards ?? 200,
    maxWarnings: c?.lint?.max_warnings ?? 50,
  };
}

export function getJobTtlDays() {
  return load()?.features?.board_ttl_days ?? 30;
}

export function isFeatureEnabled(name) {
  return !!(load()?.features?.[name]);
}
