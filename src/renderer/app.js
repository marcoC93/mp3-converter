'use strict';

/*
 * Logica della GUI (renderer process).
 *
 * Il renderer NON ha accesso a Node.js, al filesystem o ai processi.
 * Può soltanto:
 *  - chiamare le funzioni esposte dal preload in window.desktopApi (IPC);
 *  - chiamare l'API Express locale (stessa origine) con il token in memoria.
 *
 * Il token NON viene mai salvato in localStorage/sessionStorage: vive solo
 * nella variabile `apiConfig` e scompare alla chiusura della finestra.
 *
 * Tutto il testo dinamico viene inserito con textContent (mai innerHTML):
 * un nome di file come "<img onerror=...>.mp4" resta testo innocuo.
 */

(() => {
  const api = window.desktopApi;
  const POLL_INTERVAL_MS = 400;
  const MAX_POLL_FAILURES = 5;
  const BUSY_PHASES = new Set(['queued', 'analyzing', 'converting', 'finalizing', 'cancelling']);
  const STATUS_LABELS = {
    queued: 'Preparazione…',
    analyzing: 'Analisi del file…',
    converting: 'Conversione in corso',
    finalizing: 'Finalizzazione…',
    cancelling: 'Annullamento in corso…'
  };

  let apiConfig = null; // { baseUrl, token } solo in memoria

  const state = {
    phase: 'idle', // idle | checking | ready | invalid | queued | analyzing | converting | finalizing | cancelling | completed | saved | cancelled | error
    file: null, // { fileId, name, size }
    bitrate: 192,
    job: null,
    error: null,
    invalidMessage: '',
    resourcesReady: false,
    extensions: [],
    pollTimer: null,
    pollFailures: 0,
    lastAnnouncedQuarter: -1
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    dropzone: $('dropzone'),
    dropzoneText: $('dropzone-text'),
    formatsText: $('formats-text'),
    btnPick: $('btn-pick'),
    fileInfo: $('file-info'),
    fileName: $('file-name'),
    fileSize: $('file-size'),
    btnRemove: $('btn-remove'),
    qualityOptions: $('quality-options'),
    btnConvert: $('btn-convert'),
    actionStart: $('action-start'),
    progressArea: $('progress-area'),
    statusLabel: $('status-label'),
    progressPercent: $('progress-percent'),
    progressBar: $('progress-bar'),
    progressDetail: $('progress-detail'),
    btnCancel: $('btn-cancel'),
    resultArea: $('result-area'),
    resultTitle: $('result-title'),
    resultDetail: $('result-detail'),
    btnSave: $('btn-save'),
    errorArea: $('error-area'),
    errorTitle: $('error-title'),
    errorHint: $('error-hint'),
    banner: $('resource-banner'),
    bannerText: $('resource-banner-text'),
    liveRegion: $('live-region'),
    toast: $('toast'),
    dialogAbout: $('dialog-about'),
    aboutBody: $('about-body'),
    dialogLicenses: $('dialog-licenses'),
    licenseTabs: $('license-tabs'),
    licenseText: $('license-text')
  };

  // ------------------------------------------------------------------
  // Utilità
  // ------------------------------------------------------------------

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    const units = ['byte', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toLocaleString('it-IT', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function extensionOf(name) {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '';
  }

  function announce(text) {
    el.liveRegion.textContent = '';
    // Piccolo ritardo: alcuni screen reader ignorano un testo identico appena reimpostato.
    setTimeout(() => { el.liveRegion.textContent = text; }, 50);
  }

  let toastTimer = null;
  function showToast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4000);
  }

  function fallbackError() {
    return { code: 'INTERNAL_ERROR', message: 'Si è verificato un errore inatteso.', hint: 'Riprova; se il problema persiste, consulta i log.' };
  }

  function normalizeError(err) {
    if (err && typeof err.message === 'string' && typeof err.code === 'string') {
      return { code: err.code, message: err.message, hint: typeof err.hint === 'string' ? err.hint : '' };
    }
    return fallbackError();
  }

  // ------------------------------------------------------------------
  // API locale
  // ------------------------------------------------------------------

  async function apiFetch(method, pathname, body) {
    let response;
    try {
      response = await fetch(pathname, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${apiConfig.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch {
      throw { code: 'INTERNAL_ERROR', message: 'Il servizio interno non risponde.', hint: "Riavvia l'applicazione." };
    }
    if (response.status === 204) return {};
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) throw normalizeError(data && data.error);
    return data;
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function setPhase(phase) {
    state.phase = phase;
    render();
  }

  function render() {
    const { phase, file, job } = state;
    const busy = BUSY_PHASES.has(phase);
    const finished = phase === 'completed' || phase === 'saved';
    const failed = phase === 'error' || phase === 'cancelled';

    // Drop zone / file selezionato
    el.dropzone.hidden = Boolean(file);
    el.fileInfo.hidden = !file;
    if (!file) {
      el.dropzone.dataset.state = phase === 'invalid' ? 'invalid' : phase === 'checking' ? 'checking' : el.dropzone.dataset.state === 'dragover' ? 'dragover' : 'idle';
      el.dropzoneText.textContent = phase === 'invalid'
        ? state.invalidMessage
        : phase === 'checking' ? 'Verifica del file…' : 'Trascina qui un video';
    } else {
      el.fileName.textContent = file.name;
      el.fileSize.textContent = formatBytes(file.size);
    }
    el.btnPick.disabled = phase === 'checking';
    el.btnRemove.disabled = busy;

    // Qualità
    for (const input of el.qualityOptions.querySelectorAll('input')) {
      input.disabled = busy || finished;
      input.checked = Number(input.value) === state.bitrate;
    }

    // Azione principale
    el.actionStart.hidden = busy || finished || failed;
    el.btnConvert.disabled = !(file && phase === 'ready' && state.resourcesReady);

    // Avanzamento
    el.progressArea.hidden = !busy;
    if (busy && job) {
      el.statusLabel.textContent = STATUS_LABELS[phase] || 'In corso…';
      const indeterminate = phase === 'analyzing' || phase === 'queued' || (phase === 'converting' && job.durationSeconds === null);
      if (indeterminate) {
        el.progressBar.removeAttribute('value');
        el.progressPercent.textContent = '';
      } else {
        el.progressBar.value = job.progress;
        el.progressPercent.textContent = `${Math.floor(job.progress)}%`;
      }
      el.progressBar.setAttribute('aria-valuetext', indeterminate ? 'In corso' : `${Math.floor(job.progress)} per cento`);
      const parts = [];
      if (job.durationSeconds) parts.push(`${formatTime(job.processedSeconds)} di ${formatTime(job.durationSeconds)}`);
      if (job.audioCodec) parts.push(`audio ${job.audioCodec}`);
      parts.push(`${job.bitrate} kbps`);
      el.progressDetail.textContent = parts.join(' · ');
      el.btnCancel.disabled = phase === 'cancelling';
    }

    // Risultato
    el.resultArea.hidden = !finished;
    if (finished && job) {
      el.resultTitle.textContent = phase === 'saved' ? 'MP3 salvato' : 'Conversione completata';
      el.resultDetail.textContent = phase === 'saved'
        ? `Salvato come "${state.savedName}" (${formatBytes(state.savedSize)}). I file temporanei sono stati eliminati.`
        : `MP3 a ${job.bitrate} kbps pronto (${formatBytes(job.outputSize)}). Scegli dove salvarlo.`;
      el.btnSave.hidden = phase === 'saved';
    }

    // Errore / annullamento
    el.errorArea.hidden = !failed;
    if (failed) {
      const err = state.error || fallbackError();
      el.errorTitle.textContent = err.message;
      el.errorHint.textContent = err.hint || '';
      el.errorArea.classList.toggle('is-cancelled', phase === 'cancelled');
    }
  }

  // ------------------------------------------------------------------
  // Selezione file
  // ------------------------------------------------------------------

  function acceptFileResult(result) {
    if (result && result.ok && result.file) {
      state.file = result.file;
      state.error = null;
      setPhase('ready');
      announce(`File selezionato: ${result.file.name}`);
    } else if (result && result.ok && !result.file) {
      setPhase(state.file ? 'ready' : 'idle'); // dialog annullato
    } else {
      const err = normalizeError(result && result.error);
      state.file = null;
      state.invalidMessage = `${err.message} ${err.hint || ''}`.trim();
      setPhase('invalid');
      announce(state.invalidMessage);
    }
  }

  async function pickFile() {
    if (BUSY_PHASES.has(state.phase)) return;
    const previous = state.phase;
    setPhase('checking');
    try {
      acceptFileResult(await api.selectVideo());
    } catch {
      setPhase(previous === 'checking' ? 'idle' : previous);
    }
  }

  async function handleDrop(event) {
    event.preventDefault();
    el.dropzone.dataset.state = 'idle';
    dragDepth = 0;
    if (BUSY_PHASES.has(state.phase) || state.file) return;
    const files = event.dataTransfer ? [...event.dataTransfer.files] : [];
    if (files.length !== 1) {
      state.invalidMessage = files.length > 1 ? 'Trascina un solo video alla volta.' : 'Elemento non valido: trascina un file video.';
      setPhase('invalid');
      return;
    }
    // Controllo preliminare solo per un feedback immediato: la verifica vera
    // la fanno il main process (estensione, esistenza) e il convertitore (contenuto).
    if (state.extensions.length && !state.extensions.includes(extensionOf(files[0].name))) {
      state.invalidMessage = `"${files[0].name}" non è un formato supportato.`;
      setPhase('invalid');
      announce(state.invalidMessage);
      return;
    }
    setPhase('checking');
    try {
      acceptFileResult(await api.registerDroppedFile(files[0]));
    } catch {
      acceptFileResult({ ok: false });
    }
  }

  let dragDepth = 0;
  function onDragEnter(event) {
    event.preventDefault();
    if (BUSY_PHASES.has(state.phase) || state.file) return;
    dragDepth += 1;
    el.dropzone.dataset.state = 'dragover';
    el.dropzoneText.textContent = 'Rilascia il file per selezionarlo';
  }
  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && el.dropzone.dataset.state === 'dragover') {
      el.dropzone.dataset.state = 'idle';
      render();
    }
  }

  function removeFile() {
    if (BUSY_PHASES.has(state.phase)) return;
    state.file = null;
    state.job = null;
    state.error = null;
    setPhase('idle');
  }

  // ------------------------------------------------------------------
  // Conversione
  // ------------------------------------------------------------------

  async function startConversion() {
    if (!state.file || state.phase !== 'ready') return;
    state.lastAnnouncedQuarter = -1;
    try {
      const { job } = await apiFetch('POST', '/api/jobs', { fileId: state.file.fileId, bitrate: state.bitrate });
      state.job = job;
      setPhase(job.state);
      announce('Conversione avviata');
      startPolling();
    } catch (err) {
      state.error = normalizeError(err);
      setPhase('error');
      announce(state.error.message);
    }
  }

  function startPolling() {
    stopPolling();
    state.pollFailures = 0;
    state.pollTimer = setInterval(pollJob, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  async function pollJob() {
    if (!state.job) return stopPolling();
    try {
      const { job } = await apiFetch('GET', `/api/jobs/${encodeURIComponent(state.job.id)}`);
      state.pollFailures = 0;
      state.job = job;
      applyJobState(job);
    } catch (err) {
      state.pollFailures += 1;
      if (err && err.code === 'JOB_NOT_FOUND') state.pollFailures = MAX_POLL_FAILURES;
      if (state.pollFailures >= MAX_POLL_FAILURES) {
        stopPolling();
        state.error = normalizeError(err);
        setPhase('error');
      }
    }
  }

  function applyJobState(job) {
    if (job.state === 'completed') {
      stopPolling();
      setPhase('completed');
      announce('Conversione completata. Premi Salva MP3 per scegliere dove salvarlo.');
      return;
    }
    if (job.state === 'failed') {
      stopPolling();
      state.error = normalizeError(job.error);
      setPhase('error');
      announce(`Errore: ${state.error.message}`);
      return;
    }
    if (job.state === 'cancelled') {
      stopPolling();
      state.error = normalizeError(job.error);
      setPhase('cancelled');
      announce('Conversione annullata');
      return;
    }
    const quarter = Math.floor(job.progress / 25);
    if (job.state === 'converting' && quarter > state.lastAnnouncedQuarter && job.durationSeconds) {
      state.lastAnnouncedQuarter = quarter;
      if (quarter > 0 && quarter < 4) announce(`${quarter * 25} per cento completato`);
    }
    setPhase(job.state);
  }

  async function cancelConversion() {
    if (!state.job || !BUSY_PHASES.has(state.phase)) return;
    setPhase('cancelling');
    try {
      await apiFetch('POST', `/api/jobs/${encodeURIComponent(state.job.id)}/cancel`);
    } catch (err) {
      showToast(normalizeError(err).message);
    }
  }

  async function saveResult() {
    if (!state.job || state.phase !== 'completed') return;
    el.btnSave.disabled = true;
    try {
      const result = await api.saveResult(state.job.id);
      if (result && result.ok && result.saved) {
        state.savedName = result.fileName;
        state.savedSize = result.size;
        setPhase('saved');
        showToast('MP3 salvato correttamente');
        announce(`MP3 salvato come ${result.fileName}`);
      } else if (result && !result.ok) {
        const err = normalizeError(result.error);
        showToast(`${err.message} ${err.hint || ''}`.trim());
      }
    } finally {
      el.btnSave.disabled = false;
    }
  }

  async function newConversion() {
    stopPolling();
    const job = state.job;
    state.job = null;
    state.error = null;
    if (job && !BUSY_PHASES.has(job.state)) {
      // Se l'MP3 non è stato salvato, il server elimina i file temporanei.
      apiFetch('DELETE', `/api/jobs/${encodeURIComponent(job.id)}`).catch(() => {});
    }
    if (state.phase === 'cancelled' || state.phase === 'error') {
      // Stesso file, nuova prova possibile (es. dopo un annullamento).
      setPhase(state.file ? 'ready' : 'idle');
      return;
    }
    state.file = null;
    setPhase('idle');
  }

  // ------------------------------------------------------------------
  // Qualità
  // ------------------------------------------------------------------

  function buildQualityOptions(qualities, defaultBitrate) {
    el.qualityOptions.querySelectorAll('.quality-option').forEach((n) => n.remove());
    state.bitrate = defaultBitrate;
    for (const q of qualities) {
      const label = document.createElement('label');
      label.className = 'quality-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'bitrate';
      input.value = String(q.bitrate);
      input.addEventListener('change', () => {
        state.bitrate = q.bitrate;
      });
      const card = document.createElement('span');
      card.className = 'quality-card';
      const strong = document.createElement('strong');
      strong.textContent = `${q.bitrate} kbps`;
      const name = document.createElement('span');
      name.className = 'q-label';
      name.textContent = q.label;
      const desc = document.createElement('span');
      desc.className = 'q-desc';
      desc.textContent = q.description;
      card.append(strong, name, desc);
      label.append(input, card);
      el.qualityOptions.append(label);
    }
    $('panel-quality').hidden = qualities.length === 0;
  }

  // ------------------------------------------------------------------
  // Informazioni e licenze
  // ------------------------------------------------------------------

  function addRow(dl, term, value) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }

  function linkButton(text, key) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-link';
    b.textContent = text;
    b.addEventListener('click', () => api.openExternal(key));
    return b;
  }

  async function openAbout() {
    el.dialogAbout.showModal();
    el.aboutBody.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Caricamento…' }));
    try {
      const about = await apiFetch('GET', '/api/about');
      const intro = document.createElement('p');
      intro.textContent = 'Converte la traccia audio dei video in MP3, interamente sul tuo computer, senza connessione a Internet.';
      const dl = document.createElement('dl');
      dl.className = 'about-list';
      addRow(dl, 'Versione', `${about.version} (${about.buildType})`);
      addRow(dl, 'Piattaforma', about.platform);
      addRow(dl, 'Electron', about.versions.electron);
      addRow(dl, 'Chromium', about.versions.chrome);
      addRow(dl, 'Node.js', about.versions.node);
      addRow(dl, 'Convertitore', `${about.versions.converter} (Python ${about.versions.python})`);
      if (about.engine) {
        addRow(dl, 'Motore multimediale', `PyAV ${about.engine.pyav}`);
        addRow(dl, 'Librerie FFmpeg', `libavcodec ${about.engine.libavcodec}, libavformat ${about.engine.libavformat}`);
        addRow(dl, 'Licenza (valutata)', about.engine.license);
        addRow(dl, 'Licenza dichiarata', about.engine.declaredLicense);
        if (about.engine.gplLibraries.length) addRow(dl, 'Librerie GPL incluse', about.engine.gplLibraries.join(', '));
      } else {
        addRow(dl, 'Motore multimediale', 'non disponibile');
      }

      const credits = document.createElement('p');
      credits.append(
        'Questo software usa ',
        linkButton('PyAV', 'pyav'),
        ', che include le librerie del progetto ',
        linkButton('FFmpeg', 'ffmpeg'),
        ' e l’encoder ',
        linkButton('LAME', 'lame'),
        '. FFmpeg è un marchio di Fabrice Bellard. Informazioni legali: ',
        linkButton('ffmpeg.org/legal', 'ffmpegLegal'),
        '.'
      );
      const gpl = document.createElement('p');
      gpl.textContent = 'Il motore di conversione è distribuito sotto GPL-3.0-or-later. Testi integrali delle licenze e sorgente corrispondente sono inclusi nell’applicazione: vedi “Licenze” → “Convertitore” e “Sorgente corrispondente”.';
      const legal = document.createElement('p');
      legal.className = 'legal-note';
      legal.textContent = 'Converti esclusivamente contenuti di tua proprietà o per i quali possiedi i diritti e le autorizzazioni necessarie. Nessuna telemetria: l’app non invia dati.';
      el.aboutBody.replaceChildren(intro, dl, credits, gpl, legal);
    } catch (err) {
      el.aboutBody.replaceChildren(Object.assign(document.createElement('p'), { textContent: normalizeError(err).message }));
    }
  }

  async function openLicenses() {
    el.dialogLicenses.showModal();
    try {
      const { licenses } = await apiFetch('GET', '/api/licenses');
      el.licenseTabs.replaceChildren();
      licenses.forEach((lic, index) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'btn btn-secondary';
        tab.setAttribute('role', 'tab');
        tab.textContent = lic.title;
        tab.addEventListener('click', () => loadLicense(lic.id, tab));
        el.licenseTabs.append(tab);
        if (index === 0) loadLicense(lic.id, tab);
      });
    } catch (err) {
      el.licenseText.textContent = normalizeError(err).message;
    }
  }

  async function loadLicense(id, tab) {
    for (const t of el.licenseTabs.children) t.setAttribute('aria-selected', String(t === tab));
    el.licenseText.textContent = 'Caricamento…';
    try {
      const data = await apiFetch('GET', `/api/licenses/${encodeURIComponent(id)}`);
      el.licenseText.textContent = data.text;
    } catch (err) {
      el.licenseText.textContent = normalizeError(err).message;
    }
  }

  // ------------------------------------------------------------------
  // Azioni comuni
  // ------------------------------------------------------------------

  async function openLogs() {
    const result = await api.openLogsFolder();
    if (result && !result.ok) showToast(normalizeError(result.error).message);
  }

  async function copyDiagnostics() {
    const result = await api.copyDiagnostics();
    showToast(result && result.ok ? 'Informazioni diagnostiche copiate negli appunti' : 'Copia non riuscita');
  }

  function bindEvents() {
    // Impedisce che un file rilasciato fuori dalla drop zone venga "aperto" dalla finestra.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    el.dropzone.addEventListener('dragenter', onDragEnter);
    el.dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = BUSY_PHASES.has(state.phase) ? 'none' : 'copy';
    });
    el.dropzone.addEventListener('dragleave', onDragLeave);
    el.dropzone.addEventListener('drop', handleDrop);

    el.btnPick.addEventListener('click', pickFile);
    el.btnRemove.addEventListener('click', removeFile);
    el.btnConvert.addEventListener('click', startConversion);
    el.btnCancel.addEventListener('click', cancelConversion);
    el.btnSave.addEventListener('click', saveResult);
    $('btn-about').addEventListener('click', openAbout);
    $('btn-licenses').addEventListener('click', openLicenses);

    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action], [data-close]');
      if (!target) return;
      if (target.hasAttribute('data-close')) target.closest('dialog').close();
      else if (target.dataset.action === 'new') newConversion();
      else if (target.dataset.action === 'open-logs') openLogs();
      else if (target.dataset.action === 'copy-diagnostics') copyDiagnostics();
    });
  }

  // ------------------------------------------------------------------
  // Avvio
  // ------------------------------------------------------------------

  async function init() {
    bindEvents();
    if (!api) {
      // Pagina aperta fuori da Electron (es. anteprima del file HTML nel browser):
      // senza preload non ci sono né selezione file né drag-and-drop né conversione.
      el.bannerText.textContent = ' Questa è solo un\'anteprima della pagina. Drag-and-drop e conversione funzionano nell\'applicazione: avviala con "npm run dev".';
      el.banner.querySelector('strong').textContent = 'Anteprima.';
      el.banner.querySelector('[data-action]').hidden = true;
      el.banner.hidden = false;
      el.btnPick.disabled = true;
      return;
    }
    const cfg = await api.getApiConfig();
    if (!cfg || !cfg.ok) {
      state.error = normalizeError(cfg && cfg.error);
      setPhase('error');
      return;
    }
    apiConfig = { baseUrl: cfg.baseUrl, token: cfg.token };
    try {
      const config = await apiFetch('GET', '/api/config');
      state.extensions = config.extensions;
      el.formatsText.textContent = config.extensions.map((e) => e.slice(1).toUpperCase()).join(', ');
      buildQualityOptions(config.qualities, config.defaultBitrate);
      state.resourcesReady = config.resources.ready;
      if (!config.resources.ready) {
        const first = config.resources.problems[0];
        el.bannerText.textContent = ` La conversione non è disponibile. ${first ? `${first.message} ${first.hint}` : ''}`;
        el.banner.hidden = false;
      }
      render();
      document.body.dataset.ready = 'true';
    } catch (err) {
      state.error = normalizeError(err);
      setPhase('error');
    }
  }

  init();
})();
