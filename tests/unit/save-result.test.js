'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveResultFile, mapFsError } = require('../../src/main/save-result');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2m-save-'));
  const src = path.join(dir, 'output.mp3');
  fs.writeFileSync(src, Buffer.alloc(5000, 7));
  return { dir, src, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('salva il risultato e verifica la dimensione', async () => {
  const t = tmp();
  const dest = path.join(t.dir, 'Città è bella — 日本 (1).mp3');
  const saved = await saveResultFile(t.src, dest);
  assert.equal(saved.path, dest);
  assert.equal(saved.size, 5000);
  assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(t.src));
  const leftovers = fs.readdirSync(t.dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'nessun file temporaneo residuo');
  t.cleanup();
});

test('aggiunge .mp3 se manca', async () => {
  const t = tmp();
  const saved = await saveResultFile(t.src, path.join(t.dir, 'senza estensione'));
  assert.equal(path.basename(saved.path), 'senza estensione.mp3');
  t.cleanup();
});

test('sostituisce un file esistente (dopo la conferma del dialog nativo)', async () => {
  const t = tmp();
  const dest = path.join(t.dir, 'esistente.mp3');
  fs.writeFileSync(dest, 'vecchio');
  await saveResultFile(t.src, dest);
  assert.equal(fs.statSync(dest).size, 5000);
  t.cleanup();
});

test('percorsi lunghi', async () => {
  const t = tmp();
  let deep = t.dir;
  for (let i = 0; i < 6; i += 1) deep = path.join(deep, `cartella con nome lungo numero ${i} ${'x'.repeat(20)}`);
  fs.mkdirSync(deep, { recursive: true });
  const saved = await saveResultFile(t.src, path.join(deep, `${'brano '.repeat(10)}.mp3`));
  assert.ok(fs.existsSync(saved.path));
  t.cleanup();
});

test('errori: cartella inesistente, percorso relativo, sorgente mancante', async () => {
  const t = tmp();
  await assert.rejects(saveResultFile(t.src, path.join(t.dir, 'non-esiste', 'a.mp3')), (e) => e.code === 'DESTINATION_UNAVAILABLE');
  await assert.rejects(saveResultFile(t.src, 'relativo.mp3'), (e) => e.code === 'DESTINATION_UNAVAILABLE');
  await assert.rejects(saveResultFile(path.join(t.dir, 'manca.mp3'), path.join(t.dir, 'a.mp3')), (e) => e.code === 'JOB_NOT_COMPLETED');
  t.cleanup();
});

test('verifica fallita: dimensione copiata diversa', async () => {
  const t = tmp();
  const realFs = fs.promises;
  let statCalls = 0;
  const fakeFs = {
    ...realFs,
    stat: async (p) => {
      statCalls += 1;
      const s = await realFs.stat(p);
      return p.endsWith('.tmp') ? { ...s, size: s.size - 1, isDirectory: () => false } : s;
    },
    copyFile: realFs.copyFile,
    rename: realFs.rename,
    rm: realFs.rm
  };
  await assert.rejects(saveResultFile(t.src, path.join(t.dir, 'x.mp3'), fakeFs), (e) => e.code === 'SAVE_VERIFICATION_FAILED');
  assert.ok(statCalls > 0);
  assert.deepEqual(fs.readdirSync(t.dir).filter((f) => f.endsWith('.tmp')), []);
  t.cleanup();
});

test('traduzione dei codici di errore del filesystem', () => {
  assert.equal(mapFsError({ code: 'ENOSPC' }), 'INSUFFICIENT_DISK_SPACE');
  assert.equal(mapFsError({ code: 'EACCES' }), 'DESTINATION_NOT_WRITABLE');
  assert.equal(mapFsError({ code: 'EROFS' }), 'DESTINATION_NOT_WRITABLE');
  assert.equal(mapFsError({ code: 'ENOENT' }), 'DESTINATION_UNAVAILABLE');
  assert.equal(mapFsError({}), 'DESTINATION_NOT_WRITABLE');
});
