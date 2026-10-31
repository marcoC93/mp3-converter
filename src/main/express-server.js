'use strict';

/**
 * Server HTTP locale (Express) avviato dal main process.
 *
 * Serve:
 * - i file statici della GUI (src/renderer);
 * - una piccola API JSON per creare, monitorare, annullare ed eliminare job.
 *
 * Protezioni (vedi docs/SECURITY.md):
 * - ascolto SOLO su 127.0.0.1 (loopback): irraggiungibile dalla rete;
 * - porta effimera scelta dal sistema operativo (port 0);
 * - controllo dell'header Host: blocca attacchi di "DNS rebinding";
 * - controllo dell'header Origin: blocca richieste da altre pagine/siti;
 * - token casuale obbligatorio per /api (header Authorization), consegnato
 *   al renderer via IPC e tenuto solo in memoria;
 * - Content Security Policy restrittiva e nessun directory listing;
 * - nessun percorso fisico nelle risposte.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { AppError, toUserError } = require('./errors');
const { QUALITY_OPTIONS, DEFAULT_BITRATE, SUPPORTED_EXTENSIONS, isValidId } = require('./validation');

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ');

// Solo questi file di licenza possono essere letti tramite API.
// dir: 'licenses' = resources/licenses; 'thirdParty' = resources/third-party/<piattaforma>-<arch>
const LICENSE_FILES = Object.freeze({
  notices: { dir: 'licenses', file: 'THIRD-PARTY-NOTICES.txt', title: 'Avvisi di terze parti' },
  converter: { dir: 'thirdParty', file: 'LICENSES.txt', title: 'Convertitore: PyAV, FFmpeg e codec (GPL-3.0)' },
  sources: { dir: 'thirdParty', file: 'SOURCES.md', title: 'Sorgente corrispondente' },
  app: { dir: 'licenses', file: 'APP-LICENSE.txt', title: 'Licenza di Video to MP3' }
});

function tokensEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * @param {object} o
 * @param {import('./job-manager').JobManager} o.jobManager
 * @param {string} o.rendererDir
 * @param {string} o.licensesDir
 * @param {string} o.thirdPartyDir licenze integrali e sorgenti del convertitore
 * @param {string} o.token
 * @param {() => object} o.getResourceStatus
 * @param {() => Promise<object>|object} o.getAbout
 * @param {object} [o.logger]
 */
