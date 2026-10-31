# Conformità alle licenze

> **Questa documentazione non costituisce consulenza legale. Prima della distribuzione pubblica o commerciale,
> verificare licenze, codec, brevetti e obblighi applicabili.**

> Nota per gli utenti (mostrata anche nell'app): **Converti esclusivamente contenuti di tua proprietà o per i quali
> possiedi i diritti e le autorizzazioni necessarie.**

## Componenti e licenze

| Componente | Licenza | Obblighi principali |
|------------|---------|---------------------|
| Codice di questo progetto | MIT (`LICENSE`) | mantenere l'avviso di copyright |
| Electron | MIT | avviso di licenza (incluso da electron-builder) |
| Chromium | BSD e molte altre | `LICENSES.chromium.html` incluso nel pacchetto |
| Node.js | MIT (+ componenti di terze parti) | incluso in Electron |
| Express e dipendenze | MIT (verificare con `npm run licenses:npm`) | avvisi di licenza |
| Python (nel convertitore) | PSF-2.0 (+ OpenSSL, libffi, zlib...) | avvisi di licenza |
| PyInstaller bootloader | GPL-2.0 con eccezione per il bootloader | nessun obbligo sul nostro codice grazie all'eccezione |
| PyAV | BSD-3-Clause | avviso di licenza |
| **Librerie FFmpeg incluse in PyAV** | **da trattare come GPL-3.0-or-later** (vedi sotto) | testo GPL, sorgente corrispondente |
| LAME, dav1d, Opus, libvpx, ... | varie (LGPL/BSD/MIT) | elencate in `THIRD-PARTY-NOTICES.txt` |

## Il punto critico: FFmpeg dentro PyAV

### Cosa dice la build

`npm run verify:converter` mostra:

```
licenza dichiarata da FFmpeg: LGPL version 3 or later
licenza valutata: GPL-3.0-or-later
[AVVISO] ... non tiene conto delle librerie GPL incluse: libx264, libx265.
```

FFmpeg calcola la stringa di licenza solo dai flag `--enable-gpl`, `--enable-version3`, `--enable-nonfree`.
Il wheel di PyAV 19.0.2 è compilato con `--enable-version3` (quindi "LGPLv3") **ma anche** con
`--enable-libx264 --enable-libx265`: x264 e x265 sono distribuiti con licenza **GPL-2.0-or-later**, e la loro
DLL/libreria è collegata a libavcodec. La combinazione che distribuiamo va quindi trattata come
**GPL-3.0-or-later** (LGPLv3 + GPLv2-or-later → GPLv3).

`src/main/license-classifier.js` applica proprio questa regola: oltre ai flag di FFmpeg controlla le
librerie esterne GPL e quelle nonfree. Le build `NONFREE` vengono rifiutate da `build-python.js` e
`prepare-resources.js`.

## Decisione presa: il convertitore è distribuito sotto GPL-3.0-or-later

Si usano i wheel ufficiali di PyAV così come sono e si accettano gli obblighi della GPL per il
**convertitore**. L'app Electron resta MIT. Ecco come ciascun obbligo è soddisfatto, in modo automatico e verificabile.

| Obbligo | Come è soddisfatto |
|---------|--------------------|
| Testo integrale delle licenze | `resources/third-party/<piattaforma>-<arch>/LICENSES.txt`, composto dai file **originali** (COPYING, LICENSE...) estratti dagli archivi dei sorgenti: GPLv2, GPLv3, LGPLv2.1, LGPLv3 di FFmpeg, LGPL di LAME, GPL di x264/x265, BSD/MIT dei codec, eccezione GCC, PSF di Python, licenza di PyInstaller |
| Sorgente corrispondente (GPL-3.0 §6a) | `resources/third-party/<...>/source/`: gli archivi **esatti** usati per compilare le librerie (stessi URL e SHA-256 registrati da `pyav-ffmpeg`), le patch e gli script di build (`pyav-ffmpeg`, `PyAV`) e il sorgente del convertitore (`convert.py`, `converter.spec`, requisiti, script di build). **È incluso nel pacchetto**, accanto all'eseguibile: niente server da mantenere né offerte scritte da onorare per 3 anni |
| Istruzioni per ricostruire | `SOURCES.md` nella stessa cartella |
| Informare l'utente | finestra **Licenze** → "Convertitore" e "Sorgente corrispondente"; nota GPL nella finestra **Informazioni**; `THIRD-PARTY-NOTICES.txt` |
| Licenza compatibile per il nostro codice del convertitore | `src/python/` è MIT, compatibile con la GPL; nel pacchetto sorgente è incluso anche `LICENSE` |
| Nessuna build nonfree | `build-python.js` e `prepare-resources.js` rifiutano `NONFREE` |
| Corrispondenza esatta fra binari e sorgenti | `prepare-third-party.js` censisce le librerie **realmente presenti** nel convertitore compilato e si ferma se una non è nel manifesto; `prepare-resources.js` verifica che i sorgenti siano stati generati per **la stessa versione** di PyAV e che ogni file sia integro (SHA-256) |

Il marchio FFmpeg non va usato in modo da suggerire un'approvazione del progetto FFmpeg.

### Il manifesto dei componenti

[`third-party/pyav-19.0.2.json`](../third-party/pyav-19.0.2.json) elenca, per la versione di PyAV usata, ogni
componente con URL del sorgente, SHA-256, licenza e piattaforme. Origine dei dati:

- `PyAV v19.0.2` → `scripts/ffmpeg-latest.json` indica la build `pyav-ffmpeg 9.0.2-1`, usata dal workflow dei wheel;
- `pyav-ffmpeg 9.0.2-1` → `scripts/pkg.py` (URL e SHA-256 di ogni sorgente) e `scripts/build-ffmpeg.py`
  (configurazione: coincide riga per riga con quella letta dal convertitore);
- versioni confermate dalle informazioni delle DLL (FFmpeg 9.0.2, dav1d 1.5.4, x265 4.3, libvpl 2.16, libiconv 1.19).

Due casi particolari, documentati nel manifesto:
- **LAME**: il repository `lamer` è stato rinominato `bwlame`, quindi GitHub genera l'archivio con un altro nome di
  cartella e un altro hash. Verificato che il tag punta allo stesso commit (precedente alla build) e che tutti gli
  82 file sono identici al commit (hash git dei singoli file).
- **DLL MinGW** (Windows): libiconv (LGPL, sorgente incluso); zlib, winpthreads e runtime GCC hanno licenze che non
  richiedono il sorgente: è incluso il testo della licenza.

### Generare licenze e sorgenti

```bash
npm run third-party
```

Esegue in ordine: censimento delle librerie del convertitore → download e verifica SHA-256 di ogni sorgente
(cache in `build/third-party/cache/`) → estrazione dei testi di licenza → `LICENSES.txt`, `SOURCES.md`,
`source/`, `manifest.json`. Su Windows x64 produce circa 86 MB di sorgenti, inclusi nell'installer.

Se un server rifiuta il download automatico (succede con il GitLab di VideoLAN, che protegge i download da
client automatici), lo script indica l'URL e il nome con cui salvare il file in `build/third-party/cache/`:
lo scarichi con il browser e lo script ne verifica comunque lo SHA-256.

### Piattaforme verificate

Il manifesto contiene `verifiedPlatforms`. Oggi solo **win32-x64** è verificata. Per le altre piattaforme lo
script si ferma: su quella macchina bisogna compilare il convertitore, eseguire `npm run third-party`, risolvere
eventuali "librerie non censite" (es. librerie di sistema incluse dai wheel Linux/macOS) e solo allora aggiungere
la piattaforma all'elenco.

### Alternativa se servisse evitare la GPL

Ricompilare PyAV da sorgente contro un FFmpeg configurato **solo LGPL** (senza x264/x265, che non servono
per creare MP3: l'app non codifica video), ad esempio con:

```
./configure --enable-shared --disable-gpl --disable-nonfree --enable-libmp3lame --disable-programs --disable-doc
pip install av --no-binary av   # con PKG_CONFIG_PATH che punta a questo FFmpeg
```

È più lavoro (una build per piattaforma), ma riduce gli obblighi a quelli LGPL. Dopo la ricompilazione,
`npm run verify:converter` deve riportare `LGPL-3.0-or-later` o `LGPL-2.1-or-later`.

## Brevetti e codec

- I brevetti principali su MP3 sono scaduti (2017) nella maggior parte dei paesi.
- La decodifica di alcuni formati audio in ingresso (es. AAC, AC-3) può essere soggetta a brevetti in alcune
  giurisdizioni. Verificare la situazione nei paesi di distribuzione, in particolare per uso commerciale.

## Procedura prima di ogni distribuzione

- [x] decisione esplicita: convertitore distribuito sotto **GPL-3.0-or-later** con i wheel ufficiali di PyAV
- [ ] `npm run verify:converter -- --built` su ogni piattaforma; nessuna build NONFREE
- [ ] `npm run third-party` su ogni piattaforma (piattaforma presente in `verifiedPlatforms`)
- [ ] `THIRD-PARTY-NOTICES.txt`: elenco coerente con il manifesto per **ogni** piattaforma distribuita
- [ ] `npm run licenses:npm` eseguito; nessuna licenza "SCONOSCIUTA"
- [ ] finestra Informazioni e Licenze: versione, licenza e sorgente visibili nell'app installata
- [ ] revisione legale per distribuzioni pubbliche o commerciali

`npm run make:*` verifica automaticamente i punti tecnici (convertitore, licenza, sorgenti integri e della
stessa versione) e si ferma se qualcosa manca.

## Aggiornare PyAV mantenendo gli obblighi

Le librerie incluse (e quindi licenze e sorgenti) cambiano da una versione all'altra. Per una nuova versione:

1. aggiornare `src/python/requirements.txt` e reinstallare nel `.venv`;
2. leggere nel repository PyAV, al tag della nuova versione, `scripts/ffmpeg-latest.json` → release di `pyav-ffmpeg`;
3. in quella release di `pyav-ffmpeg`, leggere `scripts/pkg.py` (URL e SHA-256) e `scripts/build-ffmpeg.py`;
4. creare `third-party/pyav-<nuova versione>.json` partendo dal precedente;
5. `npm run build:python` e `npm run third-party`: il censimento delle librerie segnala ciò che manca;
6. aggiornare `THIRD-PARTY-NOTICES.txt` e ripetere la checklist.
