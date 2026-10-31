# Architettura

## 1. Visione d'insieme

L'applicazione è composta da **tre programmi distinti** che collaborano:

| Programma | Linguaggio | Ruolo |
|-----------|-----------|-------|
| Electron (main + renderer) | JavaScript / Node.js / HTML / CSS | finestra, GUI, orchestrazione |
| Server Express | JavaScript (dentro il main process) | API locale per i job di conversione |
| Convertitore | Python + PyAV (librerie FFmpeg in C), compilato con PyInstaller | analisi, decodifica audio, codifica MP3 |

```
                   ┌─────────────────────────────────────────────────────────┐
                   │                ELECTRON MAIN PROCESS (Node.js)          │
                   │                                                         │
 ┌──────────────┐  │  main.js ─┬─ resource-resolver.js  (dove è il convertitore?)│
 │  RENDERER    │  │           ├─ file-registry.js      (fileId -> percorso)  │
 │  (sandbox)   │  │           ├─ job-manager.js ──── process-manager.js ─────┼──► converter (Python)
 │  index.html  │  │           │                                              │      └─ PyAV: libavformat,
 │  app.js      │──┼─ fetch ──►├─ express-server.js  127.0.0.1:<porta>        │         libavcodec, libmp3lame
 │              │  │  + token  │                                              │
 │ window.      │──┼─ IPC ────►├─ ipc-handlers.js  (dialog, salva, log)       │
 │ desktopApi   │  │ (preload) └─ logger.js                                   │
 └──────────────┘  └─────────────────────────────────────────────────────────┘
```

### Perché Electron e il convertitore Python non sono "un unico programma"

Un junior potrebbe chiedersi: *perché non compilare tutto in un solo eseguibile?*

1. **Sono tecnologie diverse con runtime diversi.** Electron contiene Chromium e Node.js (V8);
   Python ha il proprio interprete (con PyAV e le librerie FFmpeg in C). Non esiste un compilatore che li fonda.
2. **Isolamento dei guasti.** Se la decodifica va in crash su un file danneggiato, muore solo il convertitore:
   la GUI resta viva e mostra un errore comprensibile.
3. **Annullamento affidabile.** Un processo separato si può terminare in qualsiasi momento;
   una libreria caricata nello stesso processo no.
4. **Licenze.** Le librerie FFmpeg (da trattare come GPL nella build di PyAV) restano in un programma
   separato dall'app Electron, che comunica solo tramite pipe: i confini fra componenti con licenze diverse
   sono chiari (vedi [LICENSE_COMPLIANCE.md](LICENSE_COMPLIANCE.md)).
5. **Sostituibilità.** Si può aggiornare il motore (PyAV) senza ricompilare il resto, e viceversa.
6. **Sicurezza.** Il renderer non ha alcun privilegio; solo il main process avvia processi,
   e lo fa con argomenti validati.

Il prezzo da pagare è la comunicazione fra processi: la risolviamo con un protocollo semplice
(JSON Lines, vedi §4) e con codici di errore stabili.

## 2. Componenti

### 2.1 Main process — `src/main/main.js`

**Problema risolto:** qualcuno deve coordinare tutto e possedere i privilegi del sistema operativo.
**Responsabilità:** ciclo di vita dell'app, single-instance lock, avvio di Express, finestra,
restrizioni di sicurezza della sessione, IPC, graceful shutdown.
**Funzionamento:** legge `app.isPackaged` una sola volta e costruisce un *runtime context*
(`resource-resolver.js`); poi crea logger, cartella temporanea di sessione, job manager, server e finestra.
**Comunicazione:** con il renderer via IPC (preload) e HTTP (Express); con il convertitore via processo figlio.
**Errori comuni:** usare `require('electron')` in moduli che si vogliono testare senza Electron
(qui solo `main.js`, `ipc-handlers.js` e `preload.js` dipendono da Electron).
**Test:** `npm run smoke` avvia l'app reale, verifica bridge, assenza di `require` nel renderer, GUI pronta.

### 2.2 Preload — `src/main/preload.js`

**Problema:** la GUI deve poter aprire dialog nativi senza ottenere i poteri di Node.js.
**Responsabilità:** esporre `window.desktopApi` con 7 funzioni dalla firma fissa, via `contextBridge`.
**Funzionamento:** ogni funzione chiama `ipcRenderer.invoke` su un canale fisso. Il percorso dei file
trascinati è ricavato **nel preload** con `webUtils.getPathForFile`: la pagina non lo vede mai.
**Errori comuni:** esporre `ipcRenderer` intero; importare file locali (in sandbox non è possibile).
**Test:** `tests/unit/ipc-validation.test.js` verifica che i canali del preload coincidano con l'allowlist.

### 2.3 Renderer — `src/renderer/`

