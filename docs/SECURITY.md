# Sicurezza

## Modello delle minacce (in breve)

| Minaccia | Esempio | Contromisura |
|----------|---------|--------------|
| Contenuto malevolo nella GUI | nome di file con HTML/JS | solo `textContent`, CSP senza script inline, renderer in sandbox |
| Pagina compromessa che usa privilegi | XSS che chiama IPC | allowlist canali, validazione argomenti, nessun percorso dal renderer |
| Altri siti web nel browser dell'utente | pagina che fa `fetch('http://127.0.0.1:PORT/api/jobs')` | token, controllo `Origin`, controllo `Host` (DNS rebinding) |
| Altri dispositivi in rete | scansione delle porte | ascolto solo su `127.0.0.1` |
| Altri processi locali | programma che indovina la porta | token casuale a 256 bit, rigenerato a ogni avvio |
| Iniezione di comandi | nome file `a"; rm -rf ~".mp4` | `shell: false` / nessun `shell=True`, argomenti come lista |
| Cancellazione di file non nostri | ID job manipolato `../../` | ID UUID validati, `isInside()` prima di ogni `rm` |
| Binari sostituiti | convertitore o librerie modificati nel pacchetto | firma del codice (da configurare), SHA-256 in `build-info.json` |
| Fuga di dati | telemetria, log condivisi | nessuna rete, log sanitizzati (home → `~`, utente → `<utente>`) |

## Electron

Impostazioni della finestra (`src/main/main.js`):

```js
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  devTools: !app.isPackaged || debugEnabled
}
```

Restrizioni aggiuntive:
- `setWindowOpenHandler(() => ({ action: 'deny' }))`: blocca `window.open` e i link `target=_blank`;
- `will-navigate` / `will-redirect`: consentita solo la nostra origine;
- `will-attach-webview`: bloccato;
- `session.setPermissionRequestHandler`: tutti i permessi negati (camera, microfono, notifiche...);
- `session.webRequest.onBeforeRequest`: **qualsiasi** richiesta verso un'origine diversa da
  `http://127.0.0.1:<porta>` viene annullata. L'app non carica nulla da Internet;
- i link esterni (pagina FFmpeg, ecc.) si aprono nel browser di sistema **solo su clic** e solo da
  un'allowlist di chiavi (`EXTERNAL_LINKS` in `ipc-validation.js`): il renderer non può passare URL arbitrari;
- single-instance lock: impossibile avviare due server.

### Content Security Policy

Inviata come header HTTP da Express e ripetuta in `<meta>`:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'; object-src 'none'
```

Niente `unsafe-inline`, niente `unsafe-eval`: script e stili inline non vengono eseguiti.

## IPC

- 7 canali in allowlist (`IPC_CHANNELS`), ciascuno con un validatore dell'**intera** lista di argomenti.
- Mittente verificato: l'URL del frame deve avere la nostra origine e il frame deve essere quello principale.
- Il renderer non invia mai percorsi per la conversione: invia un `fileId` opaco.
  Unica eccezione controllata: il percorso di un file trascinato, ricavato **nel preload** da
  `webUtils.getPathForFile()` e poi verificato dal main (assoluto, esistente, file regolare, estensione ammessa, non vuoto).
- Il percorso di salvataggio arriva solo dal dialog nativo del main process.
- Le risposte non contengono mai stack trace: `{ ok: false, error: { code, message, hint } }`.

## API locale (Express)

1. `listen(0, '127.0.0.1')`: porta effimera scelta dal sistema, solo loopback.
2. **Host**: deve essere esattamente `127.0.0.1:<porta>`. Blocca il *DNS rebinding*, in cui un sito
   malevolo fa risolvere il proprio dominio a 127.0.0.1.
3. **Origin**: se presente, deve essere la nostra origine.
4. **Token**: `Authorization: Bearer <token>`; 32 byte casuali, confronto a tempo costante.
   Il renderer lo riceve via IPC e lo tiene **solo in una variabile JavaScript**: niente
   `localStorage`/`sessionStorage`/cookie. Il token non va mai nell'URL.
5. JSON limitato a 16 KB, campi in allowlist, ID validati come UUID.
6. Nessun directory listing (`express.static` non lo genera), `dotfiles: 'deny'`, nessun percorso fisico nelle risposte.
7. Il server viene chiuso (connessioni incluse) al termine dell'app.

## Processi figli

- Node.js: `spawn(command, args, { shell: false, windowsHide: true })`.
- Python: nessun processo esterno; la conversione avviene nel processo del convertitore tramite PyAV.
- I binari sono chiamati per **percorso assoluto**, mai cercati nel `PATH` (in produzione).
- `npm run check` segnala `shell: true`, `eval`, `innerHTML`, impostazioni Electron insicure, URL remoti nella GUI.

## Logging e privacy

- Log in `app.getPath('logs')` (Windows: `%APPDATA%\Video to MP3\logs`; macOS: `~/Library/Logs/Video to MP3`;
  Linux: `~/.config/Video to MP3/logs`), rotazione a 1 MB × 3 file.
- Ai livelli info/warning/error i log non contengono il nome dei file convertiti (solo dimensione ed
  estensione). I dettagli tecnici degli errori di decodifica, che possono citare il percorso del file, è registrato solo in
  modalità debug (`npm run dev:debug` o `VIDEO2MP3_DEBUG=1`). In ogni caso i percorsi vengono ripuliti
  (home → `~`, nome utente → `<utente>`).
- "Copia diagnostica" produce un testo già ripulito. Nessun invio automatico.

## Aggiornamenti automatici

Non presenti nella versione 1. Rischi e requisiti per aggiungerli: [PACKAGING.md](PACKAGING.md#aggiornamenti-automatici-non-implementati).

## Segnalazione di vulnerabilità

Indicare qui un contatto privato (e-mail dedicata) prima della distribuzione pubblica.
