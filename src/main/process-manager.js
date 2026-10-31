'use strict';

/**
 * Gestione del processo figlio del convertitore Python.
 *
 * Responsabilità:
 * - avviarlo SENZA shell, con argomenti passati come array;
 * - leggere stdout riga per riga e validare ogni evento JSON Lines;
 * - inoltrare stderr ai log tecnici (mai alla GUI);
 * - annullare in modo ordinato (scrivendo "cancel" su stdin) e, se il
 *   processo non risponde, terminarlo forzatamente insieme ai suoi figli.
 */

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const readline = require('node:readline');

const MAX_LINE_LENGTH = 64 * 1024;
const STATUS_VALUES = new Set(['analyzing', 'converting', 'finalizing']);
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isShortString(v, max = 500) {
  return typeof v === 'string' && v.length <= max;
}

/** Informazioni sul motore multimediale (PyAV + librerie FFmpeg) riportate da --version. */
function validateEngine(engine) {
  if (!engine || typeof engine !== 'object' || engine.available !== true) return { available: false };
  const libraries = {};
  if (engine.ffmpegLibraries && typeof engine.ffmpegLibraries === 'object') {
    for (const [name, version] of Object.entries(engine.ffmpegLibraries).slice(0, 12)) {
      if (/^lib[a-z]{2,16}$/.test(name) && isShortString(version, 32)) libraries[name] = version;
    }
  }
  return {
    available: true,
    pyav: isShortString(engine.pyav, 32) ? engine.pyav : '',
    ffmpegLibraries: libraries,
    license: isShortString(engine.license, 200) ? engine.license : '',
    configuration: isShortString(engine.configuration, 8000) ? engine.configuration : '',
    libmp3lame: engine.libmp3lame === true
  };
}

/**
 * Valida la struttura di un evento. Ritorna l'evento "pulito" (solo i campi
 * noti) oppure null. Tutto ciò che non è previsto viene scartato.
 */
function validateEvent(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  switch (obj.type) {
    case 'status':
      if (!STATUS_VALUES.has(obj.status)) return null;
      return { type: 'status', status: obj.status, message: isShortString(obj.message) ? obj.message : '' };
    case 'probe':
      if (obj.durationSeconds !== null && !(isFiniteNumber(obj.durationSeconds) && obj.durationSeconds >= 0)) return null;
      return {
        type: 'probe',
        durationSeconds: obj.durationSeconds,
        audioCodec: isShortString(obj.audioCodec, 64) ? obj.audioCodec : 'sconosciuto',
        container: isShortString(obj.container, 128) ? obj.container : 'sconosciuto',
        hasVideo: obj.hasVideo === true
      };
    case 'progress':
      if (obj.progress !== null && !(isFiniteNumber(obj.progress) && obj.progress >= 0 && obj.progress <= 100)) return null;
      if (!(isFiniteNumber(obj.processedSeconds) && obj.processedSeconds >= 0)) return null;
      return { type: 'progress', progress: obj.progress, processedSeconds: obj.processedSeconds };
    case 'completed':
      if (!isShortString(obj.outputPath, 32767) || !obj.outputPath) return null;
      return { type: 'completed', outputPath: obj.outputPath };
    case 'cancelled':
      return { type: 'cancelled' };
    case 'error':
      if (typeof obj.code !== 'string' || !ERROR_CODE.test(obj.code)) return null;
      return { type: 'error', code: obj.code, message: isShortString(obj.message) ? obj.message : '' };
    case 'version':
      if (!isShortString(obj.converter, 32)) return null;
      return {
        type: 'version',
        converter: obj.converter,
        python: isShortString(obj.python, 32) ? obj.python : '',
        protocol: isFiniteNumber(obj.protocol) ? obj.protocol : 0,
        frozen: obj.frozen === true,
        engine: validateEngine(obj.engine)
      };
    default:
      return null;
  }
}

/** @returns {{ ok: true, event: object } | { ok: false, reason: string }} */
function parseEventLine(line) {
  if (typeof line !== 'string') return { ok: false, reason: 'non-string' };
  const trimmed = line.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_LINE_LENGTH) return { ok: false, reason: 'too-long' };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const event = validateEvent(parsed);
  return event ? { ok: true, event } : { ok: false, reason: 'invalid-event' };
}

