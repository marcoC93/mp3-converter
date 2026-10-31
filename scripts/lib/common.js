'use strict';

/** Utilità condivise dagli script di sviluppo e build (non incluse nell'app). */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

/** Python da usare per build/test: VIDEO2MP3_PYTHON, poi .venv del progetto, poi PATH. */
function findPython() {
  if (process.env.VIDEO2MP3_PYTHON) return process.env.VIDEO2MP3_PYTHON;
  const venv = process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python3');
  if (fs.existsSync(venv)) return venv;
  for (const candidate of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return candidate;
  }
  return null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  return result.status;
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg, code = 1) {
  process.stderr.write(`\n[ERRORE] ${msg}\n`);
  process.exit(code);
}

module.exports = { ROOT, parseArgs, findPython, run, log, fail };
