'use strict';

/**
 * Controllo pre-packaging: eseguito automaticamente da `npm run package/make*`.
 *
 * Blocca la creazione del pacchetto se manca qualcosa, invece di produrre un
 * installer che si avvia ma non converte, o che viola le licenze. Verifica, per ogni target:
 *   - convertitore PyInstaller presente e dell'architettura corretta;
 *   - build-info.json: PyAV incluso, encoder libmp3lame presente, licenza ridistribuibile;
 *   - resources/third-party/<target>/: licenze integrali e sorgente corrispondente
 *     generati per LA STESSA versione di PyAV, con tutti i file integri (SHA-256);
 *   - file di licenza del progetto presenti.
 * Su macOS/Linux imposta anche i permessi di esecuzione.
 *
 * Uso: node scripts/prepare-resources.js [--platform darwin] [--arch arm64]
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, parseArgs, log, fail } = require('./lib/common');
const { executableName } = require('../src/main/resource-resolver');
const { inspectFile, isCompatible } = require('../src/main/binary-inspector');

const args = parseArgs();
const platform = args.platform || process.platform;
// Senza --arch: macOS produce DMG arm64 + x64 (vedi electron-builder.config.js),
// Windows e Linux producono x64.
const archs = args.arch ? [args.arch] : platform === 'darwin' ? ['arm64', 'x64'] : ['x64'];

if (platform !== process.platform) {
  fail(
    `Packaging per ${platform} richiesto su ${process.platform}.\n` +
    'Il convertitore PyInstaller va prodotto e verificato sul sistema di destinazione: ' +
    'esegui questo comando su quel sistema (vedi docs/PACKAGING.md, "Matrice di build").'
  );
}

const REQUIRED_LICENSES = ['THIRD-PARTY-NOTICES.txt', 'APP-LICENSE.txt'];
const problems = [];

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function checkThirdParty(key, buildInfo) {
  const dir = path.join(ROOT, 'resources', 'third-party', key);
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    problems.push(`licenze e sorgenti del convertitore mancanti per ${key}: esegui "npm run third-party" su ${key}`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (buildInfo?.engine?.pyav && manifest.pyav !== buildInfo.engine.pyav) {
    problems.push(`${key}: licenze/sorgenti generati per PyAV ${manifest.pyav}, ma il convertitore usa PyAV ${buildInfo.engine.pyav}: rigenera con "npm run third-party"`);
    return;
  }
  for (const required of ['LICENSES.txt', 'SOURCES.md']) {
    if (!manifest.files.some((f) => f.path === required)) problems.push(`${key}: ${required} assente nel manifesto`);
  }
  let checked = 0;
  for (const file of manifest.files) {
    const full = path.join(dir, ...file.path.split('/'));
    if (!fs.existsSync(full)) {
      problems.push(`${key}: file mancante third-party/${file.path}`);
    } else if (sha256File(full) !== file.sha256) {
      problems.push(`${key}: file modificato third-party/${file.path} (SHA-256 diverso)`);
    } else {
      checked += 1;
    }
  }
  log(`  licenze e sorgente corrispondente: ${checked}/${manifest.files.length} file integri (PyAV ${manifest.pyav}, ${manifest.license})`);
}

for (const arch of archs) {
  const key = `${platform}-${arch}`;
  log(`Controllo risorse per ${key}...`);
  const base = path.join(ROOT, 'resources', 'python-converter', key);
  const exe = path.join(base, 'converter', executableName('converter', platform));
  if (!fs.existsSync(exe)) {
    problems.push(`convertitore mancante per ${key}: esegui "npm run build:python" su ${key}`);
    continue;
  }
  if (platform !== 'win32') fs.chmodSync(exe, 0o755);
  const info = inspectFile(exe);
  if (!isCompatible(info, platform, arch)) {
    problems.push(`convertitore ${key} è ${info.platform}/${info.archs.join('+') || '?'}, atteso ${platform}/${arch}`);
  }

  const buildInfoFile = path.join(base, 'build-info.json');
  if (!fs.existsSync(buildInfoFile)) {
    problems.push(`build-info.json mancante per ${key}: ricompila con "npm run build:python"`);
    continue;
  }
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoFile, 'utf8'));
  if (!buildInfo.engine || !buildInfo.engine.libmp3lame) problems.push(`${key}: PyAV/libmp3lame non inclusi nel convertitore`);
  if (!buildInfo.license || buildInfo.license.distributable !== true) problems.push(`${key}: licenza non ridistribuibile (${buildInfo.license?.classification})`);
  if (buildInfo.debug) problems.push(`${key}: il convertitore è una build di DEBUG, ricompila senza --debug`);
  if (buildInfo.license) log(`  licenza del convertitore: ${buildInfo.license.classification} (distribuito sotto GPL, sorgente incluso)`);

  checkThirdParty(key, buildInfo);
}

// Le licenze del progetto hanno un'unica fonte (radice): le copiamo qui
// così il pacchetto contiene sempre la versione aggiornata.
const licensesDir = path.join(ROOT, 'resources', 'licenses');
fs.copyFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.txt'), path.join(licensesDir, 'THIRD-PARTY-NOTICES.txt'));
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(licensesDir, 'APP-LICENSE.txt'));
for (const file of REQUIRED_LICENSES) {
  if (!fs.existsSync(path.join(licensesDir, file))) problems.push(`licenza mancante: resources/licenses/${file}`);
}

if (problems.length) {
  for (const p of problems) log(`  [ERRORE] ${p}`);
  fail('Risorse incomplete: il pacchetto NON è stato creato. Vedi docs/PACKAGING.md.');
}
log('Risorse complete: si procede con electron-builder.');
