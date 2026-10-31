# Test

## Comandi

```bash
npm test
```

| Comando | Contenuto | Requisiti |
|---------|-----------|-----------|
| `npm run test:unit` | validazione, JSON Lines, process/job manager, resolver, Express, IPC, salvataggio, logger, licenze | Node.js |
| `npm run test:integration` | Node.js ↔ `convert.py` reale con PyAV su video sintetici; eseguibile PyInstaller | Python con PyAV; opzionale convertitore compilato |
| `npm run test:python` | funzioni del convertitore ed end-to-end su video sintetici | Python con PyAV |
| `npm run smoke` | avvio reale di Electron: bridge, assenza di Node nel renderer, bridge drag-and-drop, GUI pronta, shutdown | display grafico |
| `npm run check` | sintassi, JSON, regole di sicurezza, stato risorse | — |
| `npm run verify:converter` | convertitore + motore PyAV, versioni, licenza | Python con PyAV |

I test che dipendono da componenti assenti (PyAV non installato, convertitore non compilato) vengono
**saltati e dichiarati**, mai considerati superati.

Su Windows, se PowerShell blocca `npm`, usa `npm.cmd test`.

## Copertura dei requisiti

| Requisito | Dove |
|-----------|------|
| validazione bitrate | `unit/validation.test.js`, `python/test_convert.py` |
| avanzamento reale | `python/test_convert.py` (ProgressTests), integrazione (avanzamento monotono, 100% finale) |
| dimensione proporzionale al bitrate (CBR) | integrazione (`bitrate diversi ...`) |
| ricampionamento (96 kHz mono → 48 kHz mono) | integrazione, `python/test_convert.py` |
| parsing JSON Lines / messaggi malformati | `unit/process-manager.test.js` |
| job ID | `unit/validation.test.js`, `unit/job-manager.test.js` |
| percorsi (Unicode, spazi, lunghi, contenimento) | `unit/validation.test.js`, `unit/save-result.test.js`, integrazione |
| selezione eseguibile per piattaforma/architettura | `unit/resource-resolver.test.js`, `unit/binary-inspector.test.js` |
| selezione eseguibile Python, dev/prod | `unit/resource-resolver.test.js` |
| motore (PyAV) assente, encoder MP3 assente | `unit/resource-resolver.test.js` (`applyEngineCheck`), `python/test_convert.py` |
| file senza audio, file danneggiato | integrazione, Python |
| annullamento | `unit/process-manager.test.js`, `unit/job-manager.test.js`, integrazione (script ed eseguibile PyInstaller), Python |
| cleanup | `unit/job-manager.test.js`, integrazione |
| graceful shutdown | `unit/job-manager.test.js`, integrazione, smoke |
| protezione API locale | `unit/express-server.test.js` |
| messaggi IPC non validi | `unit/ipc-validation.test.js` |
| salvataggio del risultato | `unit/save-result.test.js`, integrazione |
| job inesistente | `unit/job-manager.test.js`, `unit/express-server.test.js` |
| classificazione licenza (LGPL dichiarata + x264/x265 → GPL) | `unit/support-modules.test.js` |

## Video sintetici

Nessun file multimediale è versionato. `tests/fixtures/make_media.py` genera video con PyAV
(immagine fissa 160×120 + tono a 440 Hz) in cartelle temporanee:

```bash
python tests/fixtures/make_media.py prova.mp4 --seconds 10
```
```bash
python tests/fixtures/make_media.py muto.mp4 --no-audio
```
```bash
python tests/fixtures/make_media.py hires.mkv --rate 96000 --channels 1
```

Per una raccolta pronta per i test manuali (in `build/test-media/`, ignorata da git):

```bash
node scripts/generate-test-media.js
```

Il test di annullamento usa un file di 30 minuti di audio (generato in ~3 s): la conversione dura
qualche secondo, quanto basta per annullarla in modo affidabile.

## Test manuali (prima di ogni rilascio, su sistema pulito)

1. Installazione con doppio clic; avvio dal menu/Launchpad/desktop.
2. Drag-and-drop di un MP4: nome e dimensione visibili; trascinare un PDF: messaggio "non supportato".
3. Conversione a 128 e 320 kbps: avanzamento crescente, percentuale, tempo elaborato.
4. Annulla a metà: stato "annullata", nessun file residuo nella cartella temporanea.
5. Salva: dialog nativo, nome suggerito `<video>.mp3`, avviso se il file esiste, file riproducibile.
6. Video senza audio, file danneggiato (rinominare un .txt in .mp4): messaggi comprensibili.
7. Nome con spazi, accenti, caratteri cinesi/emoji; percorso molto lungo.
8. Chiusura durante la conversione: richiesta di conferma, chiusura pulita, nessun processo `converter` residuo
   (Gestione attività / Monitoraggio attività / `ps`).
9. Informazioni e Licenze: versioni del motore e licenza corrette.
10. Disconnessione dalla rete: tutto funziona uguale.
11. "Apri cartella log" e "Copia diagnostica": il testo non contiene il nome utente.
