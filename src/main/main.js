'use strict';

/**
 * Main process di Electron: il "direttore d'orchestra".
 *
 * All'avvio:
 *  1. impedisce una seconda istanza (single-instance lock);
 *  2. prepara logger, cartella temporanea e risorse native;
 *  3. avvia il server Express su 127.0.0.1 con porta effimera e token;
 *  4. applica le restrizioni di sicurezza alla sessione;
 *  5. registra i gestori IPC e apre la finestra.
 * Alla chiusura: annulla le conversioni, termina i processi figli, chiude
 * il server ed elimina i file temporanei (graceful shutdown).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, session, shell } = require('electron');

const { Logger } = require('./logger');
const {
  createRuntimeContext,
  checkResources,
  applyEngineCheck,
  resolveLicensesDir,
  resolveThirdPartyDir,
  resolveRendererDir
} = require('./resource-resolver');
const { classifyLicense } = require('./license-classifier');
const { FileRegistry } = require('./file-registry');
const { JobManager, cleanupStaleSessions } = require('./job-manager');
const { createLocalServer } = require('./express-server');
const { registerIpcHandlers } = require('./ipc-handlers');
const { parseEventLine } = require('./process-manager');

const APP_TEMP_PREFIX = 'video-to-mp3-desktop';
const isSmokeTest = process.argv.includes('--smoke-test');
const debugEnabled = process.argv.includes('--debug-logging') || process.env.VIDEO2MP3_DEBUG === '1';

const runtime = {
  ctx: null,
  logger: null,
  resources: { ready: false, problems: [] },
  fileRegistry: null,
  jobManager: null,
  server: null,
  token: null,
  mainWindow: null,
  unregisterIpc: null,
  shutdownState: 'running', // running | stopping | done
  allowWindowClose: false,
  converterVersion: null
};

// --------------------------------------------------------------------------
// Avvio
// --------------------------------------------------------------------------

if (isSmokeTest) {
  // Lo smoke test usa un profilo temporaneo proprio: il single-instance lock è
  // legato alla cartella userData, quindi può girare anche con l'app già aperta.
  app.setPath('userData', path.join(os.tmpdir(), `video-to-mp3-smoke-${process.pid}`));
}

if (!app.requestSingleInstanceLock()) {
  // Un'altra istanza è già aperta: le passiamo il controllo e usciamo subito,
  // senza avviare un secondo server o un secondo set di processi.
  // In smoke test questo sarebbe un falso "successo": si esce con errore.
  if (isSmokeTest) {
    process.stderr.write('SMOKE TEST: single-instance lock non ottenuto\n');
    app.exit(3);
  } else {
    app.quit();
  }
} else {
  app.on('second-instance', () => {
    const win = runtime.mainWindow;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start).catch((err) => fatal('Avvio non riuscito', err));
}

async function start() {
  const logger = new Logger({ dir: app.getPath('logs'), debug: debugEnabled, console: !app.isPackaged || debugEnabled });
  runtime.logger = logger;
  logger.info(`Avvio ${app.getName()} ${app.getVersion()} (${process.platform}-${process.arch}, Electron ${process.versions.electron})`);

  try {
    runtime.ctx = createRuntimeContext({
      isPackaged: app.isPackaged,
      appRoot: app.getAppPath(),
      resourcesPath: process.resourcesPath
    });
  } catch (err) {
    if (err.code === 'UNSUPPORTED_PLATFORM') {
      return fatal('Questo sistema operativo o processore non è supportato.', err);
    }
    throw err;
  }
  logger.info(`Modalità: ${runtime.ctx.mode}`);

  // 1) controllo statico (il convertitore esiste ed è del tipo giusto);
  // 2) controllo reale: `converter --version` deve rispondere e riportare
  //    PyAV disponibile con l'encoder libmp3lame.
  runtime.resources = checkResources(runtime.ctx);
  if (runtime.resources.ready) {
    runtime.resources = applyEngineCheck(runtime.resources, await getConverterVersion());
  }
  for (const problem of runtime.resources.problems) {
    logger.warn(`Risorsa non disponibile [${problem.component}] ${problem.code}: ${problem.detail}`);
  }

  // Cartella temporanea: <tmp>/video-to-mp3-desktop-<utente>/session-<casuale>/
  const tempBase = path.join(os.tmpdir(), `${APP_TEMP_PREFIX}-${safeUserTag()}`);
  const sessionDir = path.join(tempBase, `session-${crypto.randomBytes(8).toString('hex')}`);
  const removed = await cleanupStaleSessions(tempBase, sessionDir, logger);
  if (removed) logger.info(`Rimosse ${removed} cartelle temporanee di sessioni precedenti`);

  runtime.fileRegistry = new FileRegistry({ logger });
  runtime.jobManager = new JobManager({
    tempRoot: sessionDir,
    fileRegistry: runtime.fileRegistry,
    getResources: () => runtime.resources,
    logger,
    showConsole: process.env.VIDEO2MP3_SHOW_CONVERTER_CONSOLE === '1'
  });
  await runtime.jobManager.init();

  // Token casuale a 256 bit, rigenerato a ogni avvio.
  runtime.token = crypto.randomBytes(32).toString('base64url');
  runtime.server = createLocalServer({
    jobManager: runtime.jobManager,
    rendererDir: resolveRendererDir(runtime.ctx),
    licensesDir: resolveLicensesDir(runtime.ctx),
    thirdPartyDir: resolveThirdPartyDir(runtime.ctx),
    token: runtime.token,
    getResourceStatus: () => runtime.resources,
    getAbout,
    logger
  });
  await startServer();

  hardenSession(session.defaultSession);
  configureMenu();

  runtime.unregisterIpc = registerIpcHandlers({
    ipcMain,
    dialog,
    shell,
    clipboard,
    getWindow: () => runtime.mainWindow,
    getOrigin: () => runtime.server.origin,
    getApiConfig: () => ({ baseUrl: runtime.server.origin, token: runtime.token }),
    fileRegistry: runtime.fileRegistry,
    jobManager: runtime.jobManager,
    logger,
    logsDir: app.getPath('logs'),
    getDiagnostics,
    defaultSaveDir: () => safeGetPath('music') || safeGetPath('downloads') || os.homedir()
  });

  createMainWindow();
  return undefined;
}

async function startServer() {
  // In sviluppo si può fissare la porta; in produzione sempre porta effimera.
  const requested = !app.isPackaged && process.env.VIDEO2MP3_PORT ? Number(process.env.VIDEO2MP3_PORT) : 0;
  const port = Number.isInteger(requested) && requested >= 1024 && requested <= 65535 ? requested : 0;
  try {
    await runtime.server.start({ port });
  } catch (err) {
    if (err.code === 'EADDRINUSE' && port !== 0) {
      runtime.logger.warn(`Porta ${port} occupata: uso una porta effimera`);
      await runtime.server.start({ port: 0 });
      return;
    }
    throw Object.assign(err, { userMessage: 'Impossibile avviare il servizio locale interno.' });
  }
}

// --------------------------------------------------------------------------
// Finestra e sicurezza
// --------------------------------------------------------------------------

function createMainWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 560,
    minHeight: 600,
    show: false,
    title: 'Video to MP3',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // il codice della pagina non condivide oggetti con il preload
      nodeIntegration: false,   // nessun require/process nella pagina
      sandbox: true,            // renderer nella sandbox di Chromium
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged || debugEnabled
    }
  });
  runtime.mainWindow = win;

  win.once('ready-to-show', () => {
    if (!isSmokeTest) win.show();
    else if (process.env.VIDEO2MP3_SMOKE_SCREENSHOT) win.showInactive();
  });

  win.on('close', (event) => {
    if (runtime.allowWindowClose || !runtime.jobManager?.hasActiveJob()) return;
    event.preventDefault();
    confirmCancelActiveJob().then((confirmed) => {
      if (confirmed) {
        runtime.allowWindowClose = true;
        win.close();
      }
    });
  });

  win.on('closed', () => {
    runtime.mainWindow = null;
  });

  if (isSmokeTest) setupSmokeTest(win);
  win.loadURL(`${runtime.server.origin}/`);
}

async function confirmCancelActiveJob() {
  const options = {
    type: 'warning',
    buttons: ['Annulla la conversione ed esci', 'Continua la conversione'],
    defaultId: 1,
    cancelId: 1,
    title: 'Conversione in corso',
    message: 'È in corso una conversione.',
    detail: 'Se esci ora la conversione verrà annullata e i file temporanei eliminati.'
  };
  const { response } = runtime.mainWindow
    ? await dialog.showMessageBox(runtime.mainWindow, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

function isOwnUrl(url) {
  try {
    return new URL(url).origin === runtime.server?.origin;
  } catch {
    return false;
  }
}

function hardenSession(ses) {
  // Nessun permesso web (camera, microfono, notifiche, geolocalizzazione...).
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);

  // Nessuna richiesta di rete verso l'esterno: solo la nostra origine locale
  // (più gli strumenti di sviluppo, se abilitati).
  ses.webRequest.onBeforeRequest((details, callback) => {
    const { url } = details;
    const allowed = isOwnUrl(url) || url.startsWith('devtools://') || url.startsWith('data:');
    if (!allowed) runtime.logger?.warn(`Richiesta bloccata verso: ${safeUrlForLog(url)}`);
    callback({ cancel: !allowed });
  });
}

app.on('web-contents-created', (event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e, url) => {
    if (!isOwnUrl(url)) e.preventDefault();
  });
  contents.on('will-redirect', (e, url) => {
    if (!isOwnUrl(url)) e.preventDefault();
  });
});

function configureMenu() {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  } else if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }
}

// --------------------------------------------------------------------------
// Informazioni e diagnostica
// --------------------------------------------------------------------------

/** Informazioni sulle librerie FFmpeg incluse nel convertitore (via PyAV). */
function describeEngine(versionEvent) {
  const engine = versionEvent && versionEvent.engine;
  if (!engine || !engine.available) return null;
  const license = classifyLicense(engine.configuration, engine.license);
  return {
    pyav: engine.pyav,
    libavcodec: engine.ffmpegLibraries.libavcodec || 'sconosciuta',
    libavformat: engine.ffmpegLibraries.libavformat || 'sconosciuta',
    declaredLicense: engine.license || 'non indicata',
    license: license.classification,
    gplLibraries: license.gplLibraries,
    libmp3lame: engine.libmp3lame
  };
}