**Problema:** offrire un'interfaccia chiara, accessibile, senza framework.
**Responsabilità:** stato della GUI (macchina a stati), drag-and-drop, polling dell'avanzamento.
**Funzionamento:** `app.js` riceve URL e token via IPC (in memoria), chiama l'API locale con `fetch`,
aggiorna il DOM solo con `textContent`.
**Stati:** `idle → checking → ready | invalid → queued → analyzing → converting → finalizing →
completed → saved`, più `cancelling → cancelled` ed `error`.
**Errori comuni:** usare `innerHTML` con dati esterni (XSS); salvare il token in `localStorage`.
`npm run check` segnala entrambi.

### 2.4 Express — `src/main/express-server.js`

**Problema:** serve un'API semplice e testabile per orchestrare i job.
**Responsabilità:** servire la GUI statica e le API; validare le richieste; non esporre percorsi.

| Metodo | Percorso | Descrizione |
|--------|----------|-------------|
| GET | `/api/config` | qualità ammesse, estensioni, stato delle risorse |
| POST | `/api/jobs` | `{ fileId, bitrate }` → crea un job (202) |
| GET | `/api/jobs/:id` | stato e avanzamento |
| POST | `/api/jobs/:id/cancel` | annulla |
| DELETE | `/api/jobs/:id` | elimina job e temporanei |
| GET | `/api/about` | versioni, motore PyAV/FFmpeg e licenza valutata |
| GET | `/api/licenses`, `/api/licenses/:id` | testi di licenza (allowlist) |

Protezioni: loopback, porta effimera, controllo `Host` e `Origin`, token Bearer, CSP, limite del corpo 16 KB.
Dettagli in [SECURITY.md](SECURITY.md).

### 2.5 Job manager e process manager

`job-manager.js` gestisce stati, cartelle temporanee, verifica del risultato e shutdown.
`process-manager.js` avvia il convertitore **senza shell**, legge stdout riga per riga, valida
gli eventi, inoltra stderr ai log, annulla in modo cooperativo e, se serve, forzato.

### 2.6 Resource resolver — `src/main/resource-resolver.js`

È l'**unico** punto che conosce la differenza fra sviluppo e produzione:

| | Sviluppo (`npm run dev`) | Produzione (app installata) |
|---|---|---|
| radice risorse | `<progetto>/resources` | `process.resourcesPath` |
| convertitore | `python -u -I src/python/convert.py` | `resources/python-converter/<key>/converter/converter[.exe]` |

