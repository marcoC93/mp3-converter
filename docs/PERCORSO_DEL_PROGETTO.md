# Come è stato costruito questo progetto — passo per passo

Questo documento racconta, in ordine, **cosa è stato fatto** e **perché**. Non è un manuale di
riferimento (per quello ci sono [ARCHITECTURE.md](ARCHITECTURE.md) e [JUNIOR_GUIDE.md](JUNIOR_GUIDE.md)):
è il "diario di bordo" delle decisioni, compresi gli errori trovati e corretti lungo la strada.

Leggilo con il codice aperto: ogni passo indica i file coinvolti.

---

## Passo 0 — Capire il problema prima di scrivere codice

**Cosa chiedeva il progetto:** un'app desktop che converte video in MP3, installabile con doppio clic su
Windows, macOS e Linux, senza che l'utente installi Python, Node.js o FFmpeg.

**Prima cosa fatta:** controllare l'ambiente di lavoro.

```
cartella vuota · Windows 11 x64 · Node 26 · Python 3.14 · FFmpeg assente · PyInstaller assente
```

**Perché è importante:** questo controllo ha deciso cosa si poteva *davvero* verificare. Senza FFmpeg
non si poteva fare una conversione reale né creare un installer funzionante. Da qui una regola seguita
per tutto il progetto: **non dichiarare mai riuscito qualcosa che non è stato eseguito**.

> 💡 Lezione: prima di promettere un risultato, verifica quali strumenti hai a disposizione.

---

## Passo 1 — Scegliere l'architettura: quattro programmi, non uno

La tentazione sarebbe "un unico programma che fa tutto". Ma Electron (JavaScript + Chromium),
Python e FFmpeg (C) sono tecnologie con runtime diversi: **non si possono fondere** in un solo eseguibile.

Abbiamo quindi scelto una catena di processi:

```
Electron (finestra + Express) ──► convertitore Python ──► ffprobe / ffmpeg
```

*(Nota: nella versione attuale ffprobe e ffmpeg sono stati sostituiti da PyAV dentro il convertitore:
vedi Passo 12. Le ragioni della separazione Electron ↔ Python restano valide.)*

**Perché è anche una scelta migliore, non solo obbligata:**
- se FFmpeg va in crash su un file rotto, muore solo FFmpeg: la finestra resta viva e mostra un errore;
- un processo separato si può **annullare** in qualsiasi momento;
- FFmpeg si può aggiornare senza ricompilare il resto;
- i confini fra licenze diverse restano chiari (FFmpeg è un programma separato, non una libreria collegata).

**Il costo:** i processi devono comunicare. Questo ha portato alla decisione del passo 2.

---

## Passo 2 — Prima il convertitore Python, poi il resto

File: [`src/python/convert.py`](../src/python/convert.py)

Siamo partiti dal "cuore" perché tutto il resto dipende dal suo **contratto** (come comunica).

### Decisione 2.1 — Comunicare con JSON Lines

Il convertitore scrive su stdout **una riga JSON per evento**:

```json
{"type":"status","status":"analyzing","message":"Analisi del file"}
{"type":"progress","progress":42.5,"processedSeconds":51.2}
{"type":"completed","outputPath":"..."}
```

**Perché:** Node.js può leggere riga per riga *mentre* la conversione è in corso, e una riga corrotta non
rovina le altre. I log tecnici vanno invece su **stderr**: mescolarli con gli eventi renderebbe il parsing fragile.

### Decisione 2.2 — Solo libreria standard

Nessuna dipendenza esterna (niente `ffmpeg-python`).
**Perché:** eseguibile più piccolo, niente da installare, meno codice di terzi di cui fidarsi.

### Decisione 2.3 — Mai `shell=True`

Il comando FFmpeg è una **lista** di argomenti (`build_ffmpeg_command`).
**Perché:** un file chiamato `video"; rm -rf ~; ".mp4` con la shell diventerebbe un comando eseguito.
Con una lista resta solo un nome di file.

### Decisione 2.4 — Avanzamento reale con `-progress pipe:1`

FFmpeg scrive righe come `out_time_us=51200000`. Confrontandole con la durata letta da **ffprobe**
otteniamo la percentuale vera (classe `ProgressTracker`).
**Perché:** una barra "finta" che avanza a tempo mente all'utente. Se la durata è sconosciuta, la barra diventa
indeterminata invece di inventare un numero.