function getConverterVersion() {
  if (runtime.converterVersion) return Promise.resolve(runtime.converterVersion);
  const converter = runtime.resources.converter;
  if (!converter) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(converter.command, [...converter.args, '--version'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) {
        runtime.logger.warn(`Versione del convertitore non disponibile: ${err.code || err.message}`);
        return resolve(null);
      }
      const line = String(stdout).trim().split(/\r?\n/).pop();
      const parsed = parseEventLine(line);
      runtime.converterVersion = parsed.ok && parsed.event.type === 'version' ? parsed.event : null;
      return resolve(runtime.converterVersion);
    });
  });
}

async function getAbout() {
  const converter = await getConverterVersion();
  return {
    name: 'Video to MP3',
    version: app.getVersion(),
    buildType: app.isPackaged ? 'pacchetto' : 'sviluppo (non firmata)',
    platform: `${process.platform}-${process.arch}`,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      converter: converter ? converter.converter : 'non disponibile',
      python: converter ? converter.python : 'non disponibile'
    },
    engine: describeEngine(converter),
    resources: { ready: runtime.resources.ready, problems: runtime.resources.problems.map((p) => p.code) }
  };
}

async function getDiagnostics() {
  const about = await getAbout();
  const lines = [
    `Video to MP3 ${about.version} (${about.buildType})`,
    `Sistema: ${process.platform} ${os.release()} ${process.arch}`,
    `Electron ${about.versions.electron} / Chrome ${about.versions.chrome} / Node ${about.versions.node}`,
    `Convertitore ${about.versions.converter} / Python ${about.versions.python}`,
    `Motore: ${about.engine ? `PyAV ${about.engine.pyav}, libavcodec ${about.engine.libavcodec}, licenza ${about.engine.license}, libmp3lame ${about.engine.libmp3lame ? 'sì' : 'no'}` : 'non disponibile'}`,
    `Risorse pronte: ${about.resources.ready ? 'sì' : 'no'} ${about.resources.problems.join(', ')}`,
    '',
    'Ultimi eventi del log (ripuliti):',
    ...runtime.logger.tail(30)
  ];
  return runtime.logger.sanitize(lines.join('\n'));
}

