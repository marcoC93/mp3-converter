# Guida per junior developer

Questa guida spiega da zero i concetti usati nel progetto. Leggila con il codice aperto accanto:
ogni sezione indica i file da guardare.

---

## Parte 1 — Concetti

### Electron
Electron è un framework per creare applicazioni desktop con tecnologie web. Un'app Electron contiene
una copia di **Chromium** (il motore del browser Chrome) e di **Node.js**. Per questo i pacchetti
pesano ~100 MB: il "browser" è incluso.

### Main process e renderer process
- Il **main process** (`src/main/main.js`) è un programma Node.js: può leggere file, avviare processi,
  aprire finestre e dialog. Ce n'è **uno**.
- Il **renderer process** è la pagina web dentro la finestra (`src/renderer/`). Ce n'è uno per finestra.
  Qui gira il codice della GUI, **senza** accesso a Node.js.

Pensa al main process come al "back-office" con le chiavi dell'edificio, e al renderer come allo
"sportello" che parla con il pubblico: lo sportello non ha le chiavi, ma può fare richieste precise.

### Preload script e contextBridge
Il **preload** (`src/main/preload.js`) è un piccolo script che Electron esegue *prima* della pagina, in un
contesto separato. Con `contextBridge.exposeInMainWorld('desktopApi', {...})` mette a disposizione della
pagina solo alcune funzioni. La pagina vede `window.desktopApi.selectVideo()`, ma non vede `require`,
`ipcRenderer` o il filesystem.

### IPC (Inter-Process Communication)
È il modo in cui renderer e main si parlano. Noi usiamo `ipcRenderer.invoke(canale, ...args)` nel preload e
`ipcMain.handle(canale, fn)` nel main. Regole del progetto (`src/main/ipc-validation.js`):
allowlist dei canali, validazione di ogni argomento, verifica del mittente, risposte `{ ok, ... }` senza eccezioni.

### Perché `nodeIntegration` è disabilitato
Se la pagina avesse accesso a Node.js, qualunque bug di tipo XSS (es. un nome di file con dentro
`<img onerror=...>`) diventerebbe **esecuzione di codice sul computer**. Con `nodeIntegration: false`,
`contextIsolation: true` e `sandbox: true`, anche una pagina compromessa può solo chiamare le 7 funzioni del preload.

### Express e perché ascolta solo su loopback
Express è un framework minimale per server HTTP in Node.js. Il nostro server ascolta su `127.0.0.1`
(*loopback*): un indirizzo che esiste solo **dentro** il computer. Se ascoltasse su `0.0.0.0`, chiunque
nella stessa rete Wi-Fi potrebbe chiamare le API. In più usiamo una porta casuale, un token segreto e il
controllo degli header `Host` e `Origin` (vedi [SECURITY.md](SECURITY.md)).

### Processi figli
Un processo figlio è un programma avviato da un altro programma. Node.js usa `child_process.spawn`,
Python `subprocess.Popen`. Qui c'è un solo livello: Electron avvia il convertitore Python, che fa tutto al suo interno con PyAV.
**Regola d'oro:** mai `shell: true` / `shell=True`. Gli argomenti si passano come **lista**: così un nome di file
come `a"; rm -rf ~; ".mp4` resta un nome di file e non diventa un comando.

### stdin, stdout, stderr
Ogni processo ha tre canali standard:
- **stdin** (ingresso): noi lo usiamo per inviare `cancel` al convertitore;
- **stdout** (uscita): il convertitore vi scrive **solo** eventi JSON Lines;
- **stderr** (errori/diagnostica): log tecnici, finiscono nel file di log, mai nella GUI.

### JSON Lines
Formato in cui ogni riga è un oggetto JSON completo. Vantaggi: si può leggere riga per riga mentre il
processo è ancora in esecuzione (streaming), e una riga corrotta non rovina le altre.
Il parser è `parseEventLine()` in `src/main/process-manager.js`.

