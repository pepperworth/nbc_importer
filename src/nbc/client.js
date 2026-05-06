import fetch from 'node-fetch';
import FormData from 'form-data';

const BASE_URL = process.env.NBC_BASE_URL || 'https://niedersachsen.cloud/api/v3';

// Derive the web origin from BASE_URL (strip /api/v3 suffix)
const NBC_ORIGIN = BASE_URL.replace(/\/api\/v3\/?$/, '');

export async function apiRequest(jwt, method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

export async function setLinkContent(jwt, elementId, url, title, description = '') {
  const res = await fetch(`${BASE_URL}/elements/${elementId}/content`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { type: 'link', content: { url, title, description, imageUrl: '' } } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PATCH link ${elementId} → ${res.status}: ${text.slice(0, 200)}`);
  }
}

export async function uploadFile(jwt, schoolId, elementId, fileName, mimeType, buffer) {
  const url = `${BASE_URL}/file/upload/school/${schoolId}/boardnodes/${elementId}`;
  const form = new FormData();
  form.append('file', buffer, { filename: fileName, contentType: mimeType });
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, ...form.getHeaders() },
    body: form.getBuffer(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upload ${fileName} → ${res.status}: ${text.slice(0, 200)}`);
  }
}

export async function createShareToken(jwt, parentId, parentType = 'room') {
  return apiRequest(jwt, 'POST', '/sharetoken', { parentType, parentId });
}

export function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new Error('Ungültiges data:-URL-Format');
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

export async function downloadFileForUpload(sourceUrl, logger) {
  const SSRF_SAFE = /^https:\/\//i;
  const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  if (!SSRF_SAFE.test(sourceUrl)) throw new Error(`Unsichere URL: ${sourceUrl}`);
  const hostname = new URL(sourceUrl).hostname;
  if (PRIVATE.test(hostname)) throw new Error(`Private URL nicht erlaubt: ${hostname}`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  let res;
  try {
    res = await fetch(sourceUrl, { signal: ctrl.signal, headers: { 'User-Agent': 'NBC-Importer/0.1' } });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`HTTP ${res.status} für ${sourceUrl}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type') || 'application/octet-stream';
  if (logger) logger.info(`  ↓ ${sourceUrl.split('/').pop().slice(0, 40)} (${(buf.length / 1024).toFixed(0)} KB)`);
  return { buffer: buf, mimeType: mime.split(';')[0].trim() };
}

export { NBC_ORIGIN, BASE_URL };