### Decisione 2.5 — Non fidarsi dell'estensione

Un file `.mp4` può essere un PDF rinominato. ffprobe controlla contenitore, tracce, codec e durata;
se non c'è audio il convertitore risponde `NO_AUDIO_STREAM` con un messaggio comprensibile.

### Decisione 2.6 — Scrivere su `output.mp3.part`, poi rinominare

**Perché:** un MP3 a metà (crash, annullamento) non deve mai essere scambiato per un risultato valido.
Il file prende il nome definitivo solo quando FFmpeg ha finito con successo.

### Decisione 2.7 — Annullare tramite stdin, non con i segnali

Node.js scrive `cancel` sullo stdin del convertitore.
**Perché:** i segnali (`SIGTERM`) funzionano in modo diverso su Windows. Stdin funziona ovunque, e ha un
bonus: se Electron muore all'improvviso, stdin si chiude (EOF) e il convertitore ferma FFmpeg da solo.
Niente processi "orfani".

### Decisione 2.8 — Codici di errore e di uscita stabili

`NO_AUDIO_STREAM`, `INVALID_MEDIA`... e codici di uscita documentati (0, 2, 3, ..., 130).
**Perché:** il testo per l'utente si scrive in **un solo posto** (Node.js, `errors.js`); Python comunica solo codici.

---

## Passo 3 — Packaging del Python con PyInstaller

File: [`src/python/converter.spec`](../src/python/converter.spec), [`scripts/build-python.js`](../scripts/build-python.js)

### Decisione 3.1 — Modalità *onedir*, non *onefile*

| onedir (scelto) | onefile |
|---|---|
| cartella con eseguibile + `_internal/` | un solo file |
| avvio immediato | si estrae nel temp a ogni avvio |
| contenuto ispezionabile | contenuto nascosto |
| meno falsi positivi antivirus | più falsi positivi |

Dentro un pacchetto Electron il vantaggio "un solo file" non serve a nulla, quindi onedir.

### Decisione 3.2 — Rifiutare la cross-compilazione

`build-python.js` si ferma se chiedi di compilare per un sistema diverso da quello su cui sei, e controlla
che **l'architettura del Python** coincida con il target.
**Perché:** PyInstaller non è un cross-compiler. Meglio un errore chiaro subito che un eseguibile sbagliato
scoperto da un utente.

### Decisione 3.3 — Applicazione "console", ma nascosta

Su Windows l'eseguibile resta di tipo console e Electron lo avvia con `windowsHide: true`.
**Perché:** con un'app "senza console" le pipe stdin/stdout possono non funzionare in modo affidabile.
Così le pipe funzionano e l'utente non vede nessuna finestra nera.

### Verifica reale

Abbiamo installato PyInstaller in un `.venv` e compilato davvero il convertitore per **win32-x64**. Lo script
verifica che l'eseguibile risponda a `--version` con `"frozen": true` e che l'header del file sia PE x64.

---

## Passo 4 — Il main process di Electron

File: [`src/main/`](../src/main/)

### Decisione 4.1 — Moduli piccoli e testabili senza Electron

Solo `main.js`, `preload.js` e `ipc-handlers.js` importano `electron`. Job manager, Express, resolver,
validazione e process manager sono **Node.js puro**.
**Perché:** si possono testare con `node --test` in pochi secondi, senza aprire finestre.

### Decisione 4.2 — Un solo punto conosce sviluppo vs produzione

`resource-resolver.js` → `resolveConverterExecutable()`:
- in sviluppo: `python convert.py`;
- in produzione: `resources/python-converter/<piattaforma>-<arch>/converter/converter.exe`.

`app.isPackaged` viene letto **una volta** in `main.js`.
**Perché:** controlli `if (isPackaged)` sparsi ovunque sono difficili da trovare, da testare e da cambiare.

### Decisione 4.3 — Controllare i binari *prima* di eseguirli

`binary-inspector.js` legge i primi byte di ffmpeg e del convertitore (formati PE, ELF, Mach-O).
**Perché:** un ffmpeg Linux finito per errore nel pacchetto Windows produce errori incomprensibili
("non è un'applicazione Win32 valida"). Così diciamo esattamente cosa non va.

### Decisione 4.4 — Se manca qualcosa, l'app si apre comunque

