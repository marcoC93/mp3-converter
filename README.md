# Video to MP3 — applicazione desktop

Applicazione desktop **offline** per estrarre l'audio dai video e salvarlo in MP3.
Funziona su Windows, macOS e Linux. L'utente finale installa un pacchetto e lo apre
con un doppio clic: non deve installare Python, Node.js o FFmpeg, né usare il terminale.

> Converti esclusivamente contenuti di tua proprietà o per i quali possiedi i diritti e le autorizzazioni necessarie.

> Questa documentazione non costituisce consulenza legale. Prima della distribuzione pubblica o commerciale,
> verificare licenze, codec, brevetti e obblighi applicabili.

## Come è fatta

```
┌──────────────────────── Applicazione installata ─────────────────────────┐
│  Electron main process (Node.js)                                         │
│   ├─ Express su 127.0.0.1:<porta casuale>  ◄── fetch + token ── GUI      │
│   ├─ IPC sicuro (dialog, salvataggio)     ◄── preload ───────── (sandbox)│
│   └─ processo figlio: converter (Python compilato con PyInstaller)       │
│                         └─ include PyAV (librerie FFmpeg + libmp3lame)   │
└──────────────────────────────────────────────────────────────────────────┘
```

Dettagli: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Guida didattica: [docs/JUNIOR_GUIDE.md](docs/JUNIOR_GUIDE.md).

## Non esiste un installer unico per tutti i sistemi

Ogni pacchetto contiene **binari nativi** (Electron, convertitore PyInstaller con le librerie FFmpeg di PyAV) compilati per
**un sistema operativo e un'architettura**. Si producono quindi pacchetti separati:

| Sistema | Pacchetti | Architetture |
|---------|-----------|--------------|
| Windows | installer NSIS `.exe`, versione portable `.exe` | x64 (ARM64 predisposto) |
| macOS | `.app` dentro `.dmg` | arm64 (Apple Silicon), x64 (Intel) |
| Linux | `.AppImage`, `.deb` | x64 (arm64 predisposto) |

Ogni pacchetto va costruito **sul sistema di destinazione** (PyInstaller non è un cross-compiler):
vedi [docs/PACKAGING.md](docs/PACKAGING.md).

## Requisiti per lo sviluppo

- Node.js ≥ 22.12 (testato con 26.6) e npm
- Python ≥ 3.10 (testato con 3.14)

Non serve installare FFmpeg: il motore di conversione è **PyAV**, una libreria Python che contiene già
le librerie FFmpeg e l'encoder MP3 ([docs/MEDIA_ENGINE.md](docs/MEDIA_ENGINE.md)).

## Avvio rapido (sviluppo)

```bash
npm install
```

Ambiente Python con PyAV e PyInstaller (Windows):

```bash
python -m venv .venv
```

```bash
.venv\Scripts\python -m pip install -r src/python/requirements-build.txt
```

Su macOS/Linux: `python3 -m venv .venv` e `.venv/bin/python3 -m pip install -r src/python/requirements-build.txt`.

```bash
npm run dev
```

In sviluppo il convertitore è lo script `src/python/convert.py`, eseguito con il Python di `.venv`
(se presente) o con quello di sistema. Se PyAV manca, l'app si apre comunque e mostra
un avviso "Componenti mancanti".

> Su Windows, se PowerShell blocca `npm` ("esecuzione di script disabilitata"), usa `npm.cmd run dev`
> oppure il Prompt dei comandi.

## Comandi

