'use strict';

/**
 * Gestori IPC del main process.
 *
 * Usiamo IPC solo per ciò che richiede privilegi nativi: dialog del sistema,
 * percorsi dei file, clipboard, apertura della cartella dei log e di link
 * esterni dall'allowlist. Tutto il resto (job, progresso) passa dall'API
 * Express locale.
 *
 * Ogni gestore:
 * 1. verifica che il mittente sia la nostra pagina (origine del server locale);
 * 2. valida gli argomenti con l'allowlist di ipc-validation.js;
 * 3. restituisce sempre { ok: true, ... } oppure { ok: false, error },
 *    senza lanciare eccezioni verso il renderer (niente stack trace in GUI).
 */

const fs = require('node:fs');
const path = require('node:path');
const { AppError, toUserError } = require('./errors');
const { IPC_CHANNELS, validateIpcMessage, isTrustedSenderUrl } = require('./ipc-validation');
const { SUPPORTED_EXTENSIONS, suggestMp3Name, ensureMp3Extension } = require('./validation');
const { saveResultFile } = require('./save-result');

function registerIpcHandlers(deps) {
  const { ipcMain, dialog, shell, clipboard, getWindow, getOrigin, getApiConfig, fileRegistry, jobManager, logger, logsDir, getDiagnostics, defaultSaveDir } = deps;

  const handlers = {
    'app:get-api-config': async () => ({ ok: true, ...getApiConfig() }),

    'file:select-video': async () => {
      const result = await dialog.showOpenDialog(getWindow(), {
        title: 'Scegli un video',
        properties: ['openFile'],
        filters: [
          { name: 'Video', extensions: SUPPORTED_EXTENSIONS.map((e) => e.slice(1)) },
          { name: 'Tutti i file', extensions: ['*'] }
        ]
      });
      if (result.canceled || !result.filePaths.length) return { ok: true, file: null };
      return { ok: true, file: await fileRegistry.register(result.filePaths[0]) };
    },

    'file:register-dropped': async (filePath) => ({ ok: true, file: await fileRegistry.register(filePath) }),

    'job:save-result': async (jobId) => {
      const { outputPath, originalName } = jobManager.getResultForSave(jobId);
      const win = getWindow();
      const choice = await dialog.showSaveDialog(win, {
        title: 'Salva MP3',
        defaultPath: path.join(defaultSaveDir(), suggestMp3Name(originalName)),
        filters: [{ name: 'Audio MP3', extensions: ['mp3'] }],
        properties: ['showOverwriteConfirmation', 'createDirectory']
      });
      if (choice.canceled || !choice.filePath) return { ok: true, saved: false };

      // Se abbiamo aggiunto noi l'estensione, il dialog non ha potuto chiedere
      // conferma per quel nome: lo facciamo ora.
      const finalPath = ensureMp3Extension(choice.filePath);
      if (finalPath !== choice.filePath && fs.existsSync(finalPath)) {
        const confirm = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Sostituisci', 'Annulla'],
          defaultId: 1,
          cancelId: 1,
          message: `"${path.basename(finalPath)}" esiste già. Vuoi sostituirlo?`
        });
        if (confirm.response !== 0) return { ok: true, saved: false };
      }

      const saved = await saveResultFile(outputPath, finalPath);
      await jobManager.markSaved(jobId);
      logger.info('Risultato salvato e temporanei rimossi');
      return { ok: true, saved: true, fileName: path.basename(saved.path), size: saved.size };
    },

    'app:open-logs-folder': async () => {
      const error = await shell.openPath(logsDir);
      return error ? { ok: false, error: toUserError('DESTINATION_UNAVAILABLE') } : { ok: true };
    },

    'app:copy-diagnostics': async () => {
      clipboard.writeText(await getDiagnostics());
      return { ok: true };
    },

    'app:open-external': async (url) => {
      await shell.openExternal(url);
      return { ok: true };
    }
  };

  for (const channel of Object.keys(IPC_CHANNELS)) {
    ipcMain.handle(channel, async (event, ...args) => {
      const senderUrl = event.senderFrame ? event.senderFrame.url : '';
      if (!isTrustedSenderUrl(senderUrl, getOrigin()) || (event.senderFrame && event.senderFrame.parent)) {
        logger.warn(`IPC rifiutato da mittente non fidato sul canale ${channel}`);
        return { ok: false, error: toUserError('FORBIDDEN') };
      }
      const validation = validateIpcMessage(channel, args);
      if (!validation.ok) {
        logger.warn(`IPC con argomenti non validi sul canale ${channel}`);
        return { ok: false, error: toUserError('INVALID_ARGUMENTS') };
      }
      try {
        return await handlers[channel](validation.value);
      } catch (err) {
        if (err instanceof AppError) {
          logger.info(`IPC ${channel}: ${err.code} (${err.message})`);
          return { ok: false, error: toUserError(err.code) };
        }
        logger.error(`IPC ${channel}: errore inatteso`, err);
        return { ok: false, error: toUserError('INTERNAL_ERROR') };
      }
    });
  }

  return () => {
    for (const channel of Object.keys(IPC_CHANNELS)) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerIpcHandlers };
