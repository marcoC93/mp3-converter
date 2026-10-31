'use strict';

/**
 * Risoluzione delle risorse native (il convertitore Python).
 *
 * È l'UNICO modulo che conosce la differenza fra sviluppo e produzione.
 * main.js legge app.isPackaged una sola volta e crea un "runtime context";
 * tutte le altre parti ricevono percorsi già risolti. Così non ci sono
 * controlli `isPackaged` sparsi nel codice, difficili da testare.
 *
 * Il convertitore contiene già il motore multimediale (PyAV, con le librerie
 * FFmpeg al suo interno): non esistono binari ffmpeg/ffprobe separati.
 *
 * Struttura attesa:
 *   sviluppo   <progetto>/src/python/convert.py (eseguito con il Python del .venv)
 *   produzione <app>/resources/python-converter/<piattaforma>-<arch>/converter/converter[.exe]
 */

const fs = require('node:fs');
const path = require('node:path');
const { inspectFile, isCompatible } = require('./binary-inspector');

const SUPPORTED_PLATFORM_KEYS = Object.freeze([
  'win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'
]);

class UnsupportedPlatformError extends Error {
  constructor(key) {
    super(`Piattaforma non supportata: ${key}`);
    this.code = 'UNSUPPORTED_PLATFORM';
  }
}

function getPlatformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED_PLATFORM_KEYS.includes(key)) throw new UnsupportedPlatformError(key);
  return key;
}

function executableName(base, platform) {
  return platform === 'win32' ? `${base}.exe` : base;
}

/**
 * @param {object} o
 * @param {boolean} o.isPackaged   app.isPackaged (letto SOLO in main.js)
 * @param {string}  o.appRoot      app.getAppPath(): radice del codice (in produzione è dentro app.asar)
 * @param {string}  [o.resourcesPath] process.resourcesPath: cartella resources/ del pacchetto
 * @param {string}  [o.platform]
 * @param {string}  [o.arch]
 * @param {object}  [o.env]
 */
function createRuntimeContext({ isPackaged, appRoot, resourcesPath, platform = process.platform, arch = process.arch, env = process.env }) {
  if (typeof appRoot !== 'string' || !appRoot) throw new Error('appRoot obbligatorio');
  if (isPackaged && !resourcesPath) throw new Error('resourcesPath obbligatorio in produzione');
  const p = platform === 'win32' ? path.win32 : path.posix;
  return Object.freeze({
    mode: isPackaged ? 'production' : 'development',
    isPackaged: Boolean(isPackaged),
    appRoot,
    resourceRoot: isPackaged ? resourcesPath : p.join(appRoot, 'resources'),
    platform,
    arch,
    platformKey: getPlatformKey(platform, arch),
    env: Object.freeze({ ...env })
  });
}

function pathApi(ctx) {
  // Permette ai test di simulare Windows su Linux e viceversa.
  return ctx.platform === 'win32' ? path.win32 : path.posix;
}

function compiledConverterPath(ctx) {
  const p = pathApi(ctx);
  return p.join(ctx.resourceRoot, 'python-converter', ctx.platformKey, 'converter', executableName('converter', ctx.platform));
}