Senza FFmpeg compare il banner "Componenti mancanti", invece di un crash all'avvio.
**Perché:** l'utente capisce il problema e può aprire i log.

### Decisione 4.5 — Il renderer non vede mai un percorso

Quando l'utente sceglie un file, il main lo verifica e restituisce solo `{ fileId, name, size }`
(`file-registry.js`). Per convertire, il renderer manda il `fileId`.
**Perché:** anche una pagina compromessa non può dire "converti `C:\Windows\...`".

### Decisione 4.6 — Cartelle temporanee isolate per job

```
<tmp>/video-to-mp3-desktop-<hash>/session-<casuale>/<UUID job>/output.mp3
```
Il cleanup rifiuta di cancellare qualunque cosa fuori da questa radice (`isInside`).
**Perché:** un bug nel cleanup non deve mai poter cancellare file dell'utente.

### Decisione 4.7 — Graceful shutdown

Chiudendo l'app durante una conversione: richiesta di conferma → annullamento → attesa (max 8 s) →
terminazione forzata dell'**albero** di processi → chiusura del server → rimozione dei temporanei.
All'avvio successivo, eventuali avanzi di un crash vengono cancellati.

---

## Passo 5 — Express e sicurezza dell'API locale

File: [`src/main/express-server.js`](../src/main/express-server.js)

Un server HTTP locale è comodo, ma **qualunque sito aperto nel browser** potrebbe provare a chiamarlo.
Per questo abbiamo messo cinque protezioni, ognuna contro un attacco preciso:

| Protezione | Contro cosa |
|---|---|
| ascolto su `127.0.0.1` | altri dispositivi nella rete Wi-Fi |
| porta casuale (`listen(0)`) | conflitti di porta e indovinelli |
| controllo header `Host` | *DNS rebinding* (un dominio malevolo che punta a 127.0.0.1) |
| controllo header `Origin` | richieste partite da altre pagine web |
| token segreto nell'header `Authorization` | altri programmi locali |

Il token arriva al renderer via IPC e resta **solo in una variabile**: niente `localStorage`, niente URL.

### Decisione 5.1 — Polling invece di Server-Sent Events

La GUI chiede lo stato ogni 400 ms.
**Perché:** `EventSource` (SSE) non permette header personalizzati, quindi il token sarebbe finito
nell'URL. Il polling in locale costa praticamente nulla ed è semplicissimo da testare.

### Decisione 5.2 — Errori sempre "puliti"

Le risposte di errore contengono solo `{ code, message, hint }`: mai stack trace, mai percorsi.

---

## Passo 6 — Preload e IPC

File: [`src/main/preload.js`](../src/main/preload.js), [`src/main/ipc-validation.js`](../src/main/ipc-validation.js)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Il preload espone **7 funzioni** dalla firma fissa; `ipcRenderer` non è mai esposto direttamente.
- Ogni canale ha un validatore che controlla **tutti** gli argomenti; il mittente deve essere la nostra pagina.
- I link esterni si aprono solo da un'allowlist di **chiavi** (`ffmpeg`, `lame`...), non da URL arbitrari.

**Perché:** se un giorno ci fosse un bug XSS nella GUI, l'attaccante potrebbe fare solo ciò che queste
7 funzioni permettono, con argomenti validati.

**Dettaglio tecnico non ovvio:** un preload in sandbox non può importare file locali, quindi i nomi dei canali
sono scritti due volte. Un test (`ipc-validation.test.js`) verifica che coincidano.

---

## Passo 7 — La GUI in JavaScript vanilla

File: [`src/renderer/`](../src/renderer/)

- **Macchina a stati** (`idle`, `ready`, `converting`, `completed`, `error`...): ogni stato decide cosa è visibile.
  **Perché:** con molti `if` sparsi è facile mostrare due pannelli insieme o nessuno.
- **Solo `textContent`**, mai `innerHTML`: un nome di file con HTML dentro resta testo.
- **Content Security Policy** senza script inline: niente `onclick="..."`, tutto in `app.js`.
- **Accessibilità:** regione `aria-live` per gli screen reader, focus visibile, tema chiaro/scuro automatico,
  rispetto di `prefers-reduced-motion`.
- **Salvataggio** con dialog nativo: il file viene copiato accanto alla destinazione, verificato (dimensione)
  e poi rinominato; la conferma di sovrascrittura la dà il dialog.

---

