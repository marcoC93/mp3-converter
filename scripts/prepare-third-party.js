'use strict';

/**
 * Prepara gli obblighi di licenza del convertitore (scelta: distribuzione sotto GPL).
 *
 * Uso:  npm run third-party            piattaforma corrente
 *       npm run third-party -- --platform win32 --arch x64
 *
 * Cosa fa, a partire da third-party/pyav-<versione>.json:
 *  1. censisce le librerie davvero presenti nel convertitore compilato (av.libs):
 *     ogni libreria deve corrispondere a un componente del manifesto, altrimenti si ferma;
 *  2. scarica i sorgenti dei componenti (cache in build/third-party/cache) e ne verifica lo SHA-256;
 *  3. estrae dagli archivi i file di licenza ORIGINALI (COPYING, LICENSE...) dei progetti;
 *  4. genera resources/third-party/<piattaforma>-<arch>/:
 *       LICENSES.txt   testi integrali di tutte le licenze del convertitore
 *       SOURCES.md     elenco del sorgente corrispondente e istruzioni per ricostruire
 *       source/        archivi dei sorgenti + sorgente del convertitore (src/python)
 *       manifest.json  hash di ogni file, verificato da prepare-resources.js
 *
 * La cartella viene inclusa nel pacchetto: il sorgente corrispondente accompagna
 * sempre l'eseguibile (GPL-3.0 sezione 6a), senza server esterni da mantenere.
 *
 * I download sono archivi di codice sorgente e testi di licenza: non vengono
 * eseguiti. Un hash diverso da quello atteso blocca lo script.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, parseArgs, findPython, log, fail } = require('./lib/common');
const { classifyLicense } = require('../src/main/license-classifier');

const args = parseArgs();
const platform = args.platform || process.platform;
const arch = args.arch || process.arch;
const key = `${platform}-${arch}`;

const LICENSE_FILE = /^[^/]+\/(COPYING|LICENSE|LICENCE|COPYRIGHT|NOTICE|PATENTS)([._-][^/]*)?$/i;
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return hash.digest('hex');
}

function fileNameOf(component) {
  return component.filename || decodeURIComponent(new URL(component.url).pathname.split('/').pop());
}

function appliesTo(component) {
  return component.platforms === 'all' || (Array.isArray(component.platforms) && component.platforms.includes(key));
}

// ---------------------------------------------------------------------------
// 1. Versione di PyAV e manifesto
// ---------------------------------------------------------------------------

const converterDir = path.join(ROOT, 'resources', 'python-converter', key);
let buildInfo = null;
try {
  buildInfo = JSON.parse(fs.readFileSync(path.join(converterDir, 'build-info.json'), 'utf8'));
} catch {
  buildInfo = null;
}
const python = findPython();
let pyavVersion = buildInfo?.engine?.pyav;
if (!pyavVersion && python) {
  const r = spawnSync(python, ['-c', 'import av; print(av.__version__)'], { encoding: 'utf8' });
  if (r.status === 0) pyavVersion = r.stdout.trim();
}
if (!pyavVersion) fail('Versione di PyAV non determinabile: esegui prima "npm run build:python".');

const manifestFile = path.join(ROOT, 'third-party', `pyav-${pyavVersion}.json`);
if (!fs.existsSync(manifestFile)) {
  fail(`Manca ${path.relative(ROOT, manifestFile)}.\nPyAV è cambiato: va creato il manifesto della nuova versione (vedi docs/LICENSE_COMPLIANCE.md, "Aggiornare PyAV").`);
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (!manifest.verifiedPlatforms.includes(key)) {
  fail(
    `Il manifesto per PyAV ${pyavVersion} non è ancora stato verificato per ${key}.\n` +
    `Su una macchina ${key}: compila il convertitore, confronta le librerie in av.libs con "libraryMap" e i ` +
    'componenti per piattaforma, poi aggiungi la piattaforma a "verifiedPlatforms".'
  );
}
const components = manifest.components.filter(appliesTo);
log(`PyAV ${pyavVersion} (${manifest.ffmpegBuild}) per ${key}: ${components.length} componenti`);

// ---------------------------------------------------------------------------
// 2. Censimento delle librerie realmente incluse
// ---------------------------------------------------------------------------

function findLibraryDirs(start) {
  const found = [];
  if (!fs.existsSync(start)) return found;
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'av.libs' || entry.name === '.dylibs') found.push(full);
      else stack.push(full);
    }
  }
  return found;
}

let libDirs = findLibraryDirs(path.join(converterDir, 'converter'));
let libSource = 'convertitore compilato';
if (!libDirs.length && python) {
  const r = spawnSync(python, ['-c', 'import av, os; print(os.path.dirname(os.path.dirname(av.__file__)))'], { encoding: 'utf8' });
  libDirs = r.status === 0 ? findLibraryDirs(r.stdout.trim()).filter((d) => d.includes('av')) : [];
  libSource = 'PyAV installato nel .venv';
}
if (!libDirs.length) fail('Nessuna cartella av.libs/.dylibs trovata: compila il convertitore con "npm run build:python".');

const libraryRules = Object.entries(manifest.libraryMap).filter(([k]) => !k.startsWith('_')).map(([re, id]) => [new RegExp(re), id]);
const usedComponents = new Set(['pyav', 'pyav-build-scripts', 'pyav-ffmpeg']);
const unknown = [];
for (const dir of libDirs) {
  for (const file of fs.readdirSync(dir)) {
    const rule = libraryRules.find(([re]) => re.test(file));
    if (!rule) unknown.push(file);
    else if (!components.some((c) => c.id === rule[1])) unknown.push(`${file} (componente "${rule[1]}" non previsto per ${key})`);
    else usedComponents.add(rule[1]);
  }
}
if (unknown.length) {
  fail(`Librerie non censite nel manifesto (${libSource}):\n  ${unknown.join('\n  ')}\nAggiorna ${path.relative(ROOT, manifestFile)}.`);
}
log(`Censimento librerie (${libSource}): tutte le librerie corrispondono a un componente del manifesto.`);

// ---------------------------------------------------------------------------
// 3. Download e verifica
// ---------------------------------------------------------------------------

const cacheDir = path.join(ROOT, 'build', 'third-party', 'cache');
fs.mkdirSync(cacheDir, { recursive: true });

async function download(component) {
  const target = path.join(cacheDir, fileNameOf(component));
  if (fs.existsSync(target) && sha256File(target) === component.sha256) return target;
  if (fs.existsSync(target)) {
    throw new Error(`SHA-256 non corrispondente per il file in cache ${path.relative(ROOT, target)}: eliminalo e riprova`);
  }
  log(`  scarico ${component.name} ${component.version}...`);
  let response;
  try {
    response = await fetch(component.url, { redirect: 'follow' });
  } catch (err) {
    response = { ok: false, status: err.message };
  }
  if (!response.ok) {
    // Alcuni server (es. GitLab con protezioni anti-bot) rifiutano i client automatici:
    // in quel caso il file si scarica a mano con il browser e lo script ne verifica l'hash.
    throw new Error(
      `download non riuscito (${response.status}) per ${component.name}.\n` +
      `Scaricalo manualmente da:\n  ${component.url}\n` +
      `e salvalo come:\n  ${path.relative(ROOT, target)}\n` +
      'Poi rilancia lo script: verificherà lo SHA-256 prima di usarlo.'
    );
  }
  const tmp = `${target}.download`;
  fs.writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
  const actual = sha256File(tmp);
  if (actual !== component.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`SHA-256 non corrispondente per ${component.name}: atteso ${component.sha256}, ottenuto ${actual}`);
  }
  fs.renameSync(tmp, target);
  return target;
}

// ---------------------------------------------------------------------------
// 4. Estrazione dei testi di licenza dagli archivi originali
// ---------------------------------------------------------------------------

/**
 * Estrae i testi di licenza originali da un archivio di sorgenti:
 * - di norma i file COPYING/LICENSE/... nella cartella radice;
 * - con `licenseHeaderPattern`, il commento iniziale dei file indicati
 *   (progetti che dichiarano la licenza solo negli header).
 */
