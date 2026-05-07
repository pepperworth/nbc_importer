import 'dotenv/config';
import express from 'express';
import { memoryStorage } from 'multer';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { scheduleCleanup } from './src/jobs/cleanup.js';

import { findImporter, findImporterByName } from './src/importers/registry.js';
import { runPipeline } from './src/pipeline/runner.js';
import { applyMetaColumn } from './src/nbc/meta-column.js';
import { exportBoard } from './src/nbc/exporter.js';
import { renderQrCodesInline } from './src/importers/edumaps.js';
import { edumapsExportToIntermediate } from './src/importers/edumaps.js';
import { getLintConfig, getAuthMode, getAuthCredentials } from './src/config.js';
import { NBCSession, AuthError } from './src/nbc/session.js';
import {
  createJob, getJob, updateJobStatus, appendJobLog, appendJobWarnings,
  addListener, removeListener, emitToListeners,
} from './src/jobs/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.static(join(__dirname, 'public')));

// --- Auth ---
const AUTH_MODE = getAuthMode();

// Singleton session for password mode — created lazily so startup doesn't fail
// if credentials are not set.
let _nbcSession = null;
function getNbcSession() {
  if (_nbcSession) return _nbcSession;
  const { email, password } = getAuthCredentials();
  if (!email || !password) throw Object.assign(
    new Error('NBC_EMAIL / NBC_PASSWORD nicht konfiguriert (auth.mode: password).'),
    { status: 500 },
  );
  const baseUrl = process.env.NBC_BASE_URL || 'https://niedersachsen.cloud/api/v3';
  _nbcSession = new NBCSession({ baseUrl, email, password });
  return _nbcSession;
}

function parseJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Ungültiger JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
}

function extractSchoolId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.schoolId === 'string' && payload.schoolId) return payload.schoolId;
  if (typeof payload.school === 'string' && payload.school) return payload.school;
  if (typeof payload.schoolid === 'string' && payload.schoolid) return payload.schoolid;
  return '';
}

function validateJwt(raw) {
  const jwt = (raw || '').trim();
  if (!jwt) throw Object.assign(new Error('JWT fehlt'), { status: 400 });
  let payload;
  try { payload = parseJwt(jwt); }
  catch { throw Object.assign(new Error('Ungültiger JWT'), { status: 400 }); }
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw Object.assign(new Error(`JWT abgelaufen am ${new Date(payload.exp * 1000).toLocaleString('de-DE')}`), { status: 400 });
  }
  const schoolId = extractSchoolId(payload);
  if (!schoolId) throw Object.assign(new Error('schoolId nicht im JWT gefunden'), { status: 400 });
  return { jwt, schoolId };
}

// Returns auth info for a route: either validates user-supplied JWT (jwt mode)
// or returns a session marker (password mode).
async function resolveAuth(reqJwt) {
  if (AUTH_MODE === 'password') {
    // Validate session is configured; return marker — actual token fetched in runJob.
    getNbcSession(); // throws if not configured
    return { authMode: 'password' };
  }
  return { authMode: 'jwt', ...validateJwt(reqJwt) };
}

// --- CORS for push endpoints ---
const EDUMAPS_ORIGINS = new Set(['https://www.edumaps.de','https://edumaps.de','https://app.edumaps.de']);
const TASKCARDS_ORIGINS = new Set(['https://www.taskcards.de','https://taskcards.de','https://www.taskcards.app','https://taskcards.app']);

