# resources/licenses

File di licenza copiati nel pacchetto (cartella `resources/licenses/` dell'app installata)
e mostrati nella finestra **Licenze** della GUI.

| File | Contenuto | Chi lo aggiorna |
|------|-----------|-----------------|
| `THIRD-PARTY-NOTICES.txt` | avvisi di terze parti (riepilogo) | copiato automaticamente dalla radice da `prepare-resources.js` |
| `APP-LICENSE.txt` | licenza del codice di questo progetto (MIT) | copiato automaticamente da `LICENSE` |
| `npm-licenses.txt` | dipendenze npm di produzione e licenze | `npm run licenses:npm` |

I **testi integrali** delle licenze del convertitore (PyAV, FFmpeg, codec) e il **sorgente
corrispondente** richiesto dalla GPL non stanno qui ma in `resources/third-party/<piattaforma>-<arch>/`,
generati da `npm run third-party` a partire da `third-party/pyav-<versione>.json`.
Procedura: [docs/LICENSE_COMPLIANCE.md](../../docs/LICENSE_COMPLIANCE.md).