function defaultDevPython(ctx, exists) {
  const p = pathApi(ctx);
  const venvPython = ctx.platform === 'win32'
    ? p.join(ctx.appRoot, '.venv', 'Scripts', 'python.exe')
    : p.join(ctx.appRoot, '.venv', 'bin', 'python3');
  if (exists(venvPython)) return venvPython;
  return ctx.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Restituisce come avviare il convertitore.
 *  - produzione: l'eseguibile PyInstaller incluso nel pacchetto;
 *  - sviluppo:   lo script convert.py con il Python locale (che deve avere PyAV)
 *                o l'eseguibile compilato se VIDEO2MP3_USE_BUILT_CONVERTER=1.
 *
 * @returns {{ kind: 'compiled'|'script', command: string, args: string[] }}
 */
function resolveConverterExecutable(ctx, { exists = fs.existsSync } = {}) {
  if (ctx.isPackaged || ctx.env.VIDEO2MP3_USE_BUILT_CONVERTER === '1') {
    return { kind: 'compiled', command: compiledConverterPath(ctx), args: [] };
  }
  const p = pathApi(ctx);
  const script = p.join(ctx.appRoot, 'src', 'python', 'convert.py');
  const python = ctx.env.VIDEO2MP3_PYTHON || defaultDevPython(ctx, exists);
  // -u: output non bufferizzato; -I: modalità isolata (ignora variabili PYTHON*
  // e la cartella corrente), così il comportamento è più vicino alla build.
  return { kind: 'script', command: python, args: ['-u', '-I', script] };
}

function resolveLicensesDir(ctx) {
  return pathApi(ctx).join(ctx.resourceRoot, 'licenses');
}

/**
 * Licenze integrali e sorgente corrispondente dei componenti del convertitore
 * (generati da scripts/prepare-third-party.js, inclusi nel pacchetto).
 */
function resolveThirdPartyDir(ctx) {
  return pathApi(ctx).join(ctx.resourceRoot, 'third-party', ctx.platformKey);
}

function resolveRendererDir(ctx) {
  return pathApi(ctx).join(ctx.appRoot, 'src', 'renderer');
}

/**
 * Controlla un eseguibile senza eseguirlo.
 * @returns {{ ok: true } | { ok: false, code: string, detail: string }}
 */
function checkExecutable(filePath, { platform, arch, notFoundCode }, deps = {}) {
  const statSync = deps.statSync || fs.statSync;
  const accessSync = deps.accessSync || fs.accessSync;
  const inspect = deps.inspectFile || inspectFile;
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return { ok: false, code: notFoundCode, detail: `mancante: ${filePath}` };
  }
  if (!stat.isFile()) return { ok: false, code: notFoundCode, detail: `non è un file: ${filePath}` };
  if (platform !== 'win32') {
    try {
      accessSync(filePath, fs.constants.X_OK);
    } catch {
      return { ok: false, code: 'BINARY_NOT_EXECUTABLE', detail: `senza permesso di esecuzione: ${filePath}` };
    }
  }
  let info;
  try {
    info = inspect(filePath);
  } catch (err) {
    return { ok: false, code: notFoundCode, detail: `illeggibile: ${filePath} (${err.code || err.message})` };
  }
  if (!isCompatible(info, platform, arch)) {
    return {
      ok: false,
      code: 'BINARY_WRONG_ARCH',
      detail: `${filePath} è ${info.platform || 'sconosciuto'}/${info.archs.join('+') || '?'}, atteso ${platform}/${arch}`
    };
  }
  return { ok: true };
}

/**
 * Verifica statica all'avvio (senza eseguire nulla): il convertitore esiste,
 * è eseguibile ed è dell'architettura giusta. La verifica del motore
 * multimediale (PyAV + libmp3lame) avviene subito dopo in main.js
 * eseguendo `converter --version`.
 */
function checkResources(ctx, deps = {}) {
  const exists = deps.exists || fs.existsSync;
  const problems = [];
  const converter = resolveConverterExecutable(ctx, { exists });
  if (converter.kind === 'compiled') {
    const check = checkExecutable(converter.command, { platform: ctx.platform, arch: ctx.arch, notFoundCode: 'CONVERTER_NOT_FOUND' }, deps);
    if (!check.ok) problems.push({ component: 'converter', ...check });
  } else {
    const script = converter.args[converter.args.length - 1];
    if (!exists(script)) {
      problems.push({ component: 'converter', ok: false, code: 'CONVERTER_NOT_FOUND', detail: `script mancante: ${script}` });
    }
  }
  return { ready: problems.length === 0, problems, converter };
}

/**
 * Valuta l'evento `version` del convertitore e aggiunge eventuali problemi
 * del motore multimediale allo stato delle risorse.
 */
function applyEngineCheck(status, versionEvent) {
  const problems = [...status.problems];
  if (!versionEvent) {
    problems.push({ component: 'converter', ok: false, code: 'CONVERTER_NOT_FOUND', detail: 'il convertitore non risponde a --version' });
  } else if (!versionEvent.engine || !versionEvent.engine.available) {
    problems.push({ component: 'engine', ok: false, code: 'MEDIA_ENGINE_MISSING', detail: 'PyAV non importabile' });
  } else if (!versionEvent.engine.libmp3lame) {
    problems.push({ component: 'engine', ok: false, code: 'ENCODER_NOT_AVAILABLE', detail: 'libmp3lame assente' });
  }
  return { ...status, ready: problems.length === 0, problems };
}

module.exports = {
  SUPPORTED_PLATFORM_KEYS,
  UnsupportedPlatformError,
  getPlatformKey,
  executableName,
  createRuntimeContext,
  resolveConverterExecutable,
  resolveLicensesDir,
  resolveThirdPartyDir,
  resolveRendererDir,
  checkExecutable,
  checkResources,
  applyEngineCheck
};
