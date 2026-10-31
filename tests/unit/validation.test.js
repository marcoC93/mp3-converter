'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const v = require('../../src/main/validation');

test('bitrate: accetta solo i valori dell\'allowlist', () => {
  for (const ok of [128, 192, 256, 320, '128', '320']) assert.equal(v.parseBitrate(ok), Number(ok));
  for (const bad of [0, 64, 191, 193, 1000, '192k', ' 192', '1e2', 192.5, null, undefined, {}, [], '']) {
    assert.equal(v.parseBitrate(bad), null, `dovrebbe rifiutare ${JSON.stringify(bad)}`);
  }
  assert.equal(v.DEFAULT_BITRATE, 192);
  assert.deepEqual(v.QUALITY_OPTIONS.map((q) => q.bitrate), [128, 192, 256, 320]);
});

test('job ID: solo UUID v4 minuscoli', () => {
  assert.ok(v.isValidId('3f2504e0-4f89-41d3-9a0c-0305e82c3301'));
  assert.ok(!v.isValidId('3F2504E0-4F89-41D3-9A0C-0305E82C3301'));
  assert.ok(!v.isValidId('../../etc/passwd'));
  assert.ok(!v.isValidId('3f2504e0-4f89-11d3-9a0c-0305e82c3301')); // versione 1
  assert.ok(!v.isValidId(42));
  assert.ok(v.isValidId(require('node:crypto').randomUUID()));
});

test('estensioni supportate, senza distinzione maiuscole/minuscole', () => {
  for (const name of ['a.mp4', 'b.MOV', 'c.mkv', 'd.avi', 'e.webm', 'f.mpeg', 'g.mpg', 'h.m4v', 'i.flv', 'j.WMV']) {
    assert.ok(v.hasSupportedExtension(name), name);
  }
  for (const name of ['a.mp3', 'b.exe', 'c', 'd.mp4.exe', '.mp4x']) assert.ok(!v.hasSupportedExtension(name), name);
});

test('percorsi: plausibilità e contenimento', () => {
  const abs = path.resolve('video.mp4');
  assert.ok(v.isPlausibleAbsolutePath(abs));
  assert.ok(!v.isPlausibleAbsolutePath('relativo/video.mp4'));
  assert.ok(!v.isPlausibleAbsolutePath(`${abs}\0.txt`));
  assert.ok(!v.isPlausibleAbsolutePath('x'.repeat(40000)));
  assert.ok(!v.isPlausibleAbsolutePath(123));

  const root = path.resolve('tmp-root');
  assert.ok(v.isInside(root, path.join(root, 'job', 'output.mp3')));
  assert.ok(!v.isInside(root, root));
  assert.ok(!v.isInside(root, path.join(root, '..', 'altro')));
  assert.ok(!v.isInside(root, path.resolve('tmp-root-bis')));
});

test('isInside funziona con semantica Windows e POSIX', () => {
  assert.ok(v.isInside('C:\\tmp\\app', 'C:\\tmp\\app\\x', path.win32));
  assert.ok(!v.isInside('C:\\tmp\\app', 'D:\\tmp\\app\\x', path.win32));
  assert.ok(v.isInside('/tmp/app', '/tmp/app/x', path.posix));
  assert.ok(!v.isInside('/tmp/app', '/tmp/app/../etc', path.posix));
});

test('nome MP3 suggerito: conserva Unicode e spazi, rimuove caratteri non validi', () => {
  assert.equal(v.suggestMp3Name('Vacanze al mare.mkv'), 'Vacanze al mare.mp3');
  assert.equal(v.suggestMp3Name('Città — è ü 日本.mp4'), 'Città — è ü 日本.mp3');
  assert.equal(v.suggestMp3Name('a<b>c:d"e|f?g*.mov'), 'a_b_c_d_e_f_g_.mp3');
  assert.equal(v.suggestMp3Name('CON.mp4'), 'audio.mp3');
  assert.equal(v.suggestMp3Name('...'), 'audio.mp3');
  assert.equal(v.suggestMp3Name(''), 'audio.mp3');
  assert.ok(v.suggestMp3Name(`${'x'.repeat(500)}.mp4`).length <= 184);
});

test('estensione .mp3 garantita', () => {
  assert.equal(v.ensureMp3Extension('/a/b'), '/a/b.mp3');
  assert.equal(v.ensureMp3Extension('/a/b.MP3'), '/a/b.MP3');
  assert.equal(v.ensureMp3Extension('/a/b.wav'), '/a/b.wav.mp3');
});