| Comando | Cosa fa |
|---------|---------|
| `npm run dev` | avvia l'app in sviluppo |
| `npm run dev:debug` | come sopra, con log di livello debug |
| `npm run smoke` | avvia Electron, verifica GUI e sicurezza del renderer, esce (codice 0 = ok) |
| `npm test` | tutti i test: Node.js (unit + integrazione) e Python |
| `npm run test:unit` / `test:integration` / `test:python` | singole suite |
| `npm run check` | sintassi JS/Python/JSON, regole di sicurezza, stato delle risorse |
| `npm run verify:converter` | verifica convertitore e motore PyAV (avvio, libmp3lame, versioni FFmpeg, licenza); `-- --built` per l'eseguibile |
| `npm run build:python` | compila il convertitore con PyInstaller per la piattaforma corrente |
| `npm run package` | crea l'app non installabile in `out/make/<os>-unpacked` |
| `npm run make` | crea gli installer per la piattaforma corrente |
| `npm run make:win` / `make:mac` / `make:linux` | installer per un sistema specifico (da eseguire su quel sistema) |
| `npm run third-party` | genera testi integrali delle licenze e sorgente corrispondente (GPL) del convertitore, inclusi nel pacchetto |
| `npm run licenses:npm` | elenca le dipendenze npm di produzione e le licenze |
| `npm run clean` | rimuove `build/` e `out/` |

Gli installer vengono scritti in **`out/make/`**. Le build non firmate hanno il suffisso `-UNSIGNED-DEV`.

## Struttura del progetto

```
├── package.json, electron-builder.config.js, LICENSE, THIRD-PARTY-NOTICES.txt
├── build-config/entitlements.mac.plist   entitlements per hardened runtime macOS
├── src/
│   ├── main/        main process: main.js, preload.js, express-server.js, job-manager.js,
│   │                process-manager.js, resource-resolver.js, ipc-handlers.js, ...
│   ├── renderer/    GUI: index.html, styles.css, app.js (JavaScript vanilla)
│   └── python/      convert.py, converter.spec (PyInstaller), requirements*.txt
├── resources/
│   ├── python-converter/<piattaforma>-<arch>/  output di PyInstaller (generato)
│   ├── icons/       icona sorgente
│   └── licenses/    licenze incluse nel pacchetto
├── scripts/         build, verifica del convertitore, packaging, check, pulizia
├── docs/            documentazione (italiano)
└── tests/           unit, integration, python, fixtures
```

## Documentazione

| Documento | Argomento |
|-----------|-----------|
| [PERCORSO_DEL_PROGETTO.md](docs/PERCORSO_DEL_PROGETTO.md) | **da leggere per primo**: cosa è stato fatto, passo per passo, e perché |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | componenti, flussi, protocollo JSON Lines, scelte e alternative |
| [JUNIOR_GUIDE.md](docs/JUNIOR_GUIDE.md) | concetti spiegati da zero e percorso di studio |
| [SECURITY.md](docs/SECURITY.md) | modello di sicurezza di Electron, IPC e API locale |
| [PACKAGING.md](docs/PACKAGING.md) | packaging, matrice di build, PyInstaller onedir/onefile, aggiornamenti |
| [BUILD_WINDOWS.md](docs/BUILD_WINDOWS.md), [BUILD_MACOS.md](docs/BUILD_MACOS.md), [BUILD_LINUX.md](docs/BUILD_LINUX.md) | procedure passo-passo |
| [CODE_SIGNING.md](docs/CODE_SIGNING.md) | firma, notarizzazione, SmartScreen, Gatekeeper |
| [MEDIA_ENGINE.md](docs/MEDIA_ENGINE.md) | motore multimediale PyAV: perché, come funziona, aggiornamenti |
| [LICENSE_COMPLIANCE.md](docs/LICENSE_COMPLIANCE.md) | obblighi di licenza e checklist di distribuzione |
| [AUDIO_QUALITY.md](docs/AUDIO_QUALITY.md) | bitrate, CBR/VBR, scelte di qualità |
| [TESTING.md](docs/TESTING.md) | test, file sintetici, test manuali |
| [ERRORS.md](docs/ERRORS.md) | codici di errore e risoluzione dei problemi |

## Stato attuale

Vedi la sezione "Stato di verifica" in [docs/PACKAGING.md](docs/PACKAGING.md#stato-di-verifica):
l'applicazione **non è da considerarsi distribuibile** finché non sono verificati
licenze (il convertitore è distribuito sotto GPL-3.0: licenze e sorgenti pronti per win32-x64), installer, avvio su sistema pulito e, dove previsto, firma.
