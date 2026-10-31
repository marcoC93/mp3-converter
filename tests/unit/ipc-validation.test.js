'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IPC_CHANNELS, EXTERNAL_LINKS, validateIpcMessage, isTrustedSenderUrl } = require('../../src/main/ipc-validation');

test('canali non in allowlist rifiutati', () => {
  for (const ch of ['shell:exec', 'fs:read', '', '__proto__', 'constructor', 'toString']) {
    assert.equal(validateIpcMessage(ch, []).ok, false, ch);
  }
});

test('canali senza argomenti rifiutano argomenti extra', () => {
  assert.equal(validateIpcMessage('file:select-video', []).ok, true);
  assert.equal(validateIpcMessage('file:select-video', ['C:\\Windows']).ok, false);
  assert.equal(validateIpcMessage('app:get-api-config', [{}]).ok, false);
  assert.equal(validateIpcMessage('app:get-api-config', 'non array').ok, false);
});

test('job:save-result accetta solo un UUID', () => {
  assert.equal(validateIpcMessage('job:save-result', ['66666666-6666-4666-8666-666666666666']).ok, true);
  for (const bad of [[], ['../x'], [42], [{ id: 'x' }], ['66666666-6666-4666-8666-666666666666', 'extra']]) {
    assert.equal(validateIpcMessage('job:save-result', bad).ok, false, JSON.stringify(bad));
  }
});

test('file:register-dropped accetta solo un percorso assoluto plausibile', () => {
  assert.equal(validateIpcMessage('file:register-dropped', [path.resolve('video.mp4')]).ok, true);
  for (const bad of [['relativo.mp4'], [''], [null], [`${path.resolve('a')}\0b`], [['x']]]) {
    assert.equal(validateIpcMessage('file:register-dropped', bad).ok, false, JSON.stringify(bad));
  }
});

test('app:open-external accetta solo chiavi note, non URL arbitrari', () => {
  const ok = validateIpcMessage('app:open-external', ['ffmpeg']);
  assert.deepEqual(ok, { ok: true, value: EXTERNAL_LINKS.ffmpeg });
  for (const bad of [['https://evil.example'], ['file:///etc/passwd'], ['__proto__'], ['toString']]) {
    assert.equal(validateIpcMessage('app:open-external', bad).ok, false, bad[0]);
  }
  for (const url of Object.values(EXTERNAL_LINKS)) assert.match(url, /^https:\/\//);
});

test('mittente: solo la nostra origine locale', () => {
  const origin = 'http://127.0.0.1:51234';
  assert.ok(isTrustedSenderUrl(`${origin}/`, origin));
  assert.ok(isTrustedSenderUrl(`${origin}/index.html?x=1`, origin));
  assert.ok(!isTrustedSenderUrl('http://127.0.0.1:9999/', origin));
  assert.ok(!isTrustedSenderUrl('http://localhost:51234/', origin));
  assert.ok(!isTrustedSenderUrl('file:///C:/app/index.html', origin));
  assert.ok(!isTrustedSenderUrl('https://evil.example/', origin));
  assert.ok(!isTrustedSenderUrl('', origin));
  assert.ok(!isTrustedSenderUrl(undefined, origin));
});

test('il preload usa esattamente i canali dell\'allowlist', () => {
  const preload = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'main', 'preload.js'), 'utf8');
  const used = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(used, Object.keys(IPC_CHANNELS).sort());
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer\s*\)/, 'ipcRenderer non deve essere esposto direttamente');
});
