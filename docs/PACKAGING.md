# Packaging e distribuzione

## Perché electron-builder e non Electron Forge

Il progetto chiedeva di preferire Electron Forge salvo motivazioni concrete. Le motivazioni:

| Requisito | electron-builder | Electron Forge |
|-----------|------------------|----------------|
| Installer **NSIS** Windows | nativo (`nsis`) | non ufficiale: Forge offre Squirrel.Windows, WiX (MSI), MSIX, ZIP |
| Versione **portable** Windows | nativa (`portable`) | non disponibile come maker ufficiale |
| **AppImage** | nativa | solo maker di terze parti |
| `.deb`, `.dmg` | nativi | nativi |
| Risorse per piattaforma | macro `${platform}-${arch}` in `extraResources` | richiede hook personalizzati |
| Firma e notarizzazione | integrate, configurabili da variabili d'ambiente | integrate |

Con Forge avremmo dovuto sostituire NSIS con Squirrel (installer a un clic, aggiornamenti propri, meno
controllo sulla cartella di installazione) e aggiungere maker non ufficiali per AppImage. electron-builder
copre tutti i formati richiesti con un solo strumento ufficiale e ben documentato.

## Cosa contiene un pacchetto

```
Video to MP3 (app installata)
├── Video to MP3[.exe]             eseguibile Electron (rinominato)
├── LICENSE.electron.txt, LICENSES.chromium.html
└── resources/
    ├── app.asar                   src/main + src/renderer + package.json
    ├── python-converter/<piattaforma>-<arch>/converter/   converter[.exe] + _internal/
    │                                (Python, PyAV, librerie FFmpeg e codec)
    ├── python-converter/<piattaforma>-<arch>/build-info.json   versioni, motore, licenza valutata
    ├── licenses/                  THIRD-PARTY-NOTICES.txt, APP-LICENSE.txt, npm-licenses.txt
    └── third-party/<piattaforma>-<arch>/   LICENSES.txt, SOURCES.md, source/ (sorgente corrispondente GPL, ~86 MB)
```

Gli eseguibili stanno **fuori** da `app.asar`: un sistema operativo non può avviare un programma
che si trova dentro un archivio.

## Matrice di build

PyInstaller **non è un cross-compiler**: produce un eseguibile per il sistema e l'architettura del
Python che lo esegue, usando il wheel PyAV (con le librerie FFmpeg native) di quella piattaforma.
Ogni riga va quindi eseguita su una macchina (fisica, virtuale o runner CI) di quel tipo.

| Target | Macchina di build | Comandi | Output | Stato |
|--------|-------------------|---------|--------|-------|
| win32-x64 | Windows 10/11 x64 | `npm run build:python` → `npm run make:win` | NSIS `.exe`, portable `.exe` | convertitore compilato e verificato; licenze e sorgenti pronti; installer non ancora generato |
| win32-arm64 | Windows 11 ARM64, Python ARM64 nativo | `npm run build:python` → `npm run make:win:arm64` | NSIS, portable | predisposto, da verificare (disponibilità del wheel PyAV `win_arm64`) |
| darwin-arm64 | Mac Apple Silicon, Python arm64 | `npm run build:python` → `npm run make:mac:arm64` | `.dmg` | predisposto |
| darwin-x64 | Mac Intel, o Apple Silicon con Python/Node x86_64 sotto Rosetta | `npm run build:python` → `npm run make:mac:x64` | `.dmg` | predisposto |
| linux-x64 | Linux x64 (glibc più vecchia supportata, es. Ubuntu 22.04) | `npm run build:python` → `npm run make:linux` | `.AppImage`, `.deb` | predisposto |
| linux-arm64 | Linux ARM64 | `npm run build:python` → `npm run make:linux:arm64` | `.AppImage`, `.deb` | predisposto |

`npm run make:mac` costruisce entrambi i DMG (arm64 e x64): richiede che **entrambi** i convertitori
siano presenti (quindi due build PyInstaller su due ambienti, poi riuniti sulla macchina di packaging).

### Universal binary macOS (facoltativo)

Un'app "universal" contiene codice arm64 e x64 nello stesso bundle. Richiede:
1. convertitore PyInstaller universal (`target_arch='universal2'` nello spec, con un Python universal2
   e tutte le dipendenze universal) oppure due convertitori uniti con `lipo` (non banale con onedir);
2. PyAV in versione universal2 (i wheel PyAV per macOS sono per singola architettura: andrebbe compilato);
3. electron-builder `arch: ['universal']` e una cartella `resources/python-converter/darwin-universal/` con
   un piccolo adattamento del resolver.
Per la prima versione due DMG separati sono più semplici e più piccoli.

## Procedura di rilascio (per ogni piattaforma)