/**
 * Termina il processo e tutti i suoi discendenti.
 * - Windows: taskkill /T chiude l'intero albero di processi.
 * - POSIX: il processo è avviato con detached:true, quindi è capo di un
 *   "process group"; kill(-pid) invia il segnale a tutto il gruppo.
 */
function killTree(child, platform = process.platform) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    try {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* già terminato */ }
  }
}

class ConverterProcess extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.command   eseguibile (percorso assoluto in produzione)
   * @param {string[]} o.args    argomenti già validati
   * @param {object} [o.logger]
   * @param {boolean} [o.showConsole] solo debug Windows
   * @param {number} [o.killTimeoutMs] attesa prima della terminazione forzata
   * @param {Function} [o.spawnImpl] iniettabile nei test
   */
  constructor({ command, args, logger, showConsole = false, killTimeoutMs = 5000, spawnImpl = spawn, env }) {
    super();
    this.command = command;
    this.args = args;
    this.logger = logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.showConsole = showConsole;
    this.killTimeoutMs = killTimeoutMs;
    this.spawnImpl = spawnImpl;
    this.env = env;
    this.child = null;
    this.cancelRequested = false;
    this.exited = false;
    this.stderrTail = [];
    this.malformedLines = 0;
    this.killTimer = null;
  }

  start() {
    const isWindows = process.platform === 'win32';
    try {
      this.child = this.spawnImpl(this.command, this.args, {
        shell: false,                 // MAI una shell: nessuna interpretazione degli argomenti
        windowsHide: !this.showConsole,
        detached: !isWindows,         // process group su POSIX, per killTree
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...(this.env || process.env),
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONDONTWRITEBYTECODE: '1'
        }
      });
    } catch (err) {
      queueMicrotask(() => this.handleSpawnError(err));
      return this;
    }

    this.child.on('error', (err) => this.handleSpawnError(err));
    this.child.stdin.on('error', () => { /* EPIPE se il processo è già uscito */ });

    const out = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    out.on('line', (line) => this.handleStdoutLine(line));

    const err = readline.createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    err.on('line', (line) => {
      if (!line) return;
      this.stderrTail.push(line.slice(0, 2000));
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      this.logger.debug(`[converter stderr] ${line.slice(0, 2000)}`);
    });

    // 'close' (non 'exit'): arriva dopo che stdout e stderr sono stati letti
    // completamente, quindi nessun evento finale viene perso.
    this.child.on('close', (code, signal) => this.finish(code, signal));
    return this;
  }

  handleStdoutLine(line) {
    const result = parseEventLine(line);
    if (result.ok) {
      this.emit('event', result.event);
      return;
    }
    if (result.reason === 'empty') return;
    this.malformedLines += 1;
    // Le righe non valide sono registrate ma mai mostrate all'utente.
    this.logger.warn(`Riga JSON Lines scartata (${result.reason}): ${String(line).slice(0, 200)}`);
  }

  handleSpawnError(err) {
    if (this.exited) return;
    const code = err && (err.code === 'EACCES' || err.code === 'EPERM') ? 'BINARY_NOT_EXECUTABLE' : 'CONVERTER_NOT_FOUND';
    this.logger.error(`Avvio del convertitore fallito: ${err && err.code ? err.code : err}`);
    this.exited = true;
    this.clearKillTimer();
    this.emit('exit', { code: null, signal: null, spawnError: code });
  }

  finish(code, signal) {
    if (this.exited) return;
    this.exited = true;
    this.clearKillTimer();
    this.emit('exit', { code, signal, spawnError: null });
  }

  /** Annullamento cooperativo, con terminazione forzata come ripiego. */
  cancel() {
    if (this.exited || !this.child) return;
    this.cancelRequested = true;
    try {
      this.child.stdin.write('cancel\n');
      this.child.stdin.end();
    } catch {
      /* stdin già chiuso */
    }
    if (!this.killTimer) {
      this.killTimer = setTimeout(() => {
        this.logger.warn('Il convertitore non ha risposto all’annullamento: terminazione forzata');
        killTree(this.child);
      }, this.killTimeoutMs);
      this.killTimer.unref?.();
    }
  }

  forceKill() {
    killTree(this.child);
  }

  clearKillTimer() {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
  }
}

module.exports = { ConverterProcess, parseEventLine, validateEvent, killTree, MAX_LINE_LENGTH };
