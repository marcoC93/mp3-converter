'use strict';

/**
 * Compila il convertitore Python in un eseguibile standalone con PyInstaller.
 *
 * Uso:
 *   npm run build:python              build normale (onedir)
 *   npm run build:python -- --debug   build di debug (bootloader verboso)
 *   npm run build:python -- --onefile variante a file singolo (sperimentale)
 *
 * IMPORTANTE: PyInstaller NON è un cross-compiler. Produce un eseguibile per
 * il sistema operativo e l'architettura del Python con cui viene eseguito.
 * Per questo lo script rifiuta di "compilare per" una piattaforma diversa.
 *
 * Output: resources/python-converter/<piattaforma>-<arch>/converter/
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, parseArgs, findPython, run, log, fail } = require('./lib/common');
const { getPlatformKey, executableName } = require('../src/main/resource-resolver');
const { inspectFile, isCompatible } = require('../src/main/binary-inspector');
const { classifyLicense } = require('../src/main/license-classifier');

const args = parseArgs();
const hostKey = getPlatformKey(process.platform, process.arch);
const targetPlatform = args.platform || process.platform;
const targetArch = args.arch || process.arch;
const targetKey = `${targetPlatform}-${targetArch}`;

if (targetKey !== hostKey) {
  fail(
    `Richiesta build per ${targetKey} su una macchina ${hostKey}.\n` +
    'PyInstaller non è un cross-compiler: esegui questo script su un sistema ' +
    `${targetKey} (macchina fisica, VM o runner CI). Vedi docs/PACKAGING.md.`
  );
}

const python = findPython();
if (!python) fail('Python 3 non trovato. Crea il venv (vedi docs/BUILD_*.md) o imposta VIDEO2MP3_PYTHON.');

// 1. Architettura dell'interprete Python
const info = spawnSync(python, ['-c', 'import json,platform,struct,sys;print(json.dumps({"machine":platform.machine(),"bits":struct.calcsize("P")*8,"version":sys.version.split()[0]}))'], { encoding: 'utf8' });
if (info.status !== 0) fail(`Impossibile interrogare Python (${python}).`);
const pyInfo = JSON.parse(info.stdout.trim());
const machine = pyInfo.machine.toLowerCase();
const pyArch = ['amd64', 'x86_64', 'x64'].includes(machine) ? 'x64' : ['arm64', 'aarch64'].includes(machine) ? 'arm64' : machine;
if (pyInfo.bits !== 64 || pyArch !== targetArch) {
  fail(
    `Python ${pyInfo.version} è ${pyArch}/${pyInfo.bits} bit, ma la build richiesta è ${targetArch}.\n` +
    'Usa un interprete Python della stessa architettura (es. su Apple Silicon un Python arm64 nativo, non sotto Rosetta).'
  );
}
log(`Python ${pyInfo.version} (${pyArch}) -> ${python}`);

// 2. PyInstaller presente?
const pyi = spawnSync(python, ['-m', 'PyInstaller', '--version'], { encoding: 'utf8' });
if (pyi.status !== 0) {
  fail('PyInstaller non installato in questo Python.\nEsegui: python -m pip install -r src/python/requirements-build.txt');
}
const pyinstallerVersion = pyi.stdout.trim();
const pyav = spawnSync(python, ['-c', 'import av; print(av.__version__)'], { encoding: 'utf8' });
if (pyav.status !== 0) {
  fail('PyAV non installato in questo Python.\nEsegui: python -m pip install -r src/python/requirements-build.txt');
}
log(`PyAV ${pyav.stdout.trim()}`);
log(`PyInstaller ${pyinstallerVersion}`);

// 3. Build
const debug = Boolean(args.debug);
const onefile = Boolean(args.onefile);
const outRoot = path.join(ROOT, 'resources', 'python-converter', targetKey);
const outDir = path.join(outRoot, 'converter');
const workPath = path.join(ROOT, 'build', 'pyinstaller', targetKey);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });

const pyiArgs = [
  '-m', 'PyInstaller',
  '--noconfirm', '--clean',
  '--distpath', onefile ? outDir : outRoot,
  '--workpath', workPath,
  path.join(ROOT, 'src', 'python', 'converter.spec')
];
log(`\n> ${python} ${pyiArgs.join(' ')}\n`);
const status = run(python, pyiArgs, {
  cwd: ROOT,
  env: { ...process.env, CONVERTER_DEBUG: debug ? '1' : '0', CONVERTER_ONEFILE: onefile ? '1' : '0' }
});
if (status !== 0) fail(`PyInstaller è terminato con codice ${status}. Controlla l'output qui sopra.`);

// 4. Verifica dell'eseguibile generato
const exe = path.join(outDir, executableName('converter', targetPlatform));
if (!fs.existsSync(exe)) fail(`Eseguibile non trovato dopo la build: ${exe}`);
const headerInfo = inspectFile(exe);
if (!isCompatible(headerInfo, targetPlatform, targetArch)) {
  fail(`L'eseguibile generato è ${headerInfo.platform}/${headerInfo.archs.join('+')}, atteso ${targetKey}.`);
}
const check = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
let versionEvent = null;
try {
  versionEvent = JSON.parse(String(check.stdout).trim().split(/\r?\n/).pop());
} catch {
  versionEvent = null;
}
if (check.status !== 0 || !versionEvent || versionEvent.type !== 'version' || versionEvent.frozen !== true) {
  fail(`L'eseguibile non risponde correttamente a --version.\nstdout: ${check.stdout}\nstderr: ${check.stderr}`);
}
// Il motore multimediale deve essere incluso DAVVERO nell'eseguibile.
const engine = versionEvent.engine || {};
if (!engine.available) fail('PyAV non è incluso nell\'eseguibile: verifica "pip install -r src/python/requirements-build.txt".');
if (!engine.libmp3lame) fail('Le librerie FFmpeg incluse in PyAV non hanno l\'encoder libmp3lame.');
const license = classifyLicense(engine.configuration, engine.license);
if (!license.distributable) fail(`Licenza delle librerie FFmpeg incluse: ${license.classification}. ${license.note}`);

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
const buildInfo = {
  platformKey: targetKey,
  mode: onefile ? 'onefile' : 'onedir',
  debug,
  converterVersion: versionEvent.converter,
  python: versionEvent.python,
  pyinstaller: pyinstallerVersion,
  engine: {
    pyav: engine.pyav,
    ffmpegLibraries: engine.ffmpegLibraries,
    declaredLicense: engine.license,
    configuration: engine.configuration,
    libmp3lame: engine.libmp3lame
  },
  license,
  executableSha256: sha256,
  builtAt: new Date().toISOString()
};
fs.writeFileSync(path.join(outRoot, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);

log(`\nOK: convertitore ${versionEvent.converter} (Python ${versionEvent.python}) compilato per ${targetKey}`);
log(`    ${path.relative(ROOT, exe)}`);
log(`    SHA-256 ${sha256}`);
log(`    PyAV ${engine.pyav}, libavcodec ${engine.ffmpegLibraries.libavcodec}, libmp3lame: sì`);
log(`    Licenza librerie FFmpeg: ${license.classification} (dichiarata: ${engine.license})`);
if (license.gplLibraries.length) log(`    [AVVISO] ${license.note}`);