## Passo 8 — Packaging: electron-builder invece di Electron Forge

File: [`electron-builder.config.js`](../electron-builder.config.js)

La richiesta era di preferire Forge **salvo motivazioni concrete**. Le motivazioni c'erano:

- NSIS e versione portable per Windows: nativi in electron-builder, non ufficiali in Forge;
- AppImage: nativo in electron-builder, solo plugin di terze parti in Forge;
- le macro `${platform}-${arch}` copiano automaticamente solo i binari giusti per ogni pacchetto.

Gli eseguibili (ffmpeg, convertitore) vanno in `extraResources`, **fuori** da `app.asar`, perché un
sistema operativo non può avviare un programma che si trova dentro un archivio.

### Decisione 8.1 — Un controllo che blocca i pacchetti incompleti

`scripts/prepare-resources.js` gira prima di ogni `npm run make:*` e si ferma se mancano il convertitore (con PyAV),
le informazioni di build (`build-info.json`) o se mancano licenze integrali e sorgente corrispondente del convertitore (Passo 12).
**Perché:** un installer che si apre ma non converte è peggio di nessun installer.

### Decisione 8.2 — Build non firmate riconoscibili

I file hanno il suffisso `-UNSIGNED-DEV`. Firma e notarizzazione si attivano solo da variabili d'ambiente:
**mai certificati nel repository**.

---

## Passo 9 — FFmpeg e licenze: non scaricare nulla "a caso"

File: [`scripts/verify-binaries.js`](../scripts/verify-binaries.js), [LICENSE_COMPLIANCE.md](LICENSE_COMPLIANCE.md)

Non abbiamo scaricato FFmpeg. Abbiamo invece creato uno script che **verifica** i binari che lo
sviluppatore colloca a mano: esistenza, permessi, architettura, versione, presenza di `libmp3lame`,
checksum SHA-256 e **classificazione della licenza** letta dalla riga `configuration`:

- niente `--enable-gpl` → LGPL;
- `--enable-gpl` → GPL (ridistribuibile, ma con obblighi maggiori);
- `--enable-nonfree` → **non ridistribuibile**, il packaging viene bloccato.

**Perché:** "è LGPL" non si presume, si verifica. E un binario di origine sconosciuta in un installer è un
rischio di sicurezza e legale.

---

## Passo 10 — Test: provare davvero, senza barare

File: [`tests/`](../tests/)

### Decisione 10.1 — Prima un FFmpeg finto, poi video veri generati al volo

Nella prima versione, senza FFmpeg disponibile, i test usavano un "FFmpeg finto" (uno script che imitava
ffmpeg e ffprobe). Con il passaggio a PyAV (Passo 12) non serve più: `tests/fixtures/make_media.py` **genera
video veri** (immagine fissa + tono a 440 Hz) in una cartella temporanea, e i test convertono davvero.
**Perché è meglio:** si testa il motore reale, non un'imitazione; e nessun file multimediale finisce nel repository.

### Decisione 10.2 — Test saltati, mai finti superati

Se PyAV non è installato o il convertitore non è compilato, i test relativi vengono **saltati** e lo dichiarano.

### Risultati effettivi (dopo il passaggio a PyAV)

| Suite | Esito |
|---|---|
| Node.js (unit + integrazione) | vedi `npm test`: tutti superati, nessuno saltato su questa macchina |
| Python | 17 superati |
| Smoke test Electron | superato (finestra, bridge, sandbox, drag-and-drop bridge, shutdown) |
| `npm run check` | superato |

---

## Passo 11 — Gli errori trovati verificando (e cosa insegnano)

Questa è forse la parte più utile per te. Ecco problemi **reali** emersi solo perché abbiamo verificato:

### 11.1 — electron-builder ignorava la configurazione
Abbiamo creato un pacchetto di prova e guardato dentro: **mancavano** convertitore e licenze.
electron-builder cerca `electron-builder.js/.yml/.json`, non `electron-builder.config.js`.
**Correzione:** `--config electron-builder.config.js` esplicito negli script npm.
> 💡 Lezione: "il comando è terminato con successo" non significa "il risultato è giusto". Ispeziona l'output.

