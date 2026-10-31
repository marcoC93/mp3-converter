'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createLocalServer } = require('../../src/main/express-server');
const { AppError } = require('../../src/main/errors');

const TOKEN = 'a'.repeat(43);
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const FILE_ID = '44444444-4444-4444-8444-444444444444';

function fakeJobManager() {
  const calls = [];
  return {
    calls,
    async createJob(body) {
      calls.push(['create', body]);
      if (body.bitrate === 999) throw new AppError('INVALID_BITRATE');
      return { id: JOB_ID, state: 'queued', progress: 0 };
    },
    getPublic(id) {
      if (id !== JOB_ID) throw new AppError('JOB_NOT_FOUND');
      return { id, state: 'converting', progress: 10 };
    },
    cancel(id) {
      if (id !== JOB_ID) throw new AppError('JOB_NOT_FOUND');
      return { id, state: 'cancelling' };
    },
    async remove(id) {
      if (id !== JOB_ID) throw new AppError('JOB_NOT_FOUND');
    }
  };
}

// Chiusura garantita anche se un'asserzione fallisce: un server lasciato
// aperto impedirebbe al processo di test di terminare.
const openServers = [];
test.afterEach(async () => {
  while (openServers.length) await openServers.pop().close();
});

async function startServer() {
  const jobManager = fakeJobManager();
  const server = createLocalServer({
    jobManager,
    rendererDir: path.resolve(__dirname, '..', '..', 'src', 'renderer'),
    licensesDir: path.resolve(__dirname, '..', '..', 'resources', 'licenses'),
    thirdPartyDir: path.join(os.tmpdir(), 'v2m-third-party-assente'),
    token: TOKEN,
    getResourceStatus: () => ({ ready: false, problems: [{ component: 'engine', code: 'MEDIA_ENGINE_MISSING', detail: '/percorso/segreto' }] }),
    getAbout: async () => ({ name: 'Video to MP3' })
  });
  const { port } = await server.start();
  openServers.push(server);
  return { server, port, jobManager };
}

/** Richiesta HTTP grezza: permette di impostare Host e Origin a piacere. */
function request(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: { host: `127.0.0.1:${port}`, ...headers }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* non JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };
const jsonAuth = { ...auth, 'content-type': 'application/json' };

test('ascolta solo su 127.0.0.1 con porta effimera', async () => {
  const { server, port } = await startServer();
  assert.ok(port > 0);
  assert.equal(server.origin, `http://127.0.0.1:${port}`);
  await server.close();
});

test('serve la GUI con CSP restrittiva e senza directory listing', async () => {
  const { server, port } = await startServer();
  const index = await request(port);
  assert.equal(index.status, 200);
  assert.match(index.text, /<title>Video to MP3<\/title>/);
  assert.match(index.headers['content-security-policy'], /default-src 'none'/);
  assert.match(index.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['x-powered-by'], undefined);
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/api/', '/main/main.js', '/.hidden']) {
    const res = await request(port, { pathname: p });
    assert.ok([401, 403, 404].includes(res.status), `${p} -> ${res.status}`);
    assert.doesNotMatch(res.text, /"dependencies"/);
  }
  await server.close();
});

test('protezione API: Host, Origin e token', async () => {
  const { server, port } = await startServer();
  const wrongHost = await request(port, { pathname: '/api/config', headers: { ...auth, host: 'evil.example:80' } });
  assert.equal(wrongHost.status, 403);
  const wrongOrigin = await request(port, { pathname: '/api/config', headers: { ...auth, origin: 'https://evil.example' } });
  assert.equal(wrongOrigin.status, 403);
  const noToken = await request(port, { pathname: '/api/config' });
  assert.equal(noToken.status, 401);
  const badToken = await request(port, { pathname: '/api/config', headers: { authorization: `Bearer ${'b'.repeat(43)}` } });
  assert.equal(badToken.status, 401);
  const tokenInQuery = await request(port, { pathname: `/api/config?token=${TOKEN}` });
  assert.equal(tokenInQuery.status, 401);
  const ok = await request(port, { pathname: '/api/config', headers: { ...auth, origin: `http://127.0.0.1:${port}` } });
  assert.equal(ok.status, 200);
  await server.close();
});