### FFmpeg e PyAV
- **FFmpeg** è il progetto libero di riferimento per audio e video: le sue librerie (libavformat per i
  contenitori, libavcodec per i codec, libswresample per il ricampionamento) sanno leggere quasi ogni formato.
- **PyAV** è una libreria Python che "avvolge" queste librerie. Il pacchetto `av` installato con `pip` contiene
  le librerie FFmpeg già compilate, incluso l'encoder MP3 `libmp3lame`: **non servono programmi esterni**.
- Con PyAV apriamo il video (`av.open`), leggiamo durata e tracce, decodifichiamo solo l'audio e lo
  ricodifichiamo in MP3. Ogni frame audio ha un tempo (`frame.time`): confrontato con la durata totale dà
  la percentuale **reale**. Approfondimento: [MEDIA_ENGINE.md](MEDIA_ENGINE.md).

### Bitrate
Quantità di dati al secondo usata per rappresentare l'audio (kbps). Più alto = file più grande e,
fino a un certo punto, qualità maggiore. Approfondimento: [AUDIO_QUALITY.md](AUDIO_QUALITY.md).

### File temporanei
L'MP3 viene prima creato in una cartella temporanea privata dell'app, poi copiato dove sceglie l'utente.
Così un file a metà non finisce mai nella cartella Musica, e un annullamento lascia il disco pulito.

### Graceful shutdown
"Chiusura ordinata": prima di uscire l'app annulla le conversioni, aspetta che i processi figli
terminino (o li forza dopo un timeout), chiude il server e cancella i temporanei. Il contrario è
uscire di colpo lasciando processi del convertitore "orfani" che continuano a girare.

### Packaging, sorgente e applicazione installabile
Il **sorgente** è questo repository: serve Node.js, Python, npm... Il **pacchetto** (installer) contiene
invece tutto già pronto: Electron, il codice JavaScript (in `app.asar`), il convertitore compilato (che include Python, PyAV e le librerie FFmpeg).
L'utente finale riceve solo il pacchetto.

### Eseguibile standalone e PyInstaller
PyInstaller raccoglie lo script Python, l'interprete e le librerie usate e crea un eseguibile che gira
**senza Python installato**.
- **onedir** (scelto): una cartella `converter/` con l'eseguibile e la sottocartella `_internal/`.
  Avvio rapido, struttura visibile, facile da diagnosticare.
- **onefile**: un solo file che a ogni avvio si estrae in una cartella temporanea. Più comodo da
  spostare, ma più lento, più soggetto a falsi positivi antivirus e più difficile da firmare su macOS.

### Binari nativi
Un binario nativo è codice macchina per uno specifico **sistema operativo** (formato PE su Windows,
Mach-O su macOS, ELF su Linux) e una specifica **architettura** del processore. Un `converter.exe` non
gira su Linux, e un convertitore ARM64 non gira su un PC x64 (lo stesso vale per le librerie FFmpeg incluse in PyAV:
per questo il convertitore va compilato su ogni piattaforma). `src/main/binary-inspector.js` legge l'header
del file per accorgersene prima di eseguirlo.

### Architetture x64 e ARM64
- **x64** (x86-64, AMD64): la maggior parte dei PC Windows/Linux e i Mac Intel.
- **ARM64** (aarch64): Mac con Apple Silicon (M1, M2, ...), alcuni PC Windows (Snapdragon), Raspberry Pi 4/5.
Ogni architettura richiede binari propri: per questo esiste una cartella per ogni `<piattaforma>-<arch>`.

