'use strict';

/**
 * Logger locale minimale, senza dipendenze esterne.
 *
 * - livelli: debug, info, warn, error (debug attivo solo in modalità debug);
 * - rotazione: quando app.log supera maxBytes diventa app.1.log, ecc.;
 * - sanitizzazione: la cartella home e il nome utente vengono sostituiti,
 *   così i log condivisi per assistenza non rivelano dati personali;
 * - nessun invio in rete: i log restano solo sul computer dell'utente.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createSanitizer({ homeDir = os.homedir(), userName = safeUserName() } = {}) {
  const patterns = [];
  if (homeDir && homeDir.length > 3) {
    // Sia con backslash sia con slash: i percorsi Windows compaiono in entrambe le forme.
    patterns.push([new RegExp(escapeRegExp(homeDir), 'gi'), '~']);
    patterns.push([new RegExp(escapeRegExp(homeDir.replace(/\\/g, '/')), 'gi'), '~']);
  }
  if (userName && userName.length > 2) {
    patterns.push([new RegExp(`\\b${escapeRegExp(userName)}\\b`, 'gi'), '<utente>']);
  }
  // Regole generiche: coprono anche i nomi brevi 8.3 di Windows (es. C:\Users\MARIO~1.ROS)
  // e le cartelle home di altri utenti, che le regole precedenti non riconoscono.
  patterns.push([/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"'<>|]+/gi, '~']);
  patterns.push([/(^|[\s"'(=])\/(?:Users|home)\/[^/\s"']+/g, '$1~']);
  return function sanitize(value) {
    let text = typeof value === 'string' ? value : safeStringify(value);
    for (const [pattern, replacement] of patterns) text = text.replace(pattern, replacement);
    return text;
  };
}

function safeUserName() {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

function safeStringify(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}${value.code ? ` (${value.code})` : ''}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

class Logger {
  /**
   * @param {object} options
   * @param {string|null} options.dir cartella dei log (null = solo console)
   * @param {boolean} [options.debug]
   * @param {number} [options.maxBytes]
   * @param {number} [options.maxFiles]
   * @param {boolean} [options.console]
   */
  constructor({ dir, debug = false, maxBytes = 1024 * 1024, maxFiles = 3, console: toConsole = true, sanitize } = {}) {
    this.dir = dir || null;
    this.file = this.dir ? path.join(this.dir, 'app.log') : null;
    this.minLevel = debug ? LEVELS.debug : LEVELS.info;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.toConsole = toConsole;
    this.sanitize = sanitize || createSanitizer();
    this.recent = [];
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
      } catch {
        this.file = null;
      }
    }
  }

  debug(...parts) { this.write('debug', parts); }
  info(...parts) { this.write('info', parts); }
  warn(...parts) { this.write('warn', parts); }
  error(...parts) { this.write('error', parts); }

  write(level, parts) {
    if (LEVELS[level] < this.minLevel) return;
    const message = this.sanitize(parts.map((p) => (typeof p === 'string' ? p : safeStringify(p))).join(' '));
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
    this.recent.push(line);
    if (this.recent.length > 200) this.recent.shift();
    if (this.toConsole) {
      const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      stream.write(`${line}\n`);
    }
    if (!this.file) return;
    try {
      this.rotateIfNeeded();
      // Scrittura sincrona: semplice e non perde righe in caso di crash.
      // Il volume di log di questa app è minimo, quindi il costo è trascurabile.
      fs.appendFileSync(this.file, `${line}\n`, 'utf8');
    } catch {
      // Un errore di logging non deve mai far fallire l'applicazione.
    }
  }

  rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;
    for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
      const from = i === 1 ? this.file : path.join(this.dir, `app.${i - 1}.log`);
      const to = path.join(this.dir, `app.${i}.log`);
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        /* ignorato */
      }
    }
  }

  /** Ultime righe già sanitizzate, per la diagnostica copiabile. */
  tail(count = 30) {
    return this.recent.slice(-count);
  }
}

module.exports = { Logger, createSanitizer, LEVELS };