test('config: qualità ammesse e problemi senza percorsi fisici', async () => {
  const { server, port } = await startServer();
  const res = await request(port, { pathname: '/api/config', headers: auth });
  assert.deepEqual(res.json.qualities.map((q) => q.bitrate), [128, 192, 256, 320]);
  assert.equal(res.json.defaultBitrate, 192);
  assert.equal(res.json.resources.ready, false);
  assert.equal(res.json.resources.problems[0].code, 'MEDIA_ENGINE_MISSING');
  assert.doesNotMatch(res.text, /percorso\/segreto/);
  await server.close();
});

test('creazione job: validazione del corpo della richiesta', async () => {
  const { server, port, jobManager } = await startServer();
  const ok = await request(port, { method: 'POST', pathname: '/api/jobs', headers: jsonAuth, body: { fileId: FILE_ID, bitrate: 192 } });
  assert.equal(ok.status, 202);
  assert.equal(ok.json.job.id, JOB_ID);

  const extra = await request(port, { method: 'POST', pathname: '/api/jobs', headers: jsonAuth, body: { fileId: FILE_ID, bitrate: 192, path: 'C:\\Windows' } });
  assert.equal(extra.status, 400);
  assert.equal(extra.json.error.code, 'INVALID_ARGUMENTS');

  const badId = await request(port, { method: 'POST', pathname: '/api/jobs', headers: jsonAuth, body: { fileId: '/etc/passwd', bitrate: 192 } });
  assert.equal(badId.json.error.code, 'FILE_NOT_REGISTERED');

  const badBitrate = await request(port, { method: 'POST', pathname: '/api/jobs', headers: jsonAuth, body: { fileId: FILE_ID, bitrate: 999 } });
  assert.equal(badBitrate.status, 400);
  assert.equal(badBitrate.json.error.code, 'INVALID_BITRATE');

  const malformed = await request(port, { method: 'POST', pathname: '/api/jobs', headers: jsonAuth, body: '{non json' });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(malformed.text, /at .*\.js/, 'nessuno stack trace');

  const tooBig = await request(port, { method: 'POST', pathname: '/api/jobs', headers: jsonAuth, body: { fileId: 'x'.repeat(20000) } });
  assert.equal(tooBig.status, 400);

  assert.equal(jobManager.calls.length, 2);
  await server.close();
});

test('job inesistente o ID non valido -> 404 JOB_NOT_FOUND', async () => {
  const { server, port } = await startServer();
  for (const p of ['/api/jobs/55555555-5555-4555-8555-555555555555', '/api/jobs/not-a-uuid', '/api/jobs/..%2F..%2Fetc']) {
    const res = await request(port, { pathname: p, headers: auth });
    assert.equal(res.status, 404, p);
    assert.equal(res.json.error.code, 'JOB_NOT_FOUND', p);
  }
  const cancel = await request(port, { method: 'POST', pathname: '/api/jobs/55555555-5555-4555-8555-555555555555/cancel', headers: auth });
  assert.equal(cancel.status, 404);
  const del = await request(port, { method: 'DELETE', pathname: `/api/jobs/${JOB_ID}`, headers: auth });
  assert.equal(del.status, 204);
  await server.close();
});

test('licenze: solo file dell\'allowlist', async () => {
  const { server, port } = await startServer();
  const list = await request(port, { pathname: '/api/licenses', headers: auth });
  assert.deepEqual(list.json.licenses.map((l) => l.id), ['notices', 'converter', 'sources', 'app']);
  const notices = await request(port, { pathname: '/api/licenses/notices', headers: auth });
  assert.match(notices.json.text, /FFmpeg/);
  assert.match(notices.json.text, /PyAV/);
  // Licenze del convertitore non ancora generate: messaggio chiaro, nessun percorso fisico.
  const converter = await request(port, { pathname: '/api/licenses/converter', headers: auth });
  assert.equal(converter.status, 200);
  assert.match(converter.json.text, /npm run third-party/);
  assert.doesNotMatch(converter.text, /v2m-third-party-assente/);
  const other = await request(port, { pathname: '/api/licenses/..%2F..%2Fpackage.json', headers: auth });
  assert.equal(other.status, 404);
  const proto = await request(port, { pathname: '/api/licenses/__proto__', headers: auth });
  assert.equal(proto.status, 404);
  await server.close();
});

test('close() termina il server e rifiuta nuove connessioni', async () => {
  const { server, port } = await startServer();
  await request(port, { pathname: '/', headers: { connection: 'keep-alive' } });
  await server.close();
  await assert.rejects(request(port));
});

test('token troppo corto rifiutato in costruzione', () => {
  assert.throws(() => createLocalServer({ token: 'corto' }));
});