function createLocalServer({ jobManager, rendererDir, licensesDir, thirdPartyDir, token, getResourceStatus, getAbout, logger }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Token troppo corto');
  const log = logger || { debug() {}, info() {}, warn() {}, error() {} };
  const state = { port: null, origin: null, server: null, sockets: new Set() };

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // 1. Host: accettiamo solo 127.0.0.1:<porta>. Un sito che punta un proprio
  //    dominio a 127.0.0.1 (DNS rebinding) invierebbe un Host diverso.
  app.use((req, res, next) => {
    if (req.headers.host !== `127.0.0.1:${state.port}`) {
      log.warn('Richiesta rifiutata: Host non valido');
      return res.status(403).json({ error: toUserError('FORBIDDEN') });
    }
    return next();
  });

  // 2. Header di sicurezza su ogni risposta.
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store'
    });
    next();
  });

  // 3. Origin: se presente deve coincidere con la nostra origine.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== state.origin) {
      log.warn('Richiesta rifiutata: Origin non consentita');
      return res.status(403).json({ error: toUserError('FORBIDDEN') });
    }
    return next();
  });

  // 4. GUI statica. express.static non genera elenchi di directory.
  app.use(express.static(rendererDir, { index: 'index.html', dotfiles: 'deny', redirect: false, fallthrough: true }));

  // 5. API protetta da token.
  const api = express.Router();
  api.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header);
    if (!match || !tokensEqual(match[1], token)) {
      return res.status(401).json({ error: toUserError('UNAUTHORIZED') });
    }
    return next();
  });
  api.use(express.json({ limit: '16kb', strict: true, type: 'application/json' }));

  api.get('/config', (req, res) => {
    const status = getResourceStatus();
    res.json({
      qualities: QUALITY_OPTIONS,
      defaultBitrate: DEFAULT_BITRATE,
      extensions: SUPPORTED_EXTENSIONS,
      resources: {
        ready: status.ready,
        problems: status.problems.map((p) => ({ component: p.component, ...toUserError(p.code) }))
      }
    });
  });

  api.post('/jobs', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INVALID_ARGUMENTS');
    const allowedKeys = new Set(['fileId', 'bitrate']);
    if (Object.keys(body).some((k) => !allowedKeys.has(k))) throw new AppError('INVALID_ARGUMENTS', 'campi inattesi');
    if (!isValidId(body.fileId)) throw new AppError('FILE_NOT_REGISTERED');
    const job = await jobManager.createJob({ fileId: body.fileId, bitrate: body.bitrate });
    res.status(202).json({ job });
  });

  api.param('id', (req, res, next, id) => {
    if (!isValidId(id)) return next(new AppError('JOB_NOT_FOUND'));
    return next();
  });

  api.get('/jobs/:id', (req, res) => {
    res.json({ job: jobManager.getPublic(req.params.id) });
  });

  api.post('/jobs/:id/cancel', (req, res) => {
    res.json({ job: jobManager.cancel(req.params.id) });
  });

  api.delete('/jobs/:id', async (req, res) => {
    await jobManager.remove(req.params.id);
    res.status(204).end();
  });

  api.get('/about', async (req, res) => {
    res.json(await getAbout());
  });

  api.get('/licenses', (req, res) => {
    res.json({ licenses: Object.entries(LICENSE_FILES).map(([id, v]) => ({ id, title: v.title })) });
  });

  api.get('/licenses/:licenseId', async (req, res) => {
    const entry = Object.prototype.hasOwnProperty.call(LICENSE_FILES, req.params.licenseId)
      ? LICENSE_FILES[req.params.licenseId]
      : null;
    if (!entry) throw new AppError('NOT_FOUND');
    let text;
    try {
      const dir = entry.dir === 'thirdParty' ? thirdPartyDir : licensesDir;
      text = await fs.promises.readFile(path.join(dir, entry.file), 'utf8');
    } catch {
      text = entry.dir === 'thirdParty'
        ? 'File non presente in questa build: eseguire "npm run third-party" (vedi docs/LICENSE_COMPLIANCE.md).'
        : 'File di licenza non presente in questa build. Vedi resources/licenses/README.md.';
    }
    res.json({ id: req.params.licenseId, title: entry.title, text });
  });

  app.use('/api', api);

  app.use((req, res) => {
    res.status(404).json({ error: toUserError('NOT_FOUND') });
  });

  // Gestore errori: la GUI riceve SOLO codice, messaggio e suggerimento.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      if (err.status >= 500) log.error(`API ${req.method} ${req.path}: ${err.code} ${err.message}`);
      else log.info(`API ${req.method} ${req.path}: ${err.code}`);
      return res.status(err.status).json({ error: toUserError(err.code) });
    }
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      return res.status(400).json({ error: toUserError('INVALID_ARGUMENTS') });
    }
    log.error(`Errore API inatteso su ${req.method} ${req.path}:`, err);
    return res.status(500).json({ error: toUserError('INTERNAL_ERROR') });
  });

  function start({ port = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const server = app.listen(port, '127.0.0.1');
      server.once('error', reject);
      server.once('listening', () => {
        server.off('error', reject);
        const address = server.address();
        state.port = address.port;
        state.origin = `http://127.0.0.1:${address.port}`;
        state.server = server;
        server.on('connection', (socket) => {
          state.sockets.add(socket);
          socket.on('close', () => state.sockets.delete(socket));
        });
        server.on('error', (err) => log.error('Errore del server locale:', err));
        log.info(`Server locale in ascolto su ${state.origin}`);
        resolve({ port: state.port, origin: state.origin });
      });
    });
  }

  function close() {
    return new Promise((resolve) => {
      if (!state.server) return resolve();
      state.server.close(() => resolve());
      // Chiude subito anche le connessioni keep-alive inattive.
      if (typeof state.server.closeAllConnections === 'function') state.server.closeAllConnections();
      for (const socket of state.sockets) socket.destroy();
      state.server = null;
      return undefined;
    });
  }

  return { app, start, close, get origin() { return state.origin; }, get port() { return state.port; } };
}

module.exports = { createLocalServer, CONTENT_SECURITY_POLICY, LICENSE_FILES };