### Installer
Programma che copia l'app nel sistema, crea collegamenti e una voce per la disinstallazione:
NSIS su Windows, DMG (immagine disco da cui trascinare l'app) su macOS, `.deb` su Debian/Ubuntu.
L'AppImage non si installa: è un unico file eseguibile.

### Firma del codice e notarizzazione
La **firma** attesta chi ha pubblicato il software e che non è stato modificato. La **notarizzazione** è
un controllo automatico di Apple su un'app firmata. Senza firma Windows mostra SmartScreen e macOS
blocca l'app con Gatekeeper. Dettagli: [CODE_SIGNING.md](CODE_SIGNING.md).

### Licenze di terze parti
Includendo PyAV/FFmpeg, Electron, Python ecc. accettiamo le loro licenze: alcune chiedono solo attribuzione
(MIT), altre (LGPL/GPL) richiedono anche di rendere disponibile il codice sorgente corrispondente.
Vedi [LICENSE_COMPLIANCE.md](LICENSE_COMPLIANCE.md).

### Sviluppo e produzione
| | Sviluppo | Produzione |
|---|---|---|
| avvio | `npm run dev` | doppio clic sull'app installata |
| `app.isPackaged` | `false` | `true` |
| convertitore | `convert.py` con il Python locale | eseguibile PyInstaller |
| PyAV | installato nel `.venv` con pip | incluso nell'eseguibile del convertitore |
| DevTools | disponibili | disabilitati (salvo `--debug-logging`) |

---

## Parte 2 — I componenti, uno per uno

Per ciascun componente: 1) problema, 2) responsabilità, 3) funzionamento, 4) comunicazione,
5) errori comuni, 6) come testarlo, 7) come modificarlo in sicurezza, 8) alternative.

### Convertitore Python (`src/python/convert.py`)
1. Serve un "operaio" che sappia leggere i video, codificare l'MP3 e riferire progressi strutturati.
2. Validare input, analizzare il file, convertire con PyAV, riportare eventi ed errori.
3. Vedi `convert()`: validazioni → `load_engine` (PyAV + libmp3lame) → `analyze_container` →
   `check_disk_space` → `transcode` (decodifica solo l'audio, ricampiona, codifica; controlla
   l'annullamento a ogni pacchetto e invia l'avanzamento con `ProgressReporter`).
4. Riceve argomenti da riga di comando e `cancel` su stdin; scrive JSON Lines su stdout e log su stderr.
5. Stampare testo libero su stdout (rompe il protocollo: usa `log()`); dimenticare `flush`; usare `shell=True`.
6. `npm run test:python` (unit + end-to-end su video sintetici generati con PyAV da `tests/fixtures/make_media.py`).
7. Aggiungi un nuovo evento? Aggiornalo anche in `validateEvent()` (Node) e nei test di entrambi i lati.
   Aggiungi un codice di errore? Aggiungilo in `src/main/errors.js`.
8. Alternative: lanciare i programmi `ffmpeg`/`ffprobe` (servono binari esterni da procurare e verificare),
   oppure pilotare FFmpeg da Node.js. PyAV evita binari esterni e dà controllo frame per frame;
   costo: +~70 MB e licenza da gestire (vedi [LICENSE_COMPLIANCE.md](LICENSE_COMPLIANCE.md)).

### Process manager (`src/main/process-manager.js`)
1. Avviare e controllare il convertitore in modo robusto.
2. spawn senza shell, lettura riga per riga, validazione eventi, annullamento, kill dell'albero.
3. `readline` su stdout → `parseEventLine` → evento `event`; `close` → evento `exit`.
4. Emette eventi verso il job manager.
5. Ascoltare `exit` invece di `close` (si perdono le ultime righe); non gestire `error` di spawn.
6. `tests/unit/process-manager.test.js` usa piccoli script Node come processi finti.
7. Mantieni `shell: false` e gli argomenti come array. Non loggare argomenti con percorsi senza sanitizzazione.
8. `execa` o simili: comodi, ma una dipendenza in più per poco vantaggio.

### Job manager (`src/main/job-manager.js`)
1. Tenere traccia delle conversioni e dei loro file.
2. Stati, cartelle temporanee, verifica del risultato, cleanup, shutdown.
3. Vedi il diagramma in testa al file.
4. Usato da Express (creazione/stato) e dagli handler IPC (salvataggio).
5. Esporre percorsi interni nella vista pubblica; cancellare cartelle senza controllare `isInside`.
6. `tests/unit/job-manager.test.js` (processo finto) e `tests/integration/converter.test.js` (Python vero).
7. Aggiungi campi alla vista pubblica solo in `toPublic()`, mai percorsi.
8. Una coda di job concorrenti: possibile, ma aumenta il carico su CPU e disco.