`resolveConverterExecutable()` centralizza la scelta. All'avvio `checkResources()` verifica esistenza,
permessi e architettura (lettura dell'header, `binary-inspector.js`) senza eseguire nulla; poi
`main.js` esegue `converter --version` e `applyEngineCheck()` verifica che PyAV e `libmp3lame` ci siano davvero.

### 2.7 Convertitore Python — `src/python/convert.py`

Libreria standard + **PyAV** ([MEDIA_ENGINE.md](MEDIA_ENGINE.md)). Passi: validazione argomenti → caricamento
di PyAV e verifica di `libmp3lame` → `av.open()` e analisi delle tracce (durata, codec, audio presente) →
stima spazio su disco → lettura dei soli pacchetti audio, ricampionamento, codifica MP3 frame per frame
con avanzamento reale (`frame.time` / durata) → rinomina `output.mp3.part` → `output.mp3` → evento `completed`.

## 3. Flusso di una conversione

```
Utente        Renderer            Preload/IPC        Main (Express/JobManager)      Python         PyAV
  │ trascina    │                    │                       │                         │              │
  │────────────►│ registerDropped ──►│ getPathForFile ──────►│ FileRegistry.register   │              │
  │             │◄─────────── { fileId, name, size } ────────│ (stat, estensione)      │              │
  │ Converti    │ POST /api/jobs {fileId, bitrate} ─────────►│ createJob: UUID, temp   │              │
  │             │                                            │ spawn(converter, args) ►│ av.open ────►│
  │             │ GET /api/jobs/:id (ogni 400 ms) ──────────►│◄── JSON Lines ──────────│ decode/enc ─►│
  │             │◄──────── { state, progress } ──────────────│                         │◄─ frame.time │
  │             │                                            │◄── completed ───────────│              │
  │ Salva MP3   │ saveResult(jobId) ─►│ dialog nativo ──────►│ copia + verifica + rm   │              │
```

## 4. Protocollo JSON Lines (Python → Node.js)

Una riga = un oggetto JSON completo. stdout contiene **solo** eventi; stderr contiene log tecnici.

```json
{"type":"status","status":"analyzing","message":"Analisi del file"}
{"type":"probe","durationSeconds":123.4,"audioCodec":"aac","container":"mov,mp4,m4a,3gp,3g2,mj2","hasVideo":true}
{"type":"status","status":"converting","message":"Conversione in corso"}
{"type":"progress","progress":42.5,"processedSeconds":51.2}
{"type":"status","status":"finalizing","message":"Finalizzazione"}
{"type":"completed","outputPath":"..."}
{"type":"error","code":"NO_AUDIO_STREAM","message":"Il file non contiene una traccia audio"}
{"type":"cancelled","message":"Conversione annullata"}
```

- `progress` può essere `null` se la durata è ignota (barra indeterminata).
- Node.js valida ogni riga (`validateEvent`): tipi ammessi, intervalli numerici, lunghezze massime.
  Le righe non valide vengono registrate nel log e ignorate.
- Node.js non si fida di `outputPath`: deve coincidere con il percorso che ha richiesto e il file deve esistere.
- Python scrive JSON in ASCII (`ensure_ascii=True`) per evitare problemi di codifica delle pipe su Windows.

### Codici di uscita del convertitore

| Codice | Significato |
|--------|-------------|
| 0 | completato |
| 1 | errore interno |
| 2 | argomenti non validi |
| 3 | motore multimediale (PyAV) mancante o encoder MP3 assente |
| 4 | input mancante, illeggibile o danneggiato |
| 5 | nessuna traccia audio |
| 6 | errore di codifica/scrittura |
| 7 | spazio su disco insufficiente |
| 130 | annullato |

## 5. Avanzamento: polling, SSE o IPC?

**Scelta: polling HTTP ogni 400 ms.**

| Opzione | Pro | Contro |
|---------|-----|--------|
| **Polling** (scelto) | semplicissimo, stateless, il token resta nell'header, facile da testare | qualche richiesta "a vuoto" (trascurabile in locale) |
| Server-Sent Events | push in tempo reale | `EventSource` non permette header personalizzati: il token finirebbe nell'URL (log, cronologia); riconnessioni da gestire |
| IPC push (`webContents.send`) | nessun HTTP | aumenta la superficie del preload (listener), meno testabile senza Electron |

Con 400 ms l'aggiornamento è fluido e il costo è nullo per un server locale.

## 6. Annullamento e chiusura

1. Il renderer chiama `POST /api/jobs/:id/cancel`.
2. Il process manager scrive `cancel\n` su stdin del convertitore e chiude stdin.
3. Il ciclo di conversione (che controlla il flag a ogni pacchetto audio) si ferma subito, il file `.part`
   viene cancellato, Python emette `cancelled` ed esce con 130.
4. Se entro 5 s il processo non è uscito: terminazione forzata dell'**albero** di processi
   (`taskkill /T /F` su Windows, `kill(-pgid)` su macOS/Linux).
5. Il job manager elimina la cartella temporanea del job.

Usare stdin invece dei segnali è una scelta voluta: funziona allo stesso modo su tutti i sistemi
e, se Electron muore all'improvviso, la chiusura della pipe (EOF) fa terminare anche il convertitore.

**Chiusura dell'app:** se c'è una conversione attiva viene chiesta conferma; poi `gracefulShutdown()`
annulla i job, attende (max 8 s), forza i processi rimasti, chiude Express ed elimina la cartella di sessione.
All'avvio successivo eventuali cartelle di sessioni interrotte da un crash vengono rimosse.

## 7. File temporanei

```
<tmp del sistema>/video-to-mp3-desktop-<hash utente>/      (permessi 0700)
└── session-<16 hex casuali>/                              una per avvio
    └── <job UUID>/
        ├── output.mp3.part   durante la conversione
        └── output.mp3        al termine, finché l'utente non salva
```

Il nome originale del video è solo un metadato (mostrato in GUI, usato per suggerire il nome di salvataggio).
Il cleanup rifiuta di cancellare qualunque percorso fuori dalla radice temporanea (`isInside`).

## 8. Scelte e alternative

| Scelta | Alternativa | Motivo |
|--------|-------------|--------|
| Express nel main process | Express in un processo Node separato | meno processi, shutdown più semplice; il lavoro pesante è già in processi separati |
| GUI servita da Express | `loadFile()` da `file://` | stessa origine per API e pagina: CSP `connect-src 'self'`, niente CORS |
| PyAV (librerie FFmpeg incluse) | binari `ffmpeg`/`ffprobe` esterni | nessun binario da procurare e verificare a mano; avanzamento e annullamento frame per frame; costo: +~70 MB e licenza GPL da gestire |
| electron-builder | Electron Forge | vedi [PACKAGING.md](PACKAGING.md) |
| Un job alla volta | coda di job | semplicità; la coda è un'estensione naturale del job manager |
| Logger interno | electron-log / winston | nessuna dipendenza aggiuntiva; rotazione e sanitizzazione bastano |