// --------------------------------------------------------------------------
// Chiusura ordinata
// --------------------------------------------------------------------------

app.on('window-all-closed', () => {
  // Anche su macOS chiudiamo l'app: senza finestra il server locale non serve.
  app.quit();
});

app.on('before-quit', (event) => {
  if (runtime.shutdownState === 'done') return;
  event.preventDefault();
  if (runtime.shutdownState === 'stopping') return;

  const proceed = async () => {
    if (!runtime.allowWindowClose && runtime.jobManager?.hasActiveJob() && !isSmokeTest) {
      const confirmed = await confirmCancelActiveJob();
      if (!confirmed) return;
      runtime.allowWindowClose = true;
    }
    runtime.shutdownState = 'stopping';
    await gracefulShutdown();
    runtime.shutdownState = 'done';
    app.quit();
  };
  proceed().catch((err) => {
    runtime.logger?.error('Errore durante la chiusura', err);
    runtime.shutdownState = 'done';
    app.quit();
  });
});

async function gracefulShutdown() {
  runtime.logger?.info('Chiusura in corso: annullamento job, arresto server, pulizia temporanei');
  try {
    if (runtime.jobManager) await runtime.jobManager.shutdown({ timeoutMs: 8000 });
  } catch (err) {
    runtime.logger?.error('Shutdown del job manager non riuscito', err);
  }
  try {
    if (runtime.server) await runtime.server.close();
  } catch (err) {
    runtime.logger?.error('Chiusura del server non riuscita', err);
  }
  if (runtime.unregisterIpc) runtime.unregisterIpc();
  runtime.logger?.info('Chiusura completata');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => app.quit());
}

