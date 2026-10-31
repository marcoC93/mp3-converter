'use strict';

/**
 * Funzioni di validazione PURE (nessuna dipendenza da Electron):
 * sono condivise da Express, IPC e job manager e si testano facilmente.
 */

const path = require('node:path');

const ALLOWED_BITRATES = Object.freeze([128, 192, 256, 320]);
const DEFAULT_BITRATE = 192;

const QUALITY_OPTIONS = Object.freeze([
  { bitrate: 128, label: 'Standard', description: 'File più piccoli, adatto al parlato' },
  { bitrate: 192, label: 'Alta', description: 'Ottimo compromesso (consigliato)' },
  { bitrate: 256, label: 'Molto alta', description: 'Per musica di buona qualità' },
  { bitrate: 320, label: 'Massima', description: 'Il massimo per MP3, file più grandi' }
]);

// Primo filtro sul nome del file. NON è una garanzia: la validità reale
// del contenuto viene verificata dal convertitore (PyAV) prima di convertire.
const SUPPORTED_EXTENSIONS = Object.freeze([
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.mpeg', '.mpg', '.m4v', '.flv', '.wmv'
]);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// 32767 è il limite dei percorsi estesi su Windows: oltre è sicuramente invalido.
const MAX_PATH_LENGTH = 32767;

function parseBitrate(value) {
  if (typeof value === 'number' && Number.isInteger(value) && ALLOWED_BITRATES.includes(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d{3}$/.test(value)) {
    const n = Number(value);
    if (ALLOWED_BITRATES.includes(n)) return n;
  }
  return null;
}

function isValidId(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

function hasSupportedExtension(filePath) {
  if (typeof filePath !== 'string') return false;
  return SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/**
 * Verifica formale di un percorso assoluto ricevuto dal sistema (dialog o drop).
 * Non accede al disco: l'esistenza viene controllata dal chiamante.
 */
function isPlausibleAbsolutePath(value, platformPath = path) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes('\0') &&
    platformPath.isAbsolute(value)
  );
}

/**
 * Restituisce true se `child` si trova dentro `parent` (dopo la normalizzazione).
 * Serve a garantire che il cleanup non cancelli mai nulla fuori dalla
 * cartella temporanea dell'applicazione.
 */
function isInside(parent, child, platformPath = path) {
  const relative = platformPath.relative(platformPath.resolve(parent), platformPath.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !platformPath.isAbsolute(relative);
}

/**
 * Nome suggerito per il salvataggio: "video.mkv" -> "video.mp3".
 * Rimuove caratteri non validi su Windows/macOS/Linux ma conserva Unicode e spazi.
 */
function suggestMp3Name(originalName) {
  const base = path.basename(String(originalName || ''), path.extname(String(originalName || '')));
  let safe = base
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!safe || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe)) safe = 'audio';
  if (safe.length > 180) safe = safe.slice(0, 180);
  return `${safe}.mp3`;
}

/** Garantisce l'estensione .mp3 sul percorso scelto dall'utente. */
function ensureMp3Extension(filePath) {
  return path.extname(filePath).toLowerCase() === '.mp3' ? filePath : `${filePath}.mp3`;
}

module.exports = {
  ALLOWED_BITRATES,
  DEFAULT_BITRATE,
  QUALITY_OPTIONS,
  SUPPORTED_EXTENSIONS,
  MAX_PATH_LENGTH,
  parseBitrate,
  isValidId,
  hasSupportedExtension,
  isPlausibleAbsolutePath,
  isInside,
  suggestMp3Name,
  ensureMp3Extension
};
