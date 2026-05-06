// Long-lived JWT session via email/password login (for staging/password auth mode).
// Logs in once and refreshes before TTL expires (like NBCSession in Python reference).

import fetch from 'node-fetch';

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;
const BACKOFF_BASE = 500;
const BACKOFF_CAP = 30_000;
const TIMEOUT_MS = 30_000;

function backoffMs(attempt) {
  const base = BACKOFF_BASE * Math.pow(2, attempt);
  const jitter = base * 0.2 * (2 * Math.random() - 1);
  return Math.min(BACKOFF_CAP, Math.max(0, base + jitter));
}

export class AuthError extends Error {}

export class NBCSession {
  constructor({ baseUrl, email, password, refreshBeforeMs = 600_000, tokenTtlMs = 7_200_000 }) {
    this._apiBase = baseUrl.replace(/\/?$/, '') ;
    this._email = email;
    this._password = password;
    this._refreshBefore = refreshBeforeMs;
    this._ttl = tokenTtlMs;
    this._token = null;
    this._expiresAt = 0;
  }

  get apiBase() { return this._apiBase; }

  async _login() {
    const res = await fetch(`${this._apiBase}/authentication/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this._email, password: this._password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 403) throw new AuthError('NBC-Login fehlgeschlagen: ungültige Zugangsdaten (403).');
    if (res.status === 400) {
      const t = await res.text().catch(() => '');
      throw new AuthError(`NBC-Login ungültige Anfrage (400): ${t.slice(0, 200)}`);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new AuthError(`NBC-Login fehlgeschlagen (${res.status}): ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    this._token = data.accessToken;
    this._expiresAt = Date.now() + this._ttl;
  }

  _needsRefresh() {
    if (!this._token) return true;
    return Date.now() >= this._expiresAt - this._refreshBefore;
  }

  async getToken() {
    if (this._needsRefresh()) await this._login();
    return this._token;
  }

  async authHeader() {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}` };
  }

  async request(method, path, { json, form, expect = [200, 201, 204] } = {}) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const headers = await this.authHeader();
      let body, extraHeaders = {};
      if (json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
      } else if (form) {
        body = form;
        extraHeaders = form.getHeaders ? form.getHeaders() : {};
      }
      let res;
      try {
        res = await fetch(`${this._apiBase}${path}`, {
          method, body, signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { ...headers, ...extraHeaders },
        });
      } catch (err) {
        if (attempt >= MAX_RETRIES) throw err;
        await new Promise(r => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      if (res.status === 401 && this._token) {
        this._token = null;
        const headers2 = await this.authHeader();
        let body2 = body;
        res = await fetch(`${this._apiBase}${path}`, {
          method, body: body2, signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { ...headers2, ...extraHeaders },
        });
      }
      if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
        const retryAfter = parseFloat(res.headers.get('retry-after') || '');
        const wait = !isNaN(retryAfter) ? Math.min(retryAfter * 1000, BACKOFF_CAP) : backoffMs(attempt);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!expect.includes(res.status)) {
        const t = await res.text().catch(() => '');
        throw new Error(`${method} ${path} → ${res.status}: ${t.slice(0, 400)}`);
      }
      return res;
    }
    throw new Error(`${method} ${path}: Retry-Schleife unerwartet verlassen.`);
  }
}
