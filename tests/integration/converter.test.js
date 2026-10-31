'use strict';

/**
 * Test di integrazione Node.js <-> convertitore Python.
 *
 * Usano il VERO job manager, il VERO process manager, il VERO convert.py e il
 * VERO motore multimediale (PyAV). I video di prova sono generati al momento
 * da tests/fixtures/make_media.py in una cartella temporanea: nessun file
 * multimediale è salvato nel repository.
 *
 * Requisiti: Python con PyAV (il .venv del progetto). Se mancano, i test
 * vengono SALTATI e lo dichiarano.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { JobManager } = require('../../src/main/job-manager');
const { FileRegistry } = require('../../src/main/file-registry');
const { saveResultFile } = require('../../src/main/save-result');
const { createRuntimeContext, resolveConverterExecutable } = require('../../src/main/resource-resolver');
const { parseEventLine } = require('../../src/main/process-manager');

const ROOT = path.resolve(__dirname, '..', '..');
const MAKE_MEDIA = path.join(ROOT, 'tests', 'fixtures', 'make_media.py');

function devConverter(env = {}) {
  const ctx = createRuntimeContext({ isPackaged: false, appRoot: ROOT, env: { ...process.env, ...env } });
  return resolveConverterExecutable(ctx);
}

const scriptConverter = devConverter();
const python = scriptConverter.command;
const pyavCheck = spawnSync(python, ['-c', 'import av'], { windowsHide: true });
const skipNoPyAV = pyavCheck.status === 0 ? false : 'Python con PyAV non disponibile (pip install -r src/python/requirements.txt)';

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2m-media-'));
function media(name, ...args) {
  const file = path.join(mediaDir, name);
  if (!fs.existsSync(file)) {
    const r = spawnSync(python, [MAKE_MEDIA, file, ...args], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`generazione di ${name} fallita: ${r.stderr}`);
  }
  return file;
}

async function setup(converter = scriptConverter) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v2m-int-'));
  const tempRoot = path.join(base, 'session-int');
  const registry = new FileRegistry();
  const jm = new JobManager({
    tempRoot,
    fileRegistry: registry,
    cancelTimeoutMs: 5000,
    getResources: () => ({ ready: true, converter })
  });
  await jm.init();
  return { jm, registry, base, tempRoot, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function runToEnd(jm, fileId, bitrate = 192) {
  const job = await jm.createJob({ fileId, bitrate });
  const progress = [];
  const timer = setInterval(() => progress.push(jm.getPublic(job.id).progress), 20);
  await jm.getInternal(job.id).exited;
  clearInterval(timer);
  return { id: job.id, view: jm.getPublic(job.id), progress };
}

function probeMp3(file) {
  const code = 'import av,json,sys; c=av.open(sys.argv[1]); s=c.streams.audio[0]; print(json.dumps({"codec":s.codec_context.name,"rate":s.rate,"channels":len(s.layout.channels),"bitrate":s.bit_rate,"duration":c.duration/1e6}))';
  return JSON.parse(spawnSync(python, ['-c', code, file], { encoding: 'utf8', windowsHide: true }).stdout);
}

test('conversione reale MP4/AAC con nome Unicode: progresso, salvataggio, cleanup', { skip: skipNoPyAV, timeout: 120000 }, async () => {
  const video = media('vidéo di prova 日本.mp4', '--seconds', '8');
  const { jm, registry, base, tempRoot, cleanup } = await setup();
  const { fileId } = await registry.register(video);
  const { id, view, progress } = await runToEnd(jm, fileId, 320);
  assert.equal(view.state, 'completed', JSON.stringify(view.error));
  assert.equal(view.progress, 100);
  assert.ok(Math.abs(view.durationSeconds - 8) < 0.2, `durata ${view.durationSeconds}`);
  assert.equal(view.audioCodec, 'aac');
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b), 'avanzamento monotono');

  const { outputPath } = jm.getResultForSave(id);
  const info = probeMp3(outputPath);
  assert.equal(info.codec.startsWith('mp3'), true);
  assert.equal(info.rate, 48000);
  assert.equal(info.channels, 2);
  assert.ok(Math.abs(info.duration - 8) < 0.3);

  const dest = path.join(base, 'risultato finale è.mp3');
  const saved = await saveResultFile(outputPath, dest);
  assert.equal(saved.size, view.outputSize);
  await jm.markSaved(id);
  assert.ok(!fs.existsSync(path.join(tempRoot, id)), 'temporanei eliminati');
  cleanup();
});

test('bitrate diversi producono file di dimensione proporzionale', { skip: skipNoPyAV, timeout: 120000 }, async () => {
  const video = media('bitrate.mp4', '--seconds', '10');
  const { jm, registry, cleanup } = await setup();
  const sizes = {};
  for (const kbps of [128, 192, 256, 320]) {
    const { fileId } = await registry.register(video);
    const { view } = await runToEnd(jm, fileId, kbps);
    assert.equal(view.state, 'completed');
    sizes[kbps] = view.outputSize;
  }
  // CBR: dimensione ≈ bitrate × durata / 8 (tolleranza per intestazioni e padding)
  for (const kbps of [128, 192, 256, 320]) {
    const expected = (kbps * 1000 * 10) / 8;
    assert.ok(Math.abs(sizes[kbps] - expected) / expected < 0.08, `${kbps} kbps: ${sizes[kbps]} vs ${expected}`);
  }
  cleanup();
});

test('MKV con FLAC a 96 kHz mono: ricampionato a 48 kHz mono', { skip: skipNoPyAV, timeout: 120000 }, async () => {
  const video = media('mono 96k.mkv', '--seconds', '4', '--rate', '96000', '--channels', '1');
  const { jm, registry, cleanup } = await setup();
  const { id, view } = await runToEnd(jm, (await registry.register(video)).fileId, 128);
  assert.equal(view.state, 'completed', JSON.stringify(view.error));
  assert.equal(view.audioCodec, 'flac');
  const info = probeMp3(jm.getResultForSave(id).outputPath);
  assert.equal(info.rate, 48000);
  assert.equal(info.channels, 1);
  cleanup();
});

test('AVI con audio MP3', { skip: skipNoPyAV, timeout: 120000 }, async () => {
  const { jm, registry, cleanup } = await setup();
  const { view } = await runToEnd(jm, (await registry.register(media('clip.avi', '--seconds', '3'))).fileId);
  assert.equal(view.state, 'completed', JSON.stringify(view.error));
  cleanup();
});

test('video senza audio -> NO_AUDIO_STREAM', { skip: skipNoPyAV, timeout: 60000 }, async () => {
  const { jm, registry, tempRoot, cleanup } = await setup();
  const { id, view } = await runToEnd(jm, (await registry.register(media('muto.mp4', '--seconds', '2', '--no-audio'))).fileId);
  assert.equal(view.state, 'failed');
  assert.equal(view.error.code, 'NO_AUDIO_STREAM');
  assert.ok(!fs.existsSync(path.join(tempRoot, id)));
  cleanup();
});

test('file danneggiato -> INVALID_MEDIA', { skip: skipNoPyAV, timeout: 60000 }, async () => {
  const { jm, registry, cleanup } = await setup();
  const { view } = await runToEnd(jm, (await registry.register(media('rotto.mp4', '--corrupted'))).fileId);
  assert.equal(view.error.code, 'INVALID_MEDIA');
  cleanup();
});

test('eseguibile Python mancante -> CONVERTER_NOT_FOUND', { timeout: 30000 }, async () => {
  const fake = path.join(mediaDir, 'finto.mp4');
  fs.writeFileSync(fake, 'x');
  const { jm, registry, cleanup } = await setup({ kind: 'compiled', command: path.join(os.tmpdir(), 'v2m-non-esiste', 'converter'), args: [] });
  const { view } = await runToEnd(jm, (await registry.register(fake)).fileId);
  assert.equal(view.error.code, 'CONVERTER_NOT_FOUND');
  cleanup();
});

async function cancelScenario(converter) {
  // 30 minuti di audio: la conversione dura alcuni secondi, abbastanza per annullarla.
  const video = media('lungo.mkv', '--seconds', '1800', '--rate', '16000', '--channels', '1');
  const { jm, registry, tempRoot, cleanup } = await setup(converter);
  const job = await jm.createJob({ fileId: (await registry.register(video)).fileId, bitrate: 320 });
  const deadline = Date.now() + 30000;
  while (jm.getPublic(job.id).progress === 0) {
    if (Date.now() > deadline || jm.getPublic(job.id).state === 'failed') throw new Error(JSON.stringify(jm.getPublic(job.id)));
    await new Promise((r) => setTimeout(r, 10));
  }
  const cancelledAt = Date.now();
  jm.cancel(job.id);
  await jm.getInternal(job.id).exited;
  const view = jm.getPublic(job.id);
  assert.equal(view.state, 'cancelled');
  assert.ok(Date.now() - cancelledAt < 5000, 'l\'annullamento deve essere rapido');
  assert.ok(!fs.existsSync(path.join(tempRoot, job.id)), 'nessun file parziale residuo');
  cleanup();
}

test('annullamento durante la conversione', { skip: skipNoPyAV, timeout: 120000 }, () => cancelScenario(scriptConverter));

test('chiusura dell\'app durante la conversione (graceful shutdown)', { skip: skipNoPyAV, timeout: 120000 }, async () => {
  const video = media('lungo.mkv', '--seconds', '1800', '--rate', '16000', '--channels', '1');
  const { jm, registry, tempRoot, cleanup } = await setup();
  const job = await jm.createJob({ fileId: (await registry.register(video)).fileId, bitrate: 320 });
  const deadline = Date.now() + 30000;
  while (jm.getPublic(job.id).progress === 0) {
    if (Date.now() > deadline || jm.getPublic(job.id).state === 'failed') throw new Error(JSON.stringify(jm.getPublic(job.id)));
    await new Promise((r) => setTimeout(r, 10));
  }
  await jm.shutdown({ timeoutMs: 8000 });
  assert.equal(jm.getInternal(job.id), null);
  assert.ok(!fs.existsSync(tempRoot));
  cleanup();
});

// --- Eseguibile PyInstaller (se già compilato con npm run build:python) ---
const builtConverter = devConverter({ VIDEO2MP3_USE_BUILT_CONVERTER: '1' });
const skipNoBuilt = !fs.existsSync(builtConverter.command) ? 'convertitore PyInstaller non compilato (npm run build:python)' : false;

test('eseguibile PyInstaller: --version riporta PyAV e libmp3lame', { skip: skipNoBuilt, timeout: 60000 }, () => {
  const r = spawnSync(builtConverter.command, ['--version'], { encoding: 'utf8', windowsHide: true });
  const parsed = parseEventLine(r.stdout.trim());
  assert.ok(parsed.ok);
  assert.equal(parsed.event.frozen, true);
  assert.equal(parsed.event.engine.available, true);
  assert.equal(parsed.event.engine.libmp3lame, true);
});

test('eseguibile PyInstaller: conversione reale', { skip: skipNoPyAV || skipNoBuilt, timeout: 120000 }, async () => {
  const { jm, registry, cleanup } = await setup(builtConverter);
  const { view } = await runToEnd(jm, (await registry.register(media('per-exe.mp4', '--seconds', '5'))).fileId, 128);
  assert.equal(view.state, 'completed', JSON.stringify(view.error));
  cleanup();
});

test('eseguibile PyInstaller: annullamento', { skip: skipNoPyAV || skipNoBuilt, timeout: 120000 }, () => cancelScenario(builtConverter));

test.after(() => {
  fs.rmSync(mediaDir, { recursive: true, force: true });
});
