'use strict';

/**
 * Job manager: ciclo di vita delle conversioni.
 *
 *   queued -> analyzing -> converting -> finalizing -> completed
 *                    \           \            \
 *                     +-----------+------------+--> failed | cancelling -> cancelled
 *
 * Ogni job ha:
 * - un ID casuale (UUID v4), unico riferimento noto al renderer;
 * - una cartella temporanea dedicata: <tempRoot>/<jobId>/;
 * - un nome di output interno fisso ("output.mp3"): il nome originale del
 *   video è conservato solo come metadato, mai usato per costruire percorsi.
 *
 * Questo modulo NON dipende da Electron: si testa con Node.js puro.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ConverterProcess } = require('./process-manager');
const { AppError, toUserError, isKnownCode } = require('./errors');
const { parseBitrate, isInside, isValidId } = require('./validation');

const ACTIVE_STATES = new Set(['queued', 'analyzing', 'converting', 'finalizing', 'cancelling']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

function samePath(a, b) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

class JobManager {
  /**
   * @param {object} o
   * @param {string} o.tempRoot cartella temporanea della sessione
   * @param {import('./file-registry').FileRegistry} o.fileRegistry
   * @param {() => {ready: boolean, converter: {command: string, args: string[]}}} o.getResources
   * @param {object} [o.logger]
   * @param {(opts: object) => ConverterProcess} [o.createProcess] iniettabile nei test
   */
  constructor({ tempRoot, fileRegistry, getResources, logger, createProcess, maxJobs = 20, cancelTimeoutMs = 5000, showConsole = false }) {
    if (!tempRoot || !path.isAbsolute(tempRoot)) throw new Error('tempRoot deve essere un percorso assoluto');
    this.tempRoot = tempRoot;
    this.fileRegistry = fileRegistry;
    this.getResources = getResources;
    this.logger = logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.createProcess = createProcess || ((opts) => new ConverterProcess(opts));
    this.maxJobs = maxJobs;
    this.cancelTimeoutMs = cancelTimeoutMs;
    this.showConsole = showConsole;
    this.jobs = new Map();
    this.shuttingDown = false;
  }

  async init() {
    // 0o700: su Linux /tmp è condiviso fra utenti; la cartella resta privata.
    await fs.promises.mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
  }

  hasActiveJob() {
    for (const job of this.jobs.values()) if (ACTIVE_STATES.has(job.state)) return true;
    return false;
  }

  /**
   * @returns {Promise<object>} vista pubblica del job
   */
  async createJob({ fileId, bitrate }) {
    if (this.shuttingDown) throw new AppError('SHUTTING_DOWN');
    const kbps = parseBitrate(bitrate);
    if (kbps === null) throw new AppError('INVALID_BITRATE', `ricevuto: ${String(bitrate).slice(0, 20)}`);
    const file = this.fileRegistry.get(fileId);
    if (!file) throw new AppError('FILE_NOT_REGISTERED');
    if (this.hasActiveJob()) throw new AppError('JOB_ALREADY_RUNNING');

    const resources = this.getResources();
    if (!resources.ready) throw new AppError('RESOURCES_NOT_READY');

    await this.pruneFinishedJobs();

    const id = crypto.randomUUID();
    const dir = path.join(this.tempRoot, id);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

    let resolveExit;
    const job = {
      id,
      state: 'queued',
      progress: 0,
      processedSeconds: 0,
      durationSeconds: null,
      audioCodec: null,
      container: null,
      originalName: file.name,
      inputSize: file.size,
      bitrate: kbps,
      dir,
      inputPath: file.path,
      outputPath: path.join(dir, 'output.mp3'),
      outputSize: null,
      saved: false,
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      cancelRequested: false,
      completedEvent: null,
      errorEvent: null,
      process: null,
      exited: new Promise((resolve) => { resolveExit = resolve; })
    };
    job.resolveExit = resolveExit;
    this.jobs.set(id, job);

    const args = [
      ...resources.converter.args,
      '--input', job.inputPath,
      '--output', job.outputPath,
      '--bitrate', String(kbps),
      '--control-stdin'
    ];
    const proc = this.createProcess({
      command: resources.converter.command,
      args,
      logger: this.logger,
      killTimeoutMs: this.cancelTimeoutMs,
      showConsole: this.showConsole
    });
    job.process = proc;
    proc.on('event', (event) => this.handleEvent(job, event));
    proc.on('exit', (info) => {
      this.handleExit(job, info).catch((err) => this.logger.error('Errore nella chiusura del job', err));
    });
    this.logger.info(`Job ${id} avviato (bitrate ${kbps} kbps)`);
    proc.start();
    return this.toPublic(job);
  }

  handleEvent(job, event) {
    if (TERMINAL_STATES.has(job.state)) return;
    switch (event.type) {
      case 'status':
        if (job.state !== 'cancelling') job.state = event.status;
        break;
      case 'probe':
        job.durationSeconds = event.durationSeconds;
        job.audioCodec = event.audioCodec;
        job.container = event.container;
        break;
      case 'progress':
        if (event.progress !== null) job.progress = Math.max(job.progress, event.progress);
        job.processedSeconds = event.processedSeconds;
        break;
      case 'completed':
        job.completedEvent = event;
        break;
      case 'error':
        job.errorEvent = event;
        break;
      default:
        break;
    }
  }

  async handleExit(job, { code, signal, spawnError }) {
    try {
      if (spawnError) {
        await this.fail(job, spawnError, 'avvio fallito');
      } else if (job.completedEvent && code === 0) {
        await this.verifyAndComplete(job);
      } else if (job.cancelRequested) {
        job.state = 'cancelled';
        job.error = toUserError('CONVERSION_CANCELLED');
        job.finishedAt = Date.now();
        this.logger.info(`Job ${job.id} annullato`);
        await this.cleanupJobDir(job);
      } else if (job.errorEvent) {
        const errCode = isKnownCode(job.errorEvent.code) ? job.errorEvent.code : 'INTERNAL_ERROR';
        await this.fail(job, errCode, `exit ${code}: ${job.errorEvent.code}`);
      } else if (code === 0) {
        await this.fail(job, 'PROTOCOL_ERROR', 'uscita 0 senza evento completed');
      } else {
        await this.fail(job, 'PROCESS_CRASHED', `exit code ${code}, segnale ${signal}`);
      }
    } finally {
      job.process = null;
      job.resolveExit();
    }
  }

  async verifyAndComplete(job) {
    if (!samePath(job.completedEvent.outputPath, job.outputPath)) {
      return this.fail(job, 'PROTOCOL_ERROR', 'outputPath diverso da quello richiesto');
    }
    let size = 0;
    try {
      size = (await fs.promises.stat(job.outputPath)).size;
    } catch {
      size = 0;
    }
    if (size <= 0) return this.fail(job, 'PROTOCOL_ERROR', 'file di output assente o vuoto');
    job.state = 'completed';
    job.progress = 100;
    job.outputSize = size;
    job.finishedAt = Date.now();
    this.logger.info(`Job ${job.id} completato (${size} byte)`);
    return undefined;
  }

  async fail(job, code, detail) {
    job.state = 'failed';
    job.error = toUserError(code);
    job.finishedAt = Date.now();
    this.logger.warn(`Job ${job.id} fallito: ${code} (${detail})`);
    await this.cleanupJobDir(job);
  }

  getInternal(id) {
    if (!isValidId(id)) return null;
    return this.jobs.get(id) || null;
  }

  getPublic(id) {
    const job = this.getInternal(id);
    if (!job) throw new AppError('JOB_NOT_FOUND');
    return this.toPublic(job);
  }

  cancel(id) {
    const job = this.getInternal(id);
    if (!job) throw new AppError('JOB_NOT_FOUND');
    if (!ACTIVE_STATES.has(job.state)) return this.toPublic(job);
    job.cancelRequested = true;
    job.state = 'cancelling';
    if (job.process) job.process.cancel();
    this.logger.info(`Annullamento richiesto per il job ${id}`);
    return this.toPublic(job);
  }

  /** Elimina un job: se attivo lo annulla, poi rimuove i file temporanei. */
  async remove(id) {
    const job = this.getInternal(id);
    if (!job) throw new AppError('JOB_NOT_FOUND');
    if (ACTIVE_STATES.has(job.state)) {
      this.cancel(id);
      await job.exited;
    }
    await this.cleanupJobDir(job);
    this.jobs.delete(id);
  }

  /** Percorso interno dell'MP3, solo per il main process (mai inviato al renderer). */
  getResultForSave(id) {
    const job = this.getInternal(id);
    if (!job) throw new AppError('JOB_NOT_FOUND');
    if (job.state !== 'completed' || job.saved) throw new AppError('JOB_NOT_COMPLETED');
    return { outputPath: job.outputPath, originalName: job.originalName };
  }

  async markSaved(id) {
    const job = this.getInternal(id);
    if (!job) return;
    job.saved = true;
    await this.cleanupJobDir(job);
  }

  async cleanupJobDir(job) {
    // Difesa: si cancella solo ciò che sta dentro la cartella temporanea dell'app.
    if (!isInside(this.tempRoot, job.dir)) {
      this.logger.error('Cleanup rifiutato: cartella fuori dalla radice temporanea');
      return;
    }
    try {
      await fs.promises.rm(job.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (err) {
      this.logger.warn(`Cleanup del job ${job.id} non riuscito: ${err.code || err.message}`);
    }
  }

  async pruneFinishedJobs() {
    const finished = [...this.jobs.values()].filter((j) => TERMINAL_STATES.has(j.state));
    const excess = this.jobs.size - this.maxJobs + 1;
    for (const job of finished.slice(0, Math.max(0, excess))) {
      await this.cleanupJobDir(job);
      this.jobs.delete(job.id);
    }
  }

  /**
   * Graceful shutdown: annulla i job attivi, attende la loro uscita (con
   * timeout), forza la chiusura dei processi rimasti e rimuove i temporanei.
   */
  async shutdown({ timeoutMs = 8000 } = {}) {
    this.shuttingDown = true;
    const active = [...this.jobs.values()].filter((j) => ACTIVE_STATES.has(j.state));
    for (const job of active) this.cancel(job.id);

    if (active.length) {
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
      const outcome = await Promise.race([Promise.all(active.map((j) => j.exited)), timeout]);
      clearTimeout(timer);
      if (outcome === 'timeout') {
        this.logger.warn('Timeout nello shutdown: terminazione forzata dei processi');
        for (const job of active) job.process?.forceKill();
      }
    }

    try {
      await fs.promises.rm(this.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      this.logger.warn(`Rimozione della cartella temporanea non riuscita: ${err.code || err.message}`);
    }
    this.jobs.clear();
  }

  /** Vista pubblica: niente percorsi, niente dettagli tecnici. */
  toPublic(job) {
    return {
      id: job.id,
      state: job.state,
      progress: Math.round(job.progress * 10) / 10,
      processedSeconds: job.processedSeconds,
      durationSeconds: job.durationSeconds,
      audioCodec: job.audioCodec,
      originalName: job.originalName,
      bitrate: job.bitrate,
      outputSize: job.outputSize,
      saved: job.saved,
      error: job.error,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt
    };
  }
}

/**
 * Rimuove le cartelle temporanee lasciate da sessioni precedenti terminate
 * in modo anomalo (crash, spegnimento). Sicuro grazie al single-instance lock.
 */
async function cleanupStaleSessions(baseDir, currentSessionDir, logger) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
    const full = path.join(baseDir, entry.name);
    if (samePath(full, currentSessionDir)) continue;
    try {
      await fs.promises.rm(full, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      logger?.warn(`Temporaneo precedente non rimosso: ${err.code}`);
    }
  }
  return removed;
}

module.exports = { JobManager, cleanupStaleSessions, ACTIVE_STATES, TERMINAL_STATES };
