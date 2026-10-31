'use strict';

/**
 * Allowlist e validazione dei messaggi IPC (logica pura, testabile senza Electron).
 *
 * Il renderer è considerato NON fidato: ogni canale ha un validatore che
 * accetta solo la forma esatta prevista. Canali non elencati non esistono.
 * I nomi dei canali sono duplicati in preload.js perché un preload in
 * sandbox non può importare file locali: un test verifica che coincidano.
 */

const { isValidId, isPlausibleAbsolutePath } = require('./validation');

const EXTERNAL_LINKS = Object.freeze({
  ffmpeg: 'https://ffmpeg.org/',
  ffmpegLegal: 'https://ffmpeg.org/legal.html',
  pyav: 'https://github.com/PyAV-Org/PyAV',
  lame: 'https://lame.sourceforge.io/',
  electron: 'https://www.electronjs.org/',
  python: 'https://www.python.org/',
  pyinstaller: 'https://pyinstaller.org/'
});

const noArgs = (args) => (args.length === 0 ? { ok: true, value: undefined } : { ok: false });

const IPC_CHANNELS = Object.freeze({
  'app:get-api-config': noArgs,
  'file:select-video': noArgs,
  'file:register-dropped': (args) =>
    args.length === 1 && isPlausibleAbsolutePath(args[0]) ? { ok: true, value: args[0] } : { ok: false },
  'job:save-result': (args) => (args.length === 1 && isValidId(args[0]) ? { ok: true, value: args[0] } : { ok: false }),
  'app:open-logs-folder': noArgs,
  'app:copy-diagnostics': noArgs,
  'app:open-external': (args) =>
    args.length === 1 && typeof args[0] === 'string' && Object.prototype.hasOwnProperty.call(EXTERNAL_LINKS, args[0])
      ? { ok: true, value: EXTERNAL_LINKS[args[0]] }
      : { ok: false }
});

function validateIpcMessage(channel, args) {
  if (!Object.prototype.hasOwnProperty.call(IPC_CHANNELS, channel)) return { ok: false };
  if (!Array.isArray(args)) return { ok: false };
  return IPC_CHANNELS[channel](args);
}

/** Il mittente deve essere il frame principale della nostra finestra, servito dalla nostra origine. */
function isTrustedSenderUrl(senderUrl, expectedOrigin) {
  if (typeof senderUrl !== 'string' || typeof expectedOrigin !== 'string') return false;
  try {
    return new URL(senderUrl).origin === expectedOrigin;
  } catch {
    return false;
  }
}

module.exports = { IPC_CHANNELS, EXTERNAL_LINKS, validateIpcMessage, isTrustedSenderUrl };
