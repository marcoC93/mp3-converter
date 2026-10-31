'use strict';

/**
 * Genera file video SINTETICI per i test manuali, usando PyAV tramite
 * tests/fixtures/make_media.py (immagine fissa + tono a 440 Hz).
 * Nessun file multimediale viene salvato nel repository: vengono creati in
 * build/test-media/ (ignorata da git).
 *
 * Uso: node scripts/generate-test-media.js   (richiede PyAV nel .venv)
 */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, findPython, run, log, fail } = require('./lib/common');

const python = findPython();
if (!python) fail('Python non trovato.');
const maker = path.join(ROOT, 'tests', 'fixtures', 'make_media.py');
const outDir = path.join(ROOT, 'build', 'test-media');
fs.mkdirSync(outDir, { recursive: true });

const cases = [
  ['sample-10s.mp4', ['--seconds', '10']],
  ['sample-10s.mkv', ['--seconds', '10']],
  ['sample-5s.avi', ['--seconds', '5']],
  ['sample-120s.mov', ['--seconds', '120']],
  ['mono-96khz.mkv', ['--seconds', '5', '--rate', '96000', '--channels', '1']],
  ['no-audio.mp4', ['--seconds', '5', '--no-audio']],
  ['nome con spazi è ünicode 日本.mp4', ['--seconds', '3']],
  ['corrupted.mp4', ['--corrupted']]
];

let failed = 0;
for (const [name, extra] of cases) {
  const status = run(python, [maker, path.join(outDir, name), ...extra], { stdio: 'ignore' });
  if (status !== 0) failed += 1;
  log(`${status === 0 ? 'OK ' : 'ERR'} ${path.relative(ROOT, path.join(outDir, name))}`);
}
process.exit(failed ? 1 : 0);
