'use strict';

/** Test di logger, registro file, catalogo errori e utilità di verifica dei binari. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Logger, createSanitizer } = require('../../src/main/logger');
const { FileRegistry } = require('../../src/main/file-registry');
const { toUserError, AppError, CATALOG } = require('../../src/main/errors');
const { classifyLicense } = require('../../src/main/license-classifier');

test('logger: sanitizza home e nome utente', () => {
  const sanitize = createSanitizer({ homeDir: 'C:\\Users\\mario.rossi', userName: 'mario.rossi' });
  assert.equal(sanitize('file C:\\Users\\mario.rossi\\Video\\a.mp4'), 'file ~\\Video\\a.mp4');
  assert.equal(sanitize('C:/Users/mario.rossi/x'), '~/x');
  assert.equal(sanitize('utente mario.rossi connesso'), 'utente <utente> connesso');
  // Nomi brevi 8.3 di Windows e home di altri utenti
  assert.equal(sanitize('mancante: C:\\Users\\MARIO~1.ROS\\AppData\\x.exe'), 'mancante: ~\\AppData\\x.exe');
  assert.equal(sanitize('file /home/altro/Video/a.mp4'), 'file ~/Video/a.mp4');
  assert.equal(sanitize('"/Users/anna/Movies/b.mov"'), '"~/Movies/b.mov"');
});

test('logger: livelli, rotazione e limite dimensionale', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2m-log-'));
  const logger = new Logger({ dir, maxBytes: 300, maxFiles: 3, console: false });
  logger.debug('non registrato (debug disattivo)');
  for (let i = 0; i < 30; i += 1) logger.info(`riga di log numero ${i}`);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['app.1.log', 'app.2.log', 'app.log']);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size < 400);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'app.log'), 'utf8'), /non registrato/);
  assert.equal(logger.tail(2).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('registro file: accetta solo file video esistenti, restituisce un ID opaco', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2m-reg-'));
  const reg = new FileRegistry();
  const video = path.join(dir, 'film con spazi è.MKV');
  fs.writeFileSync(video, 'x');
  const info = await reg.register(video);
  assert.equal(info.name, 'film con spazi è.MKV');
  assert.equal(info.size, 1);
  assert.ok(!JSON.stringify(info).includes(dir), 'nessun percorso restituito');
  assert.equal(reg.get(info.fileId).path, path.normalize(video));
  assert.equal(reg.get('non-uuid'), null);

  fs.writeFileSync(path.join(dir, 'vuoto.mp4'), '');
  fs.writeFileSync(path.join(dir, 'doc.pdf'), 'x');
  fs.mkdirSync(path.join(dir, 'cartella.mp4'));
  await assert.rejects(reg.register(path.join(dir, 'vuoto.mp4')), (e) => e.code === 'EMPTY_FILE');
  await assert.rejects(reg.register(path.join(dir, 'doc.pdf')), (e) => e.code === 'UNSUPPORTED_FILE');
  await assert.rejects(reg.register(path.join(dir, 'cartella.mp4')), (e) => e.code === 'UNSUPPORTED_FILE');
  await assert.rejects(reg.register(path.join(dir, 'manca.mp4')), (e) => e.code === 'INPUT_NOT_FOUND');
  await assert.rejects(reg.register('relativo.mp4'), (e) => e.code === 'INVALID_ARGUMENTS');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('catalogo errori: ogni voce ha messaggio, suggerimento e stato HTTP', () => {
  for (const [code, entry] of Object.entries(CATALOG)) {
    assert.ok(entry.message.length > 5, code);
    assert.ok(typeof entry.hint === 'string', code);
    assert.ok(entry.status >= 400 && entry.status < 600, code);
  }
  assert.equal(toUserError('NON_ESISTE').code, 'INTERNAL_ERROR');
  assert.equal(new AppError('NON_ESISTE').code, 'INTERNAL_ERROR');
  const userError = toUserError('NO_AUDIO_STREAM');
  assert.deepEqual(Object.keys(userError).sort(), ['code', 'hint', 'message']);
});

test('classificazione della licenza delle librerie FFmpeg', () => {
  assert.equal(classifyLicense('--enable-libmp3lame --disable-debug').classification, 'LGPL-2.1-or-later');
  assert.equal(classifyLicense('--enable-version3 --enable-libmp3lame').classification, 'LGPL-3.0-or-later');
  assert.equal(classifyLicense('--enable-gpl --enable-libx264').classification, 'GPL-2.0-or-later');
  assert.equal(classifyLicense('--enable-gpl --enable-version3').classification, 'GPL-3.0-or-later');
  const nonfree = classifyLicense('--enable-gpl --enable-nonfree --enable-libfdk-aac');
  assert.equal(nonfree.classification, 'NONFREE');
  assert.equal(nonfree.distributable, false);
  assert.equal(classifyLicense('--enable-libfdk-aac').distributable, false);
});

test('licenza dichiarata LGPL ma librerie GPL incluse (caso dei wheel PyAV) -> GPL', () => {
  const pyavConfig = '--enable-shared --enable-version3 --enable-libmp3lame --enable-libopus --enable-libx265 --enable-libx264 --enable-libvpx';
  const lic = classifyLicense(pyavConfig, 'LGPL version 3 or later');
  assert.equal(lic.classification, 'GPL-3.0-or-later');
  assert.equal(lic.distributable, true);
  assert.deepEqual(lic.gplLibraries, ['libx264', 'libx265']);
  assert.match(lic.note, /LGPL version 3 or later/);
});
