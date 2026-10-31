'use strict';

/**
 * `npm run check`: controlli statici rapidi, senza dipendenze aggiuntive.
 *   1. sintassi di tutti i file JavaScript (node --check);
 *   2. sintassi dei file Python (py_compile);
 *   3. validità dei file JSON del progetto;
 *   4. regole di sicurezza semplici (niente eval, niente innerHTML, niente shell:true);
 *   5. stato delle risorse native per la piattaforma corrente (solo informativo).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, findPython, log } = require('./lib/common');
const { createRuntimeContext, checkResources } = require('../src/main/resource-resolver');

// Cartelle generate (dipendenze, build, convertitore compilato, sorgenti di terze parti).
const IGNORED = new Set(['node_modules', '.git', 'out', 'build', '.venv', 'python-converter']);
const IGNORED_PATHS = new Set([path.join(ROOT, 'resources', 'third-party')]);

function walk(dir, exts, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (IGNORED.has(entry.name) || IGNORED_PATHS.has(full)) continue;
    if (entry.isDirectory()) walk(full, exts, acc);
    else if (exts.includes(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

let failures = 0;
const rel = (f) => path.relative(ROOT, f);

// 1. JavaScript
const jsFiles = walk(ROOT, ['.js']);
for (const file of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failures += 1;
    log(`[JS] ${rel(file)}\n${r.stderr}`);
  }
}
log(`JavaScript: ${jsFiles.length} file controllati`);

// 2. Python
const pyFiles = walk(ROOT, ['.py']);
const python = findPython();
if (python) {
  const r = spawnSync(python, ['-c', 'import sys,py_compile\nfor f in sys.argv[1:]: py_compile.compile(f, doraise=True, cfile=None)', ...pyFiles], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: path.join(ROOT, 'build', 'pycache') } });
  if (r.status !== 0) {
    failures += 1;
    log(`[PY] ${r.stderr}`);
  }
  log(`Python: ${pyFiles.length} file controllati`);
} else {
  log('Python: NON controllato (interprete non trovato)');
}

// 3. JSON
const jsonFiles = walk(ROOT, ['.json']).filter((f) => !f.endsWith('package-lock.json'));
for (const file of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    failures += 1;
    log(`[JSON] ${rel(file)}: ${err.message}`);
  }
}
log(`JSON: ${jsonFiles.length} file controllati`);

// 4. Regole di sicurezza (euristiche, non sostituiscono una revisione)
const rules = [
  { re: /\beval\s*\(|new Function\s*\(/, msg: 'eval/new Function', dirs: ['src'] },
  { re: /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/, msg: 'innerHTML/insertAdjacentHTML', dirs: ['src/renderer'] },
  { re: /shell:\s*true/, msg: 'shell: true', dirs: ['src', 'scripts'] },
  { re: /nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false/, msg: 'impostazione Electron insicura', dirs: ['src'] },
  { re: /localStorage|sessionStorage/, msg: 'uso di web storage', dirs: ['src/renderer'] },
  { re: /https?:\/\/(?!127\.0\.0\.1)[a-z]/i, msg: 'URL remoto nella GUI', dirs: ['src/renderer'] }
];
for (const rule of rules) {
  for (const dir of rule.dirs) {
    for (const file of walk(path.join(ROOT, dir), ['.js', '.html', '.css'])) {
      if (file === __filename) continue; // contiene le regole stesse
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (rule.re.test(code)) {
          failures += 1;
          log(`[SICUREZZA] ${rel(file)}:${i + 1} ${rule.msg}`);
        }
      });
    }
  }
}
log('Regole di sicurezza: controllate');

// 5. Risorse native (informativo)
try {
  const ctx = createRuntimeContext({ isPackaged: false, appRoot: ROOT });
  const status = checkResources(ctx);
  log(`\nRisorse per ${ctx.platformKey}: ${status.ready ? 'pronte' : 'INCOMPLETE'}`);
  for (const p of status.problems) log(`  - ${p.component}: ${p.code} (${p.detail.replace(ROOT, '.')})`);
} catch (err) {
  log(`Risorse: ${err.message}`);
}

if (failures) {
  log(`\n${failures} problemi trovati.`);
  process.exit(1);
}
log('\nCheck completato senza errori.');
