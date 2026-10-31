# Build su Windows

## Prerequisiti (solo sulla macchina di build)

- Windows 10/11 **x64** (per win32-x64) o **ARM64** (per win32-arm64)
- Node.js ≥ 22.12 (installer ufficiale da nodejs.org)
- Python ≥ 3.10 **della stessa architettura** del target (installer ufficiale da python.org;
  durante l'installazione abilita "Add python.exe to PATH" oppure usa il launcher `py`)
- Facoltativo: certificato di firma del codice (vedi [CODE_SIGNING.md](CODE_SIGNING.md))

Per abilitare i percorsi lunghi (> 260 caratteri) in Python e in altri strumenti:
Criteri di gruppo → Configurazione computer → Modelli amministrativi → Sistema → File system →
"Abilita percorsi lunghi Win32", oppure la chiave di registro `LongPathsEnabled = 1`.

## Passi

```powershell
npm ci
```

Non serve procurare FFmpeg: il motore (PyAV, con le librerie FFmpeg incluse) viene installato
con pip e inserito nell'eseguibile ([MEDIA_ENGINE.md](MEDIA_ENGINE.md)).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-python-windows.ps1
```

Lo script crea `.venv`, installa PyAV e PyInstaller (versioni fissate) e compila
`resources\python-converter\win32-x64\converter\converter.exe`, verificandone architettura, risposta a `--version`,
presenza di PyAV e `libmp3lame` e licenza delle librerie FFmpeg incluse.

```powershell
npm run verify:converter -- --built
```

```powershell
npm run third-party
```

Genera `resources\third-party\win32-x64\`: testi integrali delle licenze e sorgente corrispondente del convertitore
(GPL), inclusi automaticamente nell'installer.

```powershell
npm test
```

```powershell
npm run make:win
```

Output in `out\make\`:
- `Video to MP3-1.0.0-win-x64-UNSIGNED-DEV.exe` — installer NSIS (installazione per utente, nessun UAC);
- `Video to MP3-1.0.0-portable-x64-UNSIGNED-DEV.exe` — eseguibile portable (si estrae all'avvio);
- `win-unpacked\` — app non installata, utile per prove rapide.

## ARM64

1. Su un PC Windows ARM64 installa Node.js ARM64 e Python ARM64 (python.org fornisce l'installer "ARM64").
2. Verifica che esista un wheel PyAV per Windows ARM64 per la versione fissata (`pip install av` deve
   scaricare un wheel `win_arm64`, non compilare da sorgente); altrimenti serve compilare PyAV con un FFmpeg ARM64.
3. `npm run build:python` → `npm run make:win:arm64`.
Le build x64 funzionano anche su Windows ARM64 in emulazione, ma con prestazioni inferiori.

## Problemi frequenti

| Sintomo | Causa | Soluzione |
|---------|-------|-----------|
| "PyInstaller non è un cross-compiler" | target diverso dalla macchina | esegui sulla macchina giusta |
| "Python è arm64/64 bit, ma la build richiesta è x64" | Python dell'architettura sbagliata | installa il Python corretto o imposta `VIDEO2MP3_PYTHON` |
| Antivirus mette in quarantena `converter.exe` | falso positivo tipico di PyInstaller | firma il codice; segnala il falso positivo al produttore dell'antivirus |
| SmartScreen "Windows ha protetto il PC" | installer non firmato | normale per build di sviluppo; per la distribuzione firma il codice |
| `prepare-resources`: "licenze e sorgenti del convertitore mancanti" | `npm run third-party` non eseguito, o eseguito per un'altra versione di PyAV | `npm run third-party` (vedi [LICENSE_COMPLIANCE.md](LICENSE_COMPLIANCE.md)) |
| `npm run third-party`: "download non riuscito (406)" | il server (GitLab VideoLAN) rifiuta i client automatici | scarica il file con il browser nella cartella indicata; lo script ne verifica lo SHA-256 |
| "PyAV non installato in questo Python" | venv senza dipendenze | `.venv\Scripts\python -m pip install -r src\python\requirements-build.txt` |
| PowerShell: "esecuzione di script disabilitata" | execution policy `Restricted` | `npm.cmd run ...` oppure `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
