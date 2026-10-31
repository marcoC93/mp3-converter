'use strict';

/**
 * Rimuove gli artefatti di build.
 *   npm run clean            build/, out/
 *   npm run clean -- --all   anche i convertitori PyInstaller in resources/python-converter/
 */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, parseArgs, log } = require('./lib/common');

const args = parseArgs();
const targets = [path.join(ROOT, 'build'), path.join(ROOT, 'out'), path.join(ROOT, 'src', 'python', '__pycache__'), path.join(ROOT, 'tests', 'python', '__pycache__')];

if (args.all) {
  const base = path.join(ROOT, 'resources', 'python-converter');
  if (fs.existsSync(base)) {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) targets.push(path.join(base, entry.name));
    }
  }
}

for (const target of targets) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    log(`rimosso ${path.relative(ROOT, target)}`);
  }
}
log('Pulizia completata.');