### 11.2 — Percorsi utente sfuggiti alla pulizia dei log
Nel log del pacchetto di prova compariva `C:\Users\MARCO~1.CHI\...`: il nome breve "8.3" di Windows,
diverso da quello che il logger conosceva.
**Correzione:** regole generiche per `C:\Users\<qualcosa>`, `/home/<qualcosa>`, `/Users/<qualcosa>` + test.
> 💡 Lezione: i dati reali sono più vari di quelli che immagini scrivendo i test.

### 11.3 — Lo script di controllo segnalava sé stesso
`check.js` cerca la stringa `shell: true` nel codice... e la trovava nelle proprie regole.
**Correzione:** il file escluso dalla propria analisi.

### 11.4 — Il riquadro vuoto e la freccia gigante
Aprendo `index.html` direttamente nel pannello di anteprima (senza Electron e senza server), le opzioni di
qualità non arrivavano, il CSS non veniva applicato e le icone SVG occupavano tutto lo schermo.
**Correzioni:**
- la sezione qualità resta nascosta finché le opzioni non sono caricate;
- le icone SVG hanno `width`/`height` espliciti, così restano piccole anche senza CSS;
- fuori da Electron la pagina mostra "Anteprima: avvia l'app con `npm run dev`".

**Perché il drag-and-drop non funziona in anteprima:** per sapere il percorso di un file trascinato serve
il preload di Electron (`webUtils.getPathForFile`). Un browser normale, giustamente, non lo rivela.
> 💡 Lezione: un'interfaccia deve degradare con eleganza anche quando l'ambiente non è quello previsto.

---

## Passo 12 — Cambio di motore: da FFmpeg esterno a PyAV

**La richiesta:** "puoi usare una libreria Python diversa da FFmpeg, così è inclusa di default nel programma?"

### Cosa abbiamo scoperto prima di scrivere codice

Non esiste una libreria Python che legga MP4/MKV/AVI/WMV... **senza** FFmpeg: decodificare tutti quei formati
richiede FFmpeg (o un equivalente enorme). Le librerie famose (moviepy, pydub, ffmpeg-python) chiamano il
programma `ffmpeg`, quindi non risolvono il problema. **PyAV** invece contiene le librerie FFmpeg *dentro* il
pacchetto pip. Abbiamo verificato con una prova reale, prima di cambiare il progetto:
- `pip install av` → PyAV 19.0.2 con FFmpeg 8 e l'encoder `libmp3lame`;
- conversione di un video sintetico → MP3 a 192 kbps corretto;
- peso: circa +70 MB.

### Cosa è cambiato

| Prima | Dopo |
|---|---|
| Python lanciava `ffprobe` e `ffmpeg` come processi | Python usa PyAV nello stesso processo |
| binari da procurare a mano in `resources/ffmpeg/` | `pip install` e PyInstaller li includono da soli |
| avanzamento letto da `-progress pipe:1` | avanzamento da `frame.time` di ogni frame audio |
| annullamento = terminare FFmpeg | annullamento = uscire dal ciclo di conversione |
| `verify:binaries` | `verify:converter` (controlla anche la licenza) |
| test con FFmpeg finto | test con video veri generati da PyAV |

Cosa **non** è cambiato: il protocollo JSON Lines. Electron, Express e GUI non se ne sono accorti, a parte la
finestra Informazioni. È la prova che il contratto definito al Passo 2 era una buona idea.

### La sorpresa sulla licenza

FFmpeg dentro PyAV **dichiara** "LGPL version 3 or later", ma è collegato a **x264 e x265, che sono GPL**.
Abbiamo scritto `license-classifier.js`, che guarda anche le librerie incluse e conclude
**GPL-3.0-or-later**. La build e la finestra Informazioni lo mostrano, e la documentazione spiega le
conseguenze e l'alternativa (ricompilare PyAV con un FFmpeg solo LGPL).
> 💡 Lezione: non fidarti di un'etichetta. "LGPL" scritto in un campo non dice cosa contiene davvero il pacchetto.

### Due problemi trovati durante il cambio

1. **Un test che non finiva mai.** Un test aspettava "finché l'avanzamento è 0" senza scadenza; quando la
   conversione falliva subito restava bloccato all'infinito. Correzione: scadenza di 30 s e controllo dello stato `failed`.
2. **Un server lasciato aperto.** Quando un'asserzione falliva, il test di Express non chiudeva il server e il
   processo dei test non terminava. Correzione: chiusura garantita in `test.afterEach`.
> 💡 Lezione: un test deve fallire in fretta e pulire dietro di sé anche quando fallisce.

