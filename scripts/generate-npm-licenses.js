'use strict';

/**
 * Elenca le dipendenze npm di PRODUZIONE (quelle incluse nel pacchetto) con
 * la relativa licenza, leggendo i package.json in node_modules.
 * Output: resources/licenses/npm-licenses.txt (da allegare agli avvisi).
 *
 * Nessuna dipendenza esterna: per un'analisi più completa si possono usare
 * strumenti dedicati, ma questo è sufficiente per un primo inventario.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, log } = require('./lib/common');

const seen = new Map();

function visit(name, fromDir) {
  let dir = fromDir;
  let pkgFile = null;
  // Risoluzione stile Node: risale le cartelle node_modules.
  while (true) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(candidate)) {
      pkgFile = candidate;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!pkgFile) return;
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license && pkg.license.type) || 'SCONOSCIUTA';
  seen.set(key, { name: pkg.name, version: pkg.version, license, repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '' });
  for (const dep of Object.keys(pkg.dependencies || {})) visit(dep, path.dirname(pkgFile));
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
for (const dep of Object.keys(rootPkg.dependencies || {})) visit(dep, ROOT);

const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const text = [
  'Dipendenze npm incluse nel pacchetto (generato da scripts/generate-npm-licenses.js)',
  `Data: ${new Date().toISOString()}`,
  '',
  ...rows.map((r) => `${r.name}@${r.version} | ${r.license}${r.repository ? ` | ${r.repository}` : ''}`),
  ''
].join('\n');
const out = path.join(ROOT, 'resources', 'licenses', 'npm-licenses.txt');
fs.writeFileSync(out, text);
const unknown = rows.filter((r) => r.license === 'SCONOSCIUTA');
log(`${rows.length} pacchetti elencati in ${path.relative(ROOT, out)}`);
if (unknown.length) log(`ATTENZIONE: licenza sconosciuta per ${unknown.map((r) => r.name).join(', ')}`);
