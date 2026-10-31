'use strict';

/**
 * Verifica il convertitore e il motore multimediale incluso (PyAV + librerie FFmpeg).
 *
 * Uso:
 *   npm run verify:converter            versione di sviluppo (convert.py con il Python del .venv)
 *   npm run verify:converter -- --built eseguibile PyInstaller in resources/python-converter/
 *
 * Controlli:
 *   - il convertitore si avvia e risponde a --version;
 *   - PyAV è disponibile e include l'encoder libmp3lame;
 *   - versione delle librerie FFmpeg incluse;
 *   - licenza: dichiarata da FFmpeg e valutata (tiene conto di librerie GPL come x264/x265);
 *   - per l'eseguibile compilato: architettura e checksum SHA-256.
 *
 * Questo script non scarica nulla.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { ROOT, parseArgs, log } = require('./lib/common');
const { createRuntimeContext, resolveConverterExecutable, checkResources } = require('../src/main/resource-resolver');
const { classifyLicense } = require('../src/main/license-classifier');
const { parseEventLine } = require('../src/main/process-manager');

function main() {
  const args = parseArgs();
  const env = { ...process.env, ...(args.built ? { VIDEO2MP3_USE_BUILT_CONVERTER: '1' } : {}) };
  const ctx = createRuntimeContext({ isPackaged: false, appRoot: ROOT, env });
  const converter = resolveConverterExecutable(ctx);
  const problems = [];
  const warnings = [];

  log(`Convertitore (${converter.kind}): ${converter.command} ${converter.args.join(' ')}`);
  const status = checkResources(ctx);
  for (const p of status.problems) problems.push(`${p.code}: ${p.detail}`);

  if (!problems.length) {
    const r = spawnSync(converter.command, [...converter.args, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const parsed = parseEventLine(String(r.stdout || '').trim().split(/\r?\n/).pop());
    if (r.error || r.status !== 0 || !parsed.ok || parsed.event.type !== 'version') {
      problems.push(`il convertitore non risponde a --version (${r.error ? r.error.code : `codice ${r.status}`})`);
    } else {
      const v = parsed.event;
      log(`  convertitore ${v.converter}, Python ${v.python}, compilato: ${v.frozen ? 'sì' : 'no'}`);
      if (!v.engine.available) {
        problems.push('PyAV non disponibile: pip install -r src/python/requirements.txt');
      } else {
        const lic = classifyLicense(v.engine.configuration, v.engine.license);
        log(`  PyAV ${v.engine.pyav}`);
        for (const [name, version] of Object.entries(v.engine.ffmpegLibraries)) log(`    ${name} ${version}`);
        log(`  libmp3lame: ${v.engine.libmp3lame ? 'sì' : 'NO'}`);
        log(`  licenza dichiarata da FFmpeg: ${v.engine.license}`);
        log(`  licenza valutata: ${lic.classification}`);
        if (!v.engine.libmp3lame) problems.push('encoder libmp3lame assente');
        if (!lic.distributable) problems.push(lic.note);
        else if (lic.gplLibraries.length) warnings.push(lic.note);
      }
      if (converter.kind === 'compiled') {
        const sha = crypto.createHash('sha256').update(fs.readFileSync(converter.command)).digest('hex');
        log(`  sha256 ${sha}`);
      }
    }
  }

  for (const w of warnings) log(`  [AVVISO] ${w}`);
  for (const p of problems) log(`  [ERRORE] ${p}`);
  log(problems.length ? '\nVerifica NON superata.' : '\nOK');
  process.exit(problems.length ? 1 : 0);
}

main();