### Express (`src/main/express-server.js`)
1. API locale semplice e testabile per i job.
2. Static file, API JSON, protezioni.
3. Middleware in ordine: Host → header di sicurezza → Origin → static → token → JSON → route → errori.
4. Riceve `fetch` dal renderer; chiama il job manager.
5. Dimenticare il controllo del token su una nuova route (mettila nel router `api`); restituire `err.message`.
6. `tests/unit/express-server.test.js` con richieste HTTP grezze.
7. Ogni nuova route sotto `/api` eredita token e parsing; valida il corpo con allowlist dei campi.
8. Solo IPC (nessun server): più semplice, ma il progetto richiede Express e l'API è comoda da testare.

### Resource resolver (`src/main/resource-resolver.js`)
1. Trovare FFmpeg e il convertitore in sviluppo e in produzione.
2. Centralizzare la differenza dev/prod e verificare le risorse.
3. `createRuntimeContext()` → `resolveFfmpegPaths()`, `resolveConverterExecutable()`, `checkResources()`.
4. Usato da `main.js` all'avvio; i percorsi risolti passano al job manager.
5. Scrivere `if (app.isPackaged)` in altri file: centralizza qui.
6. `tests/unit/resource-resolver.test.js` simula tutte le piattaforme da qualunque sistema.
7. Nuova piattaforma? Aggiungila a `SUPPORTED_PLATFORM_KEYS`, a `binary-inspector` e alla matrice di build.

### GUI (`src/renderer/`)
1. Interfaccia per utenti non tecnici.
2. Selezione file, qualità, avanzamento, salvataggio, errori, informazioni, licenze.
3. Macchina a stati in `app.js`, rendering in `render()`.
4. IPC tramite `window.desktopApi`, HTTP tramite `apiFetch()`.
5. `innerHTML` con dati esterni; script inline (bloccati dalla CSP); risorse remote (bloccate).
6. `npm run smoke`; test manuali in [TESTING.md](TESTING.md).
7. Aggiungi testo solo con `textContent`; nuovi file statici solo in `src/renderer/`.
8. Un framework (React, Vue) è escluso per scelta: per una schermata, JS vanilla è sufficiente.

---

## Parte 3 — Percorso di studio consigliato

1. Leggi [ARCHITECTURE.md](ARCHITECTURE.md) e guarda il diagramma.
2. Esegui `npm test` e leggi `tests/python/test_convert.py`: capisci il protocollo dal lato Python.
3. Leggi `src/python/convert.py` dall'alto verso il basso.
4. Leggi `src/main/process-manager.js` e `tests/unit/process-manager.test.js`.
5. Leggi `src/main/job-manager.js` e il suo test.
6. Leggi `src/main/express-server.js`, poi [SECURITY.md](SECURITY.md).
7. Leggi `src/main/preload.js`, `ipc-validation.js`, `ipc-handlers.js`.
8. Leggi `src/main/main.js`.
9. Leggi `src/renderer/app.js` con l'app aperta (`npm run dev:debug`, DevTools con Ctrl+Shift+I).
10. Leggi [PACKAGING.md](PACKAGING.md) e prova `npm run build:python`.
11. Infine [LICENSE_COMPLIANCE.md](LICENSE_COMPLIANCE.md) e [CODE_SIGNING.md](CODE_SIGNING.md).

**Esercizi:**
- aggiungi un'opzione "96 kbps" (Node: `validation.js`; Python: `ALLOWED_BITRATES`; test di entrambi);
- mostra il tempo stimato rimanente nella GUI (dati già presenti: `processedSeconds`, `durationSeconds`);
- aggiungi un evento `warning` al protocollo e gestiscilo end-to-end.