function licenseTextsFromArchive(archive, component) {
  const list = spawnSync(TAR, ['-tf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (list.status !== 0) throw new Error(`impossibile leggere ${path.basename(archive)}: ${list.stderr}`);
  const headerRe = component.licenseHeaderPattern ? new RegExp(component.licenseHeaderPattern) : null;
  const members = list.stdout.split(/\r?\n/).filter((m) => (headerRe ? headerRe.test(m) : LICENSE_FILE.test(m)));
  if (!members.length) return [];
  const tmp = fs.mkdtempSync(path.join(cacheDir, 'lic-'));
  try {
    const r = spawnSync(TAR, ['-xf', archive, '-C', tmp, ...members], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`estrazione licenze da ${path.basename(archive)}: ${r.stderr}`);
    const texts = members.sort().map((m) => {
      const content = fs.readFileSync(path.join(tmp, m), 'utf8');
      if (!headerRe) return { name: m, text: content };
      // Commento iniziale: blocco /* ... */ oppure righe consecutive che iniziano con //
      const match = /^\s*(\/\*[\s\S]*?\*\/|(?:[ \t]*\/\/[^\n]*\r?\n)+)/.exec(content);
      return { name: m, text: match ? match[0] : '' };
    }).filter((t) => t.text);
    // Commenti identici in più header: si riportano una volta sola.
    const seen = new Map();
    for (const t of texts) {
      if (seen.has(t.text)) seen.get(t.text).name += `, ${t.name}`;
      else seen.set(t.text, { ...t });
    }
    return [...seen.values()];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function localLicense(label, file) {
  return fs.existsSync(file) ? { name: label, text: fs.readFileSync(file, 'utf8') } : null;
}

// ---------------------------------------------------------------------------
// Esecuzione
// ---------------------------------------------------------------------------

async function main() {
  const outDir = path.join(ROOT, 'resources', 'third-party', key);
  fs.rmSync(outDir, { recursive: true, force: true });
  const sourceDir = path.join(outDir, 'source');
  fs.mkdirSync(path.join(sourceDir, 'converter'), { recursive: true });

  const sections = [];
  const rows = [];
  for (const component of components) {
    const archive = await download(component);
    const included = usedComponents.has(component.id) || !component.licenseOnly;
    let texts;
    if (component.licenseOnly) {
      texts = [{ name: fileNameOf(component), text: fs.readFileSync(archive, 'utf8') }];
    } else {
      fs.copyFileSync(archive, path.join(sourceDir, fileNameOf(component)));
      texts = component.licenseFromArchive === false ? [] : licenseTextsFromArchive(archive, component);
      if (component.licenseFromArchive !== false && !texts.length) {
        throw new Error(`nessun file di licenza trovato nell'archivio di ${component.name}: verificarlo a mano`);
      }
    }
    rows.push({ component, file: component.licenseOnly ? null : fileNameOf(component), included });
    if (texts.length) sections.push({ component, texts });
  }

  // Sorgente del convertitore stesso: l'eseguibile è un'opera combinata con componenti GPL.
  for (const f of ['convert.py', 'converter.spec', 'requirements.txt', 'requirements-build.txt']) {
    fs.copyFileSync(path.join(ROOT, 'src', 'python', f), path.join(sourceDir, 'converter', f));
  }
  fs.copyFileSync(path.join(ROOT, 'scripts', 'build-python.js'), path.join(sourceDir, 'converter', 'build-python.js'));
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(sourceDir, 'converter', 'LICENSE'));

  // Licenze di Python e PyInstaller (dal Python usato per la build).
  const extra = [];
  if (python) {
    const r = spawnSync(python, ['-c', 'import sys,os,glob,importlib.metadata as m; print(os.path.join(sys.base_prefix,"LICENSE.txt")); d=m.distribution("pyinstaller"); print([str(f.locate()) for f in d.files if "COPYING" in str(f)][0])'], { encoding: 'utf8' });
    if (r.status === 0) {
      const [pyLicense, pyiLicense] = r.stdout.trim().split(/\r?\n/);
      extra.push({ title: `Python ${buildInfo?.python || ''} — PSF-2.0 (interprete incluso nel convertitore)`, item: localLicense('LICENSE.txt', pyLicense) });
      extra.push({ title: 'PyInstaller — GPL-2.0-or-later con eccezione per il bootloader', item: localLicense('COPYING.txt', pyiLicense) });
    }
  }

  // ---- LICENSES.txt ----
  const engine = buildInfo?.engine;
  const lic = engine ? classifyLicense(engine.configuration, engine.declaredLicense) : null;
  const out = [];
  out.push('VIDEO TO MP3 — LICENZE DEI COMPONENTI DEL CONVERTITORE');
  out.push('='.repeat(64));
  out.push('');
  out.push(`Piattaforma: ${key}`);
  out.push(`PyAV: ${pyavVersion} — librerie FFmpeg: ${manifest.ffmpegBuild}`);
  if (lic) out.push(`Licenza dichiarata da FFmpeg: ${engine.declaredLicense} — licenza valutata: ${lic.classification}`);
  out.push('');
  out.push('Il convertitore (resources/python-converter) è un\'opera che combina il codice di');
  out.push('questo progetto con PyAV, le librerie FFmpeg e i codec elencati sotto, fra cui');
  out.push('x264 e x265 (GPL-2.0-or-later). Il convertitore è quindi distribuito nei termini');
  out.push('della GNU General Public License versione 3 o successiva (GPL-3.0-or-later).');
  out.push('Il codice del convertitore scritto per questo progetto è rilasciato con licenza MIT,');
  out.push('compatibile con la GPL.');
  out.push('');
  out.push('L\'applicazione Electron comunica con il convertitore solo come programma separato');
  out.push('(riga di comando e pipe) e resta distribuita con la propria licenza (MIT).');
  out.push('');
  out.push('SORGENTE CORRISPONDENTE: incluso in questo pacchetto, cartella');
  out.push(`resources/third-party/${key}/source/ (elenco e istruzioni in SOURCES.md).`);
  out.push('');
  out.push('Questa documentazione non costituisce consulenza legale.');
  out.push('');
  out.push('COMPONENTI');
  out.push('-'.repeat(64));
  for (const { component } of rows) out.push(`- ${component.name} ${component.version} — ${component.license}`);
  for (const e of extra) if (e.item) out.push(`- ${e.title}`);
  out.push('');
  for (const { component, texts } of sections) {
    for (const t of texts) {
      out.push('');
      out.push('#'.repeat(78));
      out.push(`# ${component.name} ${component.version} — ${component.license}`);
      out.push(`# file: ${t.name}`);
      out.push('#'.repeat(78));
      out.push('');
      out.push(t.text.trimEnd());
    }
  }
  for (const e of extra) {
    if (!e.item) continue;
    out.push('');
    out.push('#'.repeat(78));
    out.push(`# ${e.title}`);
    out.push('#'.repeat(78));
    out.push('');
    out.push(e.item.text.trimEnd());
  }
  fs.writeFileSync(path.join(outDir, 'LICENSES.txt'), `${out.join('\n')}\n`);

  // ---- SOURCES.md ----
  const src = [];
  src.push(`# Sorgente corrispondente del convertitore — ${key}`);
  src.push('');
  src.push('Questa cartella accompagna l\'eseguibile del convertitore e contiene il **sorgente corrispondente**');
  src.push('richiesto dalla GPL-3.0 (sezione 6a) per i componenti GPL/LGPL inclusi, più i sorgenti dei componenti permissivi.');
  src.push('');
  src.push(`- PyAV ${pyavVersion}; librerie FFmpeg e codec da ${manifest.ffmpegBuild}`);
  src.push(`- Generato da \`scripts/prepare-third-party.js\` il ${new Date().toISOString()}`);
  src.push('');
  src.push('| File | Componente | Versione | Licenza | SHA-256 | Origine |');
  src.push('|------|------------|----------|---------|---------|---------|');
  for (const { component, file } of rows) {
    if (!file) continue;
    src.push(`| \`source/${file}\` | ${component.name} | ${component.version} | ${component.license} | \`${component.sha256}\` | ${component.url} |`);
  }
  src.push('| `source/converter/` | Convertitore Video to MP3 (convert.py, spec PyInstaller, requisiti, script di build) | — | MIT | — | questo progetto |');
  src.push('');
  src.push('## Come ricostruire');
  src.push('');
  src.push('1. **FFmpeg e codec**: estrarre `pyav-ffmpeg-*.tar.gz`; `scripts/build-ffmpeg.py` e `scripts/pkg.py` descrivono');
  src.push('   ordine, opzioni di configurazione e patch (`patches/`) usati per compilare gli archivi di questa cartella.');
  src.push('2. **PyAV**: estrarre `PyAV-v*.tar.gz`; il workflow `.github/workflows/tests.yml` e `scripts/fetch-vendor.py`');
  src.push('   mostrano come i wheel vengono compilati contro le librerie del punto 1 (`scripts/ffmpeg-latest.json`).');
  src.push('3. **Convertitore**: in `source/converter/` installare i requisiti (`pip install -r requirements-build.txt`, usando');
  src.push('   il PyAV ricostruito al punto 2) ed eseguire PyInstaller con `converter.spec` (vedi `build-python.js`).');
  src.push('');
  src.push('Le DLL della toolchain MinGW-w64 senza sorgente in questa cartella (libgcc, libstdc++, winpthreads, zlib) hanno');
  src.push('licenze che non richiedono la distribuzione del sorgente; i loro testi di licenza sono in `LICENSES.txt`.');
  fs.writeFileSync(path.join(outDir, 'SOURCES.md'), `${src.join('\n')}\n`);

  // ---- manifest.json ----
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name !== 'manifest.json') {
        files.push({ path: path.relative(outDir, full).split(path.sep).join('/'), size: fs.statSync(full).size, sha256: sha256File(full) });
      }
    }
  };
  walk(outDir);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify({
    platformKey: key,
    pyav: pyavVersion,
    ffmpegBuild: manifest.ffmpegBuild,
    license: lic ? lic.classification : 'GPL-3.0-or-later',
    generatedAt: new Date().toISOString(),
    files
  }, null, 2)}\n`);

  const totalMb = files.reduce((s, f) => s + f.size, 0) / 1024 / 1024;
  log(`\nOK: ${path.relative(ROOT, outDir)} (${files.length} file, ${totalMb.toFixed(1)} MB)`);
  log(`    LICENSES.txt: ${sections.reduce((s, x) => s + x.texts.length, 0) + extra.filter((e) => e.item).length} testi di licenza`);
}

main().catch((err) => fail(err.message));
