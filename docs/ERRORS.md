# Errori e risoluzione dei problemi

Tutti i messaggi per l'utente sono definiti in `src/main/errors.js`. Ogni errore mostra: **cosa è successo**,
**cosa fare**, e il rimando ai log (pulsanti "Apri cartella log" e "Copia diagnostica"). La GUI non mostra mai stack trace.

## Dove sono i log

| Sistema | Percorso |
|---------|----------|
| Windows | `%APPDATA%\Video to MP3\logs\app.log` |
| macOS | `~/Library/Logs/Video to MP3/app.log` |
| Linux | `~/.config/Video to MP3/logs/app.log` |

Livello debug: `npm run dev:debug`, oppure avviare l'app con `--debug-logging` o `VIDEO2MP3_DEBUG=1`.

## Codici

| Codice | Origine | Situazione | Cosa fare |
|--------|---------|------------|-----------|
| `MEDIA_ENGINE_MISSING` | avvio, Python | PyAV non importabile | sviluppo: `pip install -r src/python/requirements.txt` nel `.venv`; utente: reinstallare |
| `CONVERTER_NOT_FOUND` | avvio, spawn | eseguibile del convertitore mancante o che non risponde a `--version` | sviluppo: `npm run build:python` o verificare Python; utente: reinstallare |
| `BINARY_NOT_EXECUTABLE` | avvio, spawn, Python | permessi mancanti o disco `noexec` | `chmod +x`, reinstallare |
| `BINARY_WRONG_ARCH` | avvio | binario per altro sistema/architettura | usare il pacchetto giusto; in build: correggere la cartella |
| `UNSUPPORTED_PLATFORM` | avvio | sistema/architettura non previsti | vedi matrice in PACKAGING.md |
| `ENCODER_NOT_AVAILABLE` | avvio, Python | librerie FFmpeg di PyAV senza libmp3lame | usare una versione di PyAV con libmp3lame (verifica: `npm run verify:converter`) |
| `RESOURCES_NOT_READY` | API | conversione richiesta con risorse mancanti | vedi banner nella GUI |
| `UNSUPPORTED_FILE`, `EMPTY_FILE` | selezione file | estensione non ammessa, cartella, file vuoto | scegliere un video valido |
| `INPUT_NOT_FOUND` | selezione, Python | file spostato, disco scollegato | riselezionare il file |
| `INVALID_MEDIA` | Python | file danneggiato o non multimediale | provare un'altra copia |
| `NO_AUDIO_STREAM` | Python | video senza audio | nulla da estrarre |
| `INVALID_BITRATE`, `INVALID_ARGUMENTS` | API, IPC, Python | richiesta non valida | bug o manomissione: vedere log |
| `INSUFFICIENT_DISK_SPACE` | Python, salvataggio | spazio esaurito | liberare spazio |
| `ENCODE_FAILED` | Python | errore in scrittura o nessun audio prodotto | log in modalità debug per i dettagli |
| `PROCESS_CRASHED` | job manager | il convertitore è uscito senza evento di errore | riprovare; allegare i log |
| `PROTOCOL_ERROR` | job manager | evento finale mancante o percorso inatteso | bug: allegare i log |
| `CONVERSION_CANCELLED` | job manager | annullata dall'utente o alla chiusura | — |
| `JOB_NOT_FOUND`, `JOB_ALREADY_RUNNING`, `JOB_NOT_COMPLETED` | API | stato del job non coerente con la richiesta | nuova conversione |
| `DESTINATION_NOT_WRITABLE`, `DESTINATION_UNAVAILABLE`, `SAVE_VERIFICATION_FAILED` | salvataggio | cartella protetta, disco scollegato, copia incompleta | scegliere un'altra cartella |
| `UNAUTHORIZED`, `FORBIDDEN` | API | token o origine non validi | atteso solo per richieste esterne all'app |

## Errori di sviluppo e packaging

| Situazione | Messaggio | Soluzione |
|------------|-----------|-----------|
| Porta locale occupata | solo se si imposta `VIDEO2MP3_PORT`: si passa automaticamente a una porta effimera | — |
| Express non si avvia | dialog "Impossibile avviare il servizio locale interno" + log | controllare firewall/antivirus che bloccano il loopback |
| Messaggio JSON Lines malformato | avviso nel log, riga ignorata | se il job non termina: `PROTOCOL_ERROR` |
| Errore PyInstaller | `build-python.js` si ferma con il codice di uscita | leggere l'output; `npm run build:python:debug` |
| Errore di packaging | `prepare-resources.js` elenca le risorse mancanti; nessun pacchetto creato | completare risorse e licenze |
| Architettura non supportata | `build-python.js` / `prepare-resources.js` rifiutano il target | eseguire sulla macchina corretta |