1. `npm ci`
2. `npm run build:python` (o gli script `scripts/build-python-*.{ps1,sh}`, che installano anche PyAV).
3. `npm run verify:converter -- --built` — controllare versioni e **licenza** delle librerie FFmpeg incluse.
4. `npm run third-party` — testi integrali delle licenze e sorgente corrispondente (GPL) del convertitore,
   verificati con SHA-256 e inclusi nel pacchetto ([LICENSE_COMPLIANCE.md](LICENSE_COMPLIANCE.md)).
5. Verificare `THIRD-PARTY-NOTICES.txt`; `npm run licenses:npm`.
6. `npm test` e `npm run check`.
7. `npm run make:<os>` — `prepare-resources.js` blocca il packaging se manca qualcosa.
8. Installare il pacchetto su un **sistema pulito** (VM senza Python, Node.js o FFmpeg) e convertire un file reale.
9. Firmare/notarizzare ([CODE_SIGNING.md](CODE_SIGNING.md)) e ripetere il punto 8.

Gli installer si trovano in `out/make/`. `npm run package` crea solo la cartella non installabile
(`out/make/win-unpacked`, `mac-arm64`, `linux-unpacked`), utile per provare il pacchetto senza installarlo.

## PyInstaller: onedir e onefile

| | onedir (predefinito) | onefile (`npm run build:python -- --onefile`) |
|---|---|---|
| struttura | cartella con eseguibile + `_internal/` | un solo file |
| avvio | immediato | estrae tutto in una cartella temporanea a ogni avvio (più lento) |
| diagnosi | si vede cosa è incluso | contenuto nascosto |
| antivirus | meno falsi positivi | più falsi positivi (comportamento "da dropper") |
| firma macOS | ogni file firmabile normalmente | i file estratti a runtime complicano firma e notarizzazione |
| pulizia | nessun residuo | in caso di crash restano cartelle `_MEIxxxx` nel temp |

Dentro un pacchetto Electron il vantaggio "un solo file" di onefile è irrilevante: per questo onedir.

### Console su Windows

L'eseguibile è un'applicazione *console*, perché così stdin/stdout/stderr funzionano in modo affidabile
con le pipe. Electron lo avvia con `windowsHide: true`, quindi **nessuna finestra compare**.
Per il debug: `VIDEO2MP3_SHOW_CONVERTER_CONSOLE=1` (mostra la console) e `npm run build:python:debug`
(bootloader PyInstaller verboso).

## Aggiornamenti automatici (non implementati)

La versione 1 non si aggiorna da sola. Se in futuro si volesse aggiungerli:
- **Dove:** `electron-updater` (stesso ecosistema di electron-builder) inizializzato in `main.js` dopo `start()`,
  con un canale `publish` in `electron-builder.config.js`.
- **Rischi:** un canale di aggiornamento compromesso permette di installare codice arbitrario su tutti i client.
- **Requisiti:** pacchetti firmati (su macOS l'aggiornamento richiede firma e notarizzazione), verifica della
  firma/checksum prima dell'installazione, server HTTPS attendibile, possibilità di rollback.
- **Coordinamento:** Electron, convertitore Python e PyAV vanno aggiornati e testati **insieme**
  (il protocollo JSON Lines ha un `protocol` version proprio per rilevare incompatibilità).
- Va aggiornata anche la CSP/allowlist di rete, oggi intenzionalmente chiusa.

## CI futura (facoltativa)

Lo sviluppo e il packaging sono pensati per macchine locali. Una CI con runner Windows, macOS (arm64 e x64)
e Linux potrebbe eseguire la matrice: checkout → `npm ci` → `pip install -r src/python/requirements-build.txt`
(eventualmente da un mirror interno) → `npm test` → `npm run build:python` → `npm run make:<os>` → artefatti.
I certificati di firma andrebbero forniti come segreti della CI, mai nel repository.

## Stato di verifica

| Elemento | Stato |
|----------|-------|
| Convertitore PyInstaller win32-x64 | compilato con PyAV 19.0.2 e verificato su questa macchina: `--version`, conversioni reali e annullamento nei test di integrazione |
| Convertitore per altre piattaforme | non compilato (richiede le rispettive macchine) |
| Configurazione electron-builder (Windows) | validata con un pacchetto `--dir` di sola prova (poi eliminato): struttura `resources/` corretta, app avviata in modalità production, convertitore compilato trovato |
| Motore multimediale | PyAV incluso nel convertitore: nessun binario FFmpeg esterno necessario |
| Installer (NSIS, portable, DMG, AppImage, deb) | **non generati** |
| Avvio su sistema pulito | non verificato |
| Firma e notarizzazione | non configurate |
| Licenze (win32-x64) | convertitore distribuito sotto **GPL-3.0-or-later**: `npm run third-party` eseguito, 21 componenti verificati con SHA-256, testi integrali e sorgente corrispondente inclusi; `prepare-resources` superato |
| Licenze (altre piattaforme) | manifesto non ancora verificato: `npm run third-party` si ferma finché la piattaforma non viene verificata |

**L'applicazione non è distribuibile** finché tutte le righe non sono verificate.
