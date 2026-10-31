'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobManager, cleanupStaleSessions } = require('../../src/main/job-manager');
const { AppError } = require('../../src/main/errors');

/** Processo finto controllabile dal test. */
class FakeProcess extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.cancelled = false;
    this.killed = false;
    this.ignoreCancel = false;
  }
  start() { this.started = true; return this; }
  cancel() {
    this.cancelled = true;
    if (!this.ignoreCancel) setImmediate(() => this.exit(130));
  }
  forceKill() { this.killed = true; setImmediate(() => this.exit(null, 'SIGKILL')); }
  send(event) { this.emit('event', event); }
  exit(code, signal = null, spawnError = null) {
    if (this.done) return;
    this.done = true;
    this.emit('exit', { code, signal, spawnError });
  }
  arg(name) {
    const i = this.opts.args.indexOf(name);
    return i >= 0 ? this.opts.args[i + 1] : undefined;
  }
}

async function setup({ ready = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v2m-jm-'));
  const tempRoot = path.join(base, 'session-test');
  const inputPath = path.join(base, 'video di prova.mp4');
  fs.writeFileSync(inputPath, 'dati');
  const fileId = '11111111-1111-4111-8111-111111111111';
  const fileRegistry = { get: (id) => (id === fileId ? { fileId, path: inputPath, name: 'video di prova.mp4', size: 4 } : null) };
  const processes = [];
  const jm = new JobManager({
    tempRoot,
    fileRegistry,
    getResources: () => ({
      ready,
      converter: { command: 'python3', args: ['-u', 'convert.py'] }
    }),
    createProcess: (opts) => {
      const p = new FakeProcess(opts);
      processes.push(p);
      return p;
    }
  });
  await jm.init();
  return { jm, base, tempRoot, fileId, processes, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const waitExit = (jm, id) => jm.getInternal(id).exited;

test('createJob: validazione di bitrate, file e risorse', async () => {
  const { jm, fileId, cleanup } = await setup();
  await assert.rejects(jm.createJob({ fileId, bitrate: 999 }), (e) => e instanceof AppError && e.code === 'INVALID_BITRATE');
  await assert.rejects(jm.createJob({ fileId: 'nope', bitrate: 192 }), (e) => e.code === 'FILE_NOT_REGISTERED');
  cleanup();

  const notReady = await setup({ ready: false });
  await assert.rejects(notReady.jm.createJob({ fileId: notReady.fileId, bitrate: 192 }), (e) => e.code === 'RESOURCES_NOT_READY');
  notReady.cleanup();
});

test('createJob: argomenti del convertitore, ID casuale e cartella dedicata', async () => {
  const { jm, fileId, processes, tempRoot, cleanup } = await setup();
  const job = await jm.createJob({ fileId, bitrate: '256' });
  assert.match(job.id, /^[0-9a-f-]{36}$/);
  assert.equal(job.state, 'queued');
  assert.equal(job.bitrate, 256);
  const p = processes[0];
  assert.equal(p.opts.command, 'python3');
  assert.equal(p.arg('--bitrate'), '256');
  assert.equal(p.arg('--output'), path.join(tempRoot, job.id, 'output.mp3'));
  assert.ok(p.opts.args.includes('--control-stdin'));
  assert.ok(fs.existsSync(path.join(tempRoot, job.id)));
  // La vista pubblica non contiene percorsi.
  assert.ok(!JSON.stringify(job).includes(tempRoot));
  assert.ok(!('inputPath' in job) && !('outputPath' in job) && !('dir' in job));
  p.exit(1);
  await waitExit(jm, job.id);
  cleanup();
});

test('un solo job attivo alla volta', async () => {
  const { jm, fileId, processes, cleanup } = await setup();
  const job = await jm.createJob({ fileId, bitrate: 192 });
  await assert.rejects(jm.createJob({ fileId, bitrate: 192 }), (e) => e.code === 'JOB_ALREADY_RUNNING');
  processes[0].exit(1);
  await waitExit(jm, job.id);
  cleanup();
});

test('ciclo completo: stati, progresso, completamento e salvataggio', async () => {
  const { jm, fileId, processes, cleanup } = await setup();
  const job = await jm.createJob({ fileId, bitrate: 192 });
  const p = processes[0];
  p.send({ type: 'status', status: 'analyzing', message: '' });
  assert.equal(jm.getPublic(job.id).state, 'analyzing');
  p.send({ type: 'probe', durationSeconds: 120, audioCodec: 'aac', container: 'mp4', hasVideo: true });
  p.send({ type: 'status', status: 'converting', message: '' });
  p.send({ type: 'progress', progress: 42.5, processedSeconds: 51 });
  p.send({ type: 'progress', progress: 40, processedSeconds: 48 }); // non deve tornare indietro
  let view = jm.getPublic(job.id);
  assert.equal(view.state, 'converting');
  assert.equal(view.progress, 42.5);
  assert.equal(view.durationSeconds, 120);

  fs.writeFileSync(p.arg('--output'), Buffer.alloc(2048));
  p.send({ type: 'completed', outputPath: p.arg('--output') });
  p.exit(0);
  await waitExit(jm, job.id);
  view = jm.getPublic(job.id);
  assert.equal(view.state, 'completed');
  assert.equal(view.progress, 100);
  assert.equal(view.outputSize, 2048);

  const result = jm.getResultForSave(job.id);
  assert.equal(result.originalName, 'video di prova.mp4');
  await jm.markSaved(job.id);
  assert.ok(!fs.existsSync(path.dirname(result.outputPath)), 'la cartella temporanea del job deve essere eliminata');
  assert.throws(() => jm.getResultForSave(job.id), (e) => e.code === 'JOB_NOT_COMPLETED');
  cleanup();
});

test('completed con percorso diverso da quello richiesto -> PROTOCOL_ERROR', async () => {
  const { jm, fileId, processes, cleanup } = await setup();
  const job = await jm.createJob({ fileId, bitrate: 192 });
  processes[0].send({ type: 'completed', outputPath: path.join(os.tmpdir(), 'altrove.mp3') });
  processes[0].exit(0);
  await waitExit(jm, job.id);
  assert.equal(jm.getPublic(job.id).error.code, 'PROTOCOL_ERROR');
  cleanup();
});

test('uscita 0 senza completed e crash inatteso', async () => {
  const a = await setup();
  const j1 = await a.jm.createJob({ fileId: a.fileId, bitrate: 192 });
  a.processes[0].exit(0);
  await waitExit(a.jm, j1.id);
  assert.equal(a.jm.getPublic(j1.id).error.code, 'PROTOCOL_ERROR');
  const j2 = await a.jm.createJob({ fileId: a.fileId, bitrate: 192 });
  a.processes[1].exit(null, 'SIGSEGV');
  await waitExit(a.jm, j2.id);
  const view = a.jm.getPublic(j2.id);
  assert.equal(view.state, 'failed');
  assert.equal(view.error.code, 'PROCESS_CRASHED');
  assert.ok(view.error.message && view.error.hint, 'messaggio comprensibile e suggerimento');
  a.cleanup();
});

test('errore dal convertitore: file senza audio e codice sconosciuto', async () => {
  const { jm, fileId, processes, tempRoot, cleanup } = await setup();
  const job = await jm.createJob({ fileId, bitrate: 192 });
  processes[0].send({ type: 'error', code: 'NO_AUDIO_STREAM', message: 'Il file non contiene una traccia audio' });
  processes[0].exit(5);
  await waitExit(jm, job.id);
  const view = jm.getPublic(job.id);
  assert.equal(view.error.code, 'NO_AUDIO_STREAM');
  assert.match(view.error.message, /traccia audio/);
  assert.ok(!fs.existsSync(path.join(tempRoot, job.id)), 'cleanup dopo errore');

  const job2 = await jm.createJob({ fileId, bitrate: 192 });
  processes[1].send({ type: 'error', code: 'CODICE_INVENTATO', message: 'x' });
  processes[1].exit(1);
  await waitExit(jm, job2.id);
  assert.equal(jm.getPublic(job2.id).error.code, 'INTERNAL_ERROR');
  cleanup();
});

test('avvio del convertitore fallito', async () => {
  const { jm, fileId, processes, cleanup } = await setup();
  const job = await jm.createJob({ fileId, bitrate: 192 });
  processes[0].exit(null, null, 'CONVERTER_NOT_FOUND');
  await waitExit(jm, job.id);
  assert.equal(jm.getPublic(job.id).error.code, 'CONVERTER_NOT_FOUND');
  cleanup();
});

test('annullamento: stato cancelling -> cancelled e cleanup', async () => {
  const { jm, fileId, processes, tempRoot, cleanup } = await setup();
  const job = await jm.createJob({ fileId, bitrate: 192 });
  processes[0].send({ type: 'status', status: 'converting', message: '' });
  const view = jm.cancel(job.id);
  assert.equal(view.state, 'cancelling');
  assert.ok(processes[0].cancelled);
  // Eventi tardivi non riportano il job in "converting".
  processes[0].send({ type: 'status', status: 'converting', message: '' });
  assert.equal(jm.getPublic(job.id).state, 'cancelling');
  await waitExit(jm, job.id);
  assert.equal(jm.getPublic(job.id).state, 'cancelled');
  assert.equal(jm.getPublic(job.id).error.code, 'CONVERSION_CANCELLED');
  assert.ok(!fs.existsSync(path.join(tempRoot, job.id)));
  assert.equal(jm.hasActiveJob(), false);
  cleanup();
});

test('job inesistente', async () => {
  const { jm, cleanup } = await setup();
  const missing = '22222222-2222-4222-8222-222222222222';
  assert.throws(() => jm.getPublic(missing), (e) => e.code === 'JOB_NOT_FOUND');
  assert.throws(() => jm.cancel(missing), (e) => e.code === 'JOB_NOT_FOUND');
  assert.throws(() => jm.getPublic('../../etc'), (e) => e.code === 'JOB_NOT_FOUND');
  await assert.rejects(jm.remove(missing), (e) => e.code === 'JOB_NOT_FOUND');
  assert.throws(() => jm.getResultForSave(missing), (e) => e.code === 'JOB_NOT_FOUND');
  cleanup();
});

test('remove di un job attivo: annulla, attende e pulisce', async () => {
  const { jm, fileId, processes, tempRoot, cleanup } = await setup();
  const job = await jm.createJob({ fileId, bitrate: 192 });
  await jm.remove(job.id);
  assert.ok(processes[0].cancelled);
  assert.ok(!fs.existsSync(path.join(tempRoot, job.id)));
  assert.throws(() => jm.getPublic(job.id), (e) => e.code === 'JOB_NOT_FOUND');
  cleanup();
});

test('graceful shutdown: annulla i job, rimuove la cartella temporanea, rifiuta nuovi job', async () => {
  const { jm, fileId, processes, tempRoot, cleanup } = await setup();
  await jm.createJob({ fileId, bitrate: 192 });
  await jm.shutdown({ timeoutMs: 2000 });
  assert.ok(processes[0].cancelled);
  assert.ok(!fs.existsSync(tempRoot));
  await assert.rejects(jm.createJob({ fileId, bitrate: 192 }), (e) => e.code === 'SHUTTING_DOWN');
  cleanup();
});

test('graceful shutdown: processo che non risponde viene terminato forzatamente', async () => {
  const { jm, fileId, processes, cleanup } = await setup();
  const job = await jm.createJob({ fileId, bitrate: 192 });
  processes[0].ignoreCancel = true;
  const started = Date.now();
  await jm.shutdown({ timeoutMs: 200 });
  assert.ok(processes[0].killed, 'forceKill deve essere chiamato');
  assert.ok(Date.now() - started < 2000);
  await job; // nessuna eccezione pendente
  cleanup();
});

test('cleanup: rifiuta cartelle fuori dalla radice temporanea', async () => {
  const { jm, base, cleanup } = await setup();
  const outside = path.join(base, 'non-toccare');
  fs.mkdirSync(outside);
  await jm.cleanupJobDir({ id: 'x', dir: outside });
  assert.ok(fs.existsSync(outside));
  cleanup();
});

test('cleanupStaleSessions rimuove solo le sessioni precedenti', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v2m-stale-'));
  const current = path.join(base, 'session-current');
  for (const d of ['session-old1', 'session-old2', 'session-current', 'altro']) fs.mkdirSync(path.join(base, d));
  const removed = await cleanupStaleSessions(base, current);
  assert.equal(removed, 2);
  assert.deepEqual(fs.readdirSync(base).sort(), ['altro', 'session-current']);
  fs.rmSync(base, { recursive: true, force: true });
});