process.on('uncaughtException', (err) => {
  runtime.logger?.error('Eccezione non gestita', err);
});
process.on('unhandledRejection', (reason) => {
  runtime.logger?.error('Promise rifiutata non gestita', reason);
});

function fatal(userMessage, err) {
  runtime.logger?.error(`${userMessage}`, err);
  const logsHint = safeGetPath('logs') ? `\n\nI dettagli tecnici sono nella cartella dei log:\n${safeGetPath('logs')}` : '';
  if (!isSmokeTest) dialog.showErrorBox('Video to MP3', `${err?.userMessage || userMessage}${logsHint}`);
  runtime.shutdownState = 'done';
  gracefulShutdown().finally(() => app.exit(1));
}

// --------------------------------------------------------------------------
// Smoke test (solo sviluppo/CI): avvia, carica la GUI, verifica, esce.
// --------------------------------------------------------------------------

function setupSmokeTest(win) {
  const timer = setTimeout(() => {
    runtime.logger.error('SMOKE TEST: timeout');
    finishSmoke(2);
  }, 30000);
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(
        `(() => ({
          bridge: typeof window.desktopApi === 'object',
          noRequire: typeof window.require === 'undefined' && typeof window.process === 'undefined',
          app: document.querySelector('#app') !== null
        }))()`
      );
      // Il bridge del drag-and-drop accetta un oggetto File e risponde senza eccezioni
      // (un File creato in memoria non ha percorso: deve essere rifiutato in modo pulito).
      result.dropBridge = await win.webContents.executeJavaScript(
        `window.desktopApi.registerDroppedFile(new File(['x'], 'prova.mp4')).then((r) => r && r.ok === false && r.error.code === 'UNSUPPORTED_FILE')`
      );
      await new Promise((r) => setTimeout(r, 1500)); // lascia che la GUI chiami l'API
      const ready = await win.webContents.executeJavaScript(`document.body.dataset.ready === 'true'`);
      const ok = result.bridge && result.noRequire && result.app && result.dropBridge && ready;
      runtime.logger.info(`SMOKE TEST ${ok ? 'OK' : 'FALLITO'}: ${JSON.stringify({ ...result, ready })}`);
      // Facoltativo: VIDEO2MP3_SMOKE_SCREENSHOT=<file.png> salva una cattura della GUI.
      const shot = process.env.VIDEO2MP3_SMOKE_SCREENSHOT;
      if (shot && path.isAbsolute(shot)) {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(shot, image.toPNG());
      }
      clearTimeout(timer);
      finishSmoke(ok ? 0 : 1);
    } catch (err) {
      runtime.logger.error('SMOKE TEST: errore', err);
      clearTimeout(timer);
      finishSmoke(1);
    }
  });
}

function finishSmoke(code) {
  runtime.shutdownState = 'stopping';
  gracefulShutdown().finally(() => {
    runtime.shutdownState = 'done';
    app.exit(code);
  });
}

// --------------------------------------------------------------------------
// Utilità
// --------------------------------------------------------------------------

function safeUserTag() {
  let name = 'user';
  try {
    name = os.userInfo().username || name;
  } catch {
    /* alcuni ambienti non espongono l'utente */
  }
  // Hash breve: niente nome utente in chiaro nel percorso, ma separazione fra utenti.
  return crypto.createHash('sha256').update(name).digest('hex').slice(0, 12);
}

function safeGetPath(name) {
  try {
    return app.getPath(name);
  } catch {
    return null;
  }
}

function safeUrlForLog(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'url non valido';
  }
}
