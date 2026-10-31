'use strict';

/**
 * Registro dei file scelti dall'utente.
 *
 * Il renderer non lavora MAI con percorsi: quando l'utente sceglie un video
 * (dialog nativo o drag-and-drop) il main process verifica il file, lo
 * registra qui e restituisce al renderer soltanto un identificatore casuale
 * (fileId), il nome e la dimensione. Per avviare una conversione il renderer
 * invia il fileId: un renderer compromesso non può quindi indicare percorsi
 * arbitrari del disco.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./errors');
const { hasSupportedExtension, isPlausibleAbsolutePath, isValidId } = require('./validation');

class FileRegistry {
  constructor({ maxEntries = 20, logger } = {}) {
    this.entries = new Map();
    this.maxEntries = maxEntries;
    this.logger = logger || { info() {}, warn() {} };
  }

  /**
   * @param {string} filePath percorso ottenuto da dialog nativo o drop
   * @returns {Promise<{fileId: string, name: string, size: number}>}
   */
  async register(filePath) {
    if (!isPlausibleAbsolutePath(filePath)) throw new AppError('INVALID_ARGUMENTS', 'percorso non valido');
    const normalized = path.normalize(filePath);
    if (!hasSupportedExtension(normalized)) throw new AppError('UNSUPPORTED_FILE', `estensione: ${path.extname(normalized)}`);

    let stat;
    try {
      stat = await fs.promises.stat(normalized);
    } catch (err) {
      throw new AppError('INPUT_NOT_FOUND', err.code);
    }
    if (!stat.isFile()) throw new AppError('UNSUPPORTED_FILE', 'non è un file regolare');
    if (stat.size === 0) throw new AppError('EMPTY_FILE');
    try {
      await fs.promises.access(normalized, fs.constants.R_OK);
    } catch (err) {
      throw new AppError('INPUT_NOT_FOUND', err.code);
    }

    const fileId = crypto.randomUUID();
    const entry = { fileId, path: normalized, name: path.basename(normalized), size: stat.size, registeredAt: Date.now() };
    this.entries.set(fileId, entry);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    this.logger.info(`File registrato (${entry.size} byte, estensione ${path.extname(normalized).toLowerCase()})`);
    return { fileId, name: entry.name, size: entry.size };
  }

  /** Restituisce la voce interna (con percorso) solo al codice del main process. */
  get(fileId) {
    if (!isValidId(fileId)) return null;
    return this.entries.get(fileId) || null;
  }

  remove(fileId) {
    this.entries.delete(fileId);
  }
}

module.exports = { FileRegistry };