---

### La decisione: accettare la GPL, e farlo bene

Accettare la GPL non significa "scrivere GPL da qualche parte". Significa fornire **i testi integrali** e il
**sorgente corrispondente**, cioè esattamente il codice da cui sono stati compilati i binari che distribuiamo.
Ecco cosa abbiamo fatto, e perché:

1. **Risalire alla build esatta.** PyAV 19.0.2 → `ffmpeg-latest.json` → `pyav-ffmpeg 9.0.2-1` → `pkg.py`, con URL e
   SHA-256 di ogni sorgente. Abbiamo verificato che la configurazione di build coincida riga per riga con quella
   letta dal convertitore, e che le versioni nelle DLL coincidano (FFmpeg 9.0.2, x265 4.3...).
2. **Un manifesto versionato** (`third-party/pyav-19.0.2.json`) invece di un elenco scritto a mano negli avvisi.
3. **Uno script che verifica, non che si fida** (`npm run third-party`):
   - controlla che ogni libreria presente nel convertitore compilato sia nel manifesto;
   - scarica i sorgenti e ne verifica lo SHA-256;
   - estrae i testi di licenza **dai sorgenti originali**, invece di riscriverli;
   - include sorgenti e licenze nel pacchetto. Così non servono server da mantenere né offerte scritte valide 3 anni.
4. **Il packaging controlla tutto** (`prepare-resources.js`): stessa versione di PyAV, file integri, licenza ammessa.

Due sorprese, gestite senza scorciatoie:
- **L'hash di LAME non coincideva.** Invece di aggiornare l'hash e basta, abbiamo scoperto che il repository era stato
  rinominato. Poi abbiamo dimostrato che il contenuto è identico al commit del tag, confrontando l'hash git di
  ciascuno degli 82 file.
- **Il GitLab di VideoLAN rifiuta i client automatici.** Non abbiamo aggirato la protezione: lo script spiega come
  scaricare il file con il browser e ne verifica comunque l'hash.
> 💡 Lezione: un controllo d'integrità che fallisce è un'informazione, non un ostacolo da zittire.

---

## Passo 13 — Cosa NON è stato fatto (e perché lo diciamo)

| Elemento | Stato | Motivo |
|---|---|---|
| Installer NSIS, DMG, AppImage, deb | non generati | per Windows x64 tutti i controlli ora passano; manca solo eseguire `npm run make:win` e provarlo su un sistema pulito |
| Licenze e sorgenti per macOS/Linux/ARM | non verificati | il manifesto va confrontato con i wheel reali su quelle macchine |
| Build macOS e Linux | solo predisposte | servono quelle macchine (PyInstaller non cross-compila) |
| Firma e notarizzazione | non configurate | servono certificati reali |
| Prova su sistema pulito | non eseguita | dipende dagli installer |
| Drag-and-drop con un file reale | da provare a mano | richiede un'azione umana |

**Perché scriverlo:** dire chiaramente cosa manca permette a chi viene dopo di completarlo, invece di
scoprirlo in produzione.

---

## Riassunto delle regole che abbiamo seguito

1. **Verifica l'ambiente prima di promettere.**
2. **Separa i processi** quando le tecnologie o i rischi sono diversi.
3. **Definisci il contratto** (JSON Lines, codici di errore) prima di costruirci sopra.
4. **Il renderer non è fidato:** niente Node, niente percorsi, solo funzioni validate.
5. **Mai una shell** per avviare processi con dati dell'utente.
6. **Centralizza le differenze** (sviluppo/produzione, testi di errore).
7. **Fallisci presto e chiaramente:** meglio uno script che si ferma che un pacchetto rotto.
8. **Testa senza barare:** un test saltato si dichiara come tale.
9. **Ispeziona i risultati**, non fidarti solo del codice di uscita.
10. **Documenta cosa manca.**

## Cosa fare adesso

1. `npm run dev` e prova una conversione con il drag-and-drop: ora funziona subito.
2. `npm run verify:converter -- --built` e leggi la licenza riportata.
3. Decidi: accettare la GPL o ricompilare PyAV con FFmpeg solo LGPL ([LICENSE_COMPLIANCE.md](LICENSE_COMPLIANCE.md)).
4. Completa licenze e sorgenti, poi crea il primo installer: [PACKAGING.md](PACKAGING.md).
