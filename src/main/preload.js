'use strict';

/**
 * Preload script: l'unico "ponte" fra la GUI (renderer) e il main process.
 *
 * Gira in sandbox con contextIsolation: la pagina NON vede `require`,
 * `process` o `ipcRenderer`. Vede solo l'oggetto `window.desktopApi`
 * definito qui, con funzioni dalla forma fissa. Non esponiamo mai
 * ipcRenderer direttamente: altrimenti la pagina potrebbe invocare
 * qualsiasi canale con qualsiasi argomento.
 *
 * NB: un preload in sandbox non può importare file locali, per questo
 * i nomi dei canali sono scritti qui (test: tests/unit/ipc-validation.test.js).
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const desktopApi = {
  /** URL base e token per l'API locale. Da tenere solo in memoria. */
  getApiConfig: () => ipcRenderer.invoke('app:get-api-config'),

  /** Apre il dialog nativo di selezione. Restituisce {fileId, name, size} o null. */
  selectVideo: () => ipcRenderer.invoke('file:select-video'),

  /**
   * Registra un file trascinato nella finestra. Il percorso viene ricavato
   * qui, nel preload, dall'oggetto File: la pagina non lo vede mai.
   */
  registerDroppedFile: (file) => {
    let filePath = '';
    try {
      filePath = webUtils.getPathForFile(file);
    } catch {
      filePath = '';
    }
    if (typeof filePath !== 'string' || filePath === '') {
      return Promise.resolve({ ok: false, error: { code: 'UNSUPPORTED_FILE' } });
    }
    return ipcRenderer.invoke('file:register-dropped', filePath);
  },

  /** Dialog nativo "Salva con nome" e copia del risultato. */
  saveResult: (jobId) => ipcRenderer.invoke('job:save-result', String(jobId)),

  openLogsFolder: () => ipcRenderer.invoke('app:open-logs-folder'),
  copyDiagnostics: () => ipcRenderer.invoke('app:copy-diagnostics'),
  openExternal: (linkKey) => ipcRenderer.invoke('app:open-external', String(linkKey))
};

contextBridge.exposeInMainWorld('desktopApi', Object.freeze(desktopApi));
