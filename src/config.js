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

// ID of the fixed "Ablage-Raum" in the service account.
// When set, boards are created directly inside this room (no new room per import).
// Only used in password mode; ignored in jwt mode.
export function getAblageRoomId() {
  return load()?.nbc?.ablage_room_id || '';
}

// Returns 'jwt' (default, prod) or 'password' (staging — server logs in).
export function getAuthMode() {
  return load()?.auth?.mode === 'password' ? 'password' : 'jwt';
}

// Email/password from env (never from config.yaml to keep credentials out of git).
export function getAuthCredentials() {
  return {
    email: process.env.NBC_EMAIL || '',
    password: process.env.NBC_PASSWORD || '',
  };
}
