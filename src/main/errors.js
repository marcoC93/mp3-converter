'use strict';

/**
 * Catalogo degli errori.
 *
 * Ogni componente (Python, job manager, Express, IPC) usa CODICI stabili.
 * Solo qui i codici diventano testi per l'utente. Vantaggi:
 * - i testi sono coerenti e in un unico punto;
 * - la GUI non mostra mai stack trace o messaggi tecnici grezzi;
 * - i test possono verificare i codici senza dipendere dalle frasi.
 *
 * Ogni voce risponde a: cosa è successo (message), cosa può fare l'utente (hint).
 * Il riferimento ai log viene aggiunto dalla GUI.
 */

const CATALOG = Object.freeze({
  // Componenti interni
  MEDIA_ENGINE_MISSING: {
    status: 500,
    message: 'La libreria multimediale (PyAV/FFmpeg) non è disponibile.',
    hint: "Reinstalla l'applicazione. In sviluppo: pip install -r src/python/requirements.txt nel venv."
  },
  CONVERTER_NOT_FOUND: {
    status: 500,
    message: 'Il motore di conversione non è stato trovato.',
    hint: "L'installazione sembra incompleta: reinstalla l'applicazione."
  },
  BINARY_NOT_EXECUTABLE: {
    status: 500,
    message: 'Un componente interno non ha i permessi di esecuzione.',
    hint: "Reinstalla l'applicazione. Su Linux/macOS verifica che la cartella non sia montata con 'noexec'."
  },
  BINARY_WRONG_ARCH: {
    status: 500,
    message: 'Un componente interno è stato compilato per un sistema o processore diverso.',
    hint: 'Scarica la versione dell’applicazione adatta al tuo sistema (x64 o ARM64).'
  },
  UNSUPPORTED_PLATFORM: {
    status: 500,
    message: 'Questo sistema operativo o processore non è supportato.',
    hint: 'Consulta la documentazione per le piattaforme supportate.'
  },
  ENCODER_NOT_AVAILABLE: {
    status: 500,
    message: 'La libreria multimediale inclusa non supporta la codifica MP3.',
    hint: "È un problema del pacchetto: segnalalo allo sviluppatore allegando i log."
  },
  RESOURCES_NOT_READY: {
    status: 503,
    message: 'Alcuni componenti necessari alla conversione non sono disponibili.',
    hint: "Reinstalla l'applicazione o consulta i log tecnici."
  },

  // Input
  FILE_NOT_REGISTERED: {
    status: 404,
    message: 'Il file selezionato non è più disponibile.',
    hint: 'Seleziona di nuovo il video.'
  },
  INPUT_NOT_FOUND: {
    status: 400,
    message: 'Il file video non esiste più o non è leggibile.',
    hint: 'Verifica che il file non sia stato spostato o che il disco sia collegato.'
  },
  UNSUPPORTED_FILE: {
    status: 400,
    message: 'Il tipo di file non è supportato.',
    hint: 'Usa un video MP4, MOV, MKV, AVI, WEBM, MPEG, MPG, M4V, FLV o WMV.'
  },
  EMPTY_FILE: {
    status: 400,
    message: 'Il file selezionato è vuoto.',
    hint: 'Scegli un altro video.'
  },
  INVALID_MEDIA: {
    status: 422,
    message: 'Il file è danneggiato o non è un video leggibile.',
    hint: 'Prova ad aprirlo con un lettore video; se non funziona, usa un’altra copia del file.'
  },
  NO_AUDIO_STREAM: {
    status: 422,
    message: 'Il video non contiene una traccia audio.',
    hint: 'Non c’è audio da estrarre: scegli un altro file.'
  },
  INVALID_BITRATE: {
    status: 400,
    message: 'La qualità MP3 selezionata non è valida.',
    hint: 'Scegli 128, 192, 256 o 320 kbps.'
  },
  INVALID_ARGUMENTS: {
    status: 400,
    message: 'Richiesta non valida.',
    hint: 'Riprova; se il problema persiste, consulta i log.'
  },

  // Conversione
  ENCODE_FAILED: {
    status: 500,
    message: 'La conversione non è riuscita.',
    hint: 'Il file potrebbe usare un formato audio non supportato. Consulta i log per i dettagli.'
  },
  INSUFFICIENT_DISK_SPACE: {
    status: 507,
    message: 'Spazio su disco insufficiente.',
    hint: 'Libera spazio sul disco di sistema (cartella temporanea) e riprova.'
  },
  CONVERSION_CANCELLED: {
    status: 409,
    message: 'Conversione annullata.',
    hint: 'Puoi avviare una nuova conversione quando vuoi.'
  },
  PROCESS_CRASHED: {
    status: 500,
    message: 'Il motore di conversione si è interrotto in modo inatteso.',
    hint: 'Riprova. Se succede di nuovo, apri la cartella dei log e allega il file a una segnalazione.'
  },
  PROTOCOL_ERROR: {
    status: 500,
    message: 'Il motore di conversione ha risposto in modo non valido.',
    hint: 'Riprova; se succede di nuovo, consulta i log.'
  },
  INTERNAL_ERROR: {
    status: 500,
    message: 'Si è verificato un errore interno.',
    hint: 'Riprova; se succede di nuovo, consulta i log.'
  },

  // Job
  JOB_NOT_FOUND: {
    status: 404,
    message: 'La conversione richiesta non esiste più.',
    hint: 'Avvia una nuova conversione.'
  },
  JOB_ALREADY_RUNNING: {
    status: 409,
    message: 'È già in corso una conversione.',
    hint: 'Attendi il termine o annullala prima di iniziarne un’altra.'
  },
  JOB_NOT_COMPLETED: {
    status: 409,
    message: 'La conversione non è ancora completata.',
    hint: 'Attendi il termine della conversione.'
  },
  SHUTTING_DOWN: {
    status: 503,
    message: "L'applicazione si sta chiudendo.",
    hint: ''
  },

  // Salvataggio
  DESTINATION_NOT_WRITABLE: {
    status: 500,
    message: 'Non è possibile scrivere nella cartella scelta.',
    hint: 'Scegli un’altra cartella (ad esempio Documenti o Musica).'
  },
  DESTINATION_UNAVAILABLE: {
    status: 500,
    message: 'La destinazione scelta non è disponibile.',
    hint: 'Verifica che il disco o la cartella di rete siano collegati.'
  },
  SAVE_VERIFICATION_FAILED: {
    status: 500,
    message: 'Il file salvato non risulta integro.',
    hint: 'Riprova a salvare in un’altra posizione.'
  },

  // API locale
  UNAUTHORIZED: { status: 401, message: 'Richiesta non autorizzata.', hint: '' },
  FORBIDDEN: { status: 403, message: 'Richiesta non consentita.', hint: '' },
  NOT_FOUND: { status: 404, message: 'Risorsa non trovata.', hint: '' }
});

class AppError extends Error {
  /**
   * @param {string} code codice del catalogo
   * @param {string} [technicalDetail] dettaglio tecnico, SOLO per i log
   */
  constructor(code, technicalDetail) {
    const entry = CATALOG[code] || CATALOG.INTERNAL_ERROR;
    super(technicalDetail || entry.message);
    this.name = 'AppError';
    this.code = CATALOG[code] ? code : 'INTERNAL_ERROR';
    this.status = entry.status;
  }
}

/** Rappresentazione sicura per la GUI: mai stack trace o percorsi. */
function toUserError(code) {
  const known = Object.prototype.hasOwnProperty.call(CATALOG, code);
  const entry = known ? CATALOG[code] : CATALOG.INTERNAL_ERROR;
  return { code: known ? code : 'INTERNAL_ERROR', message: entry.message, hint: entry.hint };
}

function isKnownCode(code) {
  return Object.prototype.hasOwnProperty.call(CATALOG, code);
}

module.exports = { AppError, toUserError, isKnownCode, CATALOG };