function corsForOrigins(allowed) {
  return (req, res, next) => {
    const origin = req.headers.origin || '';
    if (allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

function newJobId() { return randomBytes(4).toString('hex'); }

function makeBoolOpt(val) {
  if (typeof val === 'boolean') return val;
  return ['1','true','on'].includes(String(val || '').toLowerCase());
}

// --- Logger for job ---
function makeJobLogger(jobId) {
  const emit = (event) => {
    appendJobLog(jobId, event);
    emitToListeners(jobId, event);
  };
  const log = (level, msg) => {
    console.log(`[${level}] ${msg}`);
    emit({ type: 'log', level, msg, ts: Math.floor(Date.now() / 1000) });
  };
  return {
    info: (msg) => log('info', msg),
    ok:   (msg) => log('ok',   msg),
    step: (msg) => log('step', msg),
    err:  (msg) => log('err',  msg),
    warn: (msg) => log('warn', msg),
  };
}

// --- Core job runner ---
async function runJob(jobId) {
  const job = getJob(jobId);
  if (!job || job.status !== 'running') return;
  const logger = makeJobLogger(jobId);

  try {
    const data = job.data;
    const { options } = data;

    // Resolve jwt + schoolId: for password mode, get fresh session token now.
    let jwt, schoolId;
    if (data.authMode === 'password') {
      const session = getNbcSession();
      jwt = await session.getToken();
      const payload = parseJwt(jwt);
      schoolId = extractSchoolId(payload);
      if (!schoolId) throw new Error('schoolId konnte nicht aus Session-Token gelesen werden.');
    } else {
      jwt = data.jwt;
      schoolId = data.schoolId;
    }

    let board;

    if (data.jobType === 'url') {
      const importer = findImporter(data.url);
      if (!importer) throw new Error(`Keine unterstützte Quelle für: ${data.url}`);
      board = await importer.fetchPull(data.url, logger);
    } else if (data.jobType === 'push') {
      const importer = findImporterByName(data.importerName);
      if (!importer) throw new Error(`Unbekannter Importer: ${data.importerName}`);
      board = importer.parsePush(data.payload);
    } else if (data.jobType === 'file') {
      const raw = data.payload;
      if (!raw.boardTitle || !raw.columns) throw new Error('Kein gültiges Edumaps-Export-Format');
      board = edumapsExportToIntermediate(raw, raw.sourceUrl || '');
    } else {
      throw new Error(`Unbekannter Job-Typ: ${data.jobType}`);
    }

    if (data.jobType === 'file') {
      await renderQrCodesInline(board.columns, logger);
    }

    const cfg = getLintConfig();
    const warnings = await runPipeline(board, logger, cfg);
    appendJobWarnings(jobId, warnings);

    const droppedWidgetCount = countDroppedWidgets(board.columns);

    if (options.addSummaryCard) {
      const added = applyMetaColumn(board, { enabled: true, droppedWidgetCount });
      if (added) logger.info('Meta-Spalte „Über diesen Bereich" vorangestellt.');
    }

    const result = await exportBoard(jwt, schoolId, board, logger, {
      importColors: !!options.importColors,
      omitWidgetWarnings: !!options.omitWidgetWarnings,
    });

    const doneEvent = { type: 'done', ...result, ts: Math.floor(Date.now() / 1000) };
    emitToListeners(jobId, doneEvent);
    appendJobLog(jobId, doneEvent);
    updateJobStatus(jobId, 'done', result);
  } catch (err) {
    logger.err(err.message);
    const errEvent = { type: 'error', msg: err.message, ts: Math.floor(Date.now() / 1000) };
    emitToListeners(jobId, errEvent);
    appendJobLog(jobId, errEvent);
    updateJobStatus(jobId, 'error', null, err.message);
  }
}

const WIDGET_MARKER = '⚠️ Edumaps-Element';
function countDroppedWidgets(columns) {
  let n = 0;
  for (const col of columns) for (const card of col.cards) for (const el of (card.elements || [])) {
    if (el.type === 'richText' && (el.text || '').includes(WIDGET_MARKER)) n++;
  }
  return n;
}

// --- HTML routes ---
app.get('/', (_req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));
app.get('/status/:jobId', (_req, res) => res.sendFile(join(__dirname, 'public', 'status.html')));

// --- Health + Config ---
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => res.json({ authMode: AUTH_MODE }));

// --- API: Job status ---
app.get('/api/status/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });
  const result = job.result || {};
  res.json({
    jobId: job.id,
    status: job.status,
    shareUrl: result.shareUrl || null,
    roomUrl: result.roomUrl || null,
    summary: result.summary || null,
    error: job.error || null,
    warnings: job.warnings || [],
  });
});

// --- API: URL Import (Edumaps, Taskcards, Padlet) ---
app.post('/api/import/url', async (req, res) => {
  try {
    const auth = await resolveAuth(req.body.jwt);
    const url = (req.body.sourceUrl || req.body.edumapsUrl || '').trim();
    if (!url) return res.status(400).json({ error: 'URL fehlt' });
    if (!findImporter(url)) {
      return res.status(400).json({ error: `Keine unterstützte Quelle für: ${url}` });
    }
    const jobId = newJobId();
    createJob(jobId, 'url', {
      jobType: 'url', ...auth, url,
      options: {
        importColors: makeBoolOpt(req.body.importColors),
        omitWidgetWarnings: makeBoolOpt(req.body.omitWidgetWarnings),
        addSummaryCard: makeBoolOpt(req.body.addSummaryCard),
      },
    });
    res.json({ jobId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- API: File Upload Import (Edumaps JSON) ---
app.post('/api/import', upload.single('file'), async (req, res) => {
  try {
    const auth = await resolveAuth(req.body.jwt);
    if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });
    let payload;
    try { payload = JSON.parse(req.file.buffer.toString('utf-8')); }
    catch { return res.status(400).json({ error: 'JSON konnte nicht geparst werden' }); }
    const jobId = newJobId();
    createJob(jobId, 'file', {
      jobType: 'file', ...auth, payload,
      options: {
        importColors: makeBoolOpt(req.body.importColors),
        omitWidgetWarnings: makeBoolOpt(req.body.omitWidgetWarnings),
        addSummaryCard: makeBoolOpt(req.body.addSummaryCard),
      },
    });
    res.json({ jobId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- API: Push (Edumaps userscript) ---
app.options('/api/ingest/edumaps', corsForOrigins(EDUMAPS_ORIGINS));
app.post('/api/ingest/edumaps', corsForOrigins(EDUMAPS_ORIGINS), express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const auth = await resolveAuth(req.body.jwt);
    const payload = req.body.payload;
    if (!payload?.columns || !payload?.boardTitle) {
      return res.status(400).json({ error: 'Payload muss ein Edumaps-Export-JSON sein.' });
    }
    const jobId = newJobId();
    createJob(jobId, 'push', {
      jobType: 'push', importerName: 'edumaps', ...auth, payload,
      options: {
        importColors: !!req.body.importColors,
        omitWidgetWarnings: !!req.body.omitWidgetWarnings,
        addSummaryCard: !!req.body.addSummaryCard,
      },
    });
    const statusUrl = `${req.protocol}://${req.get('host')}/status/${jobId}`;
    res.json({ jobId, statusUrl });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- API: Push (Taskcards bookmarklet) ---
app.options('/api/ingest/taskcards', corsForOrigins(TASKCARDS_ORIGINS));
app.post('/api/ingest/taskcards', corsForOrigins(TASKCARDS_ORIGINS), express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const auth = await resolveAuth(req.body.jwt);
    const payload = req.body.payload;
    if (!payload) return res.status(400).json({ error: 'Payload fehlt' });
    const jobId = newJobId();
    createJob(jobId, 'push', {
      jobType: 'push', importerName: 'taskcards', ...auth, payload,
      options: {
        importColors: false,
        omitWidgetWarnings: false,
        addSummaryCard: !!req.body.addSummaryCard,
      },
    });
    const statusUrl = `${req.protocol}://${req.get('host')}/status/${jobId}`;
    res.json({ jobId, statusUrl });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- SSE Stream ---
app.get('/api/import/:jobId/stream', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  for (const e of (job.log || [])) send(e);

  if (job.status === 'done' || job.status === 'error') return res.end();

  addListener(req.params.jobId, send);
  req.on('close', () => removeListener(req.params.jobId, send));

  if (job.status === 'pending') {
    updateJobStatus(req.params.jobId, 'running');
    runJob(req.params.jobId);
  }
});

// --- Start ---
const PORT = parseInt(process.env.PORT || '3010', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`NBC Import Server läuft auf Port ${PORT} (auth.mode: ${AUTH_MODE})`);
  scheduleCleanup();
});
