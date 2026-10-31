# Firma del codice e notarizzazione

Nessun certificato è incluso nel progetto. **Non inserire mai certificati, chiavi o password nel repository**
(il `.gitignore` esclude `*.p12`, `*.pfx`, `*.key`, `.env`...). Le build locali non firmate hanno il suffisso
`-UNSIGNED-DEV` nel nome e la finestra Informazioni indica "sviluppo (non firmata)" quando l'app non è pacchettizzata.

La firma si attiva con `VIDEO2MP3_SIGN=1` più le variabili specifiche di ogni piattaforma, lette da
electron-builder dall'ambiente.

## Windows

**Cos'è:** una firma Authenticode lega l'eseguibile all'identità del publisher (certificato emesso da una CA).

**SmartScreen:** un installer non firmato mostra "Windows ha protetto il PC" e richiede "Ulteriori informazioni →
Esegui comunque". Con un certificato OV la reputazione si costruisce con il numero di download; con un
certificato EV o con servizi di firma cloud (es. Azure Trusted Signing) l'avviso scompare prima.

**Cosa firmare:** l'installer NSIS, l'eseguibile dell'app, `converter.exe` e le DLL di PyAV/FFmpeg in `_internal\`
(electron-builder firma gli eseguibili dell'app e dell'installer; verificare con `signtool verify /pa /v`
che anche i binari in `resources\` siano firmati, altrimenti firmarli prima del packaging).

**Configurazione:**
```powershell
$env:VIDEO2MP3_SIGN = "1"
$env:CSC_LINK = "C:\percorso\sicuro\certificato.pfx"   # oppure base64, fuori dal repository
$env:CSC_KEY_PASSWORD = "<da un gestore di segreti>"
npm run make:win
```
I certificati moderni spesso risiedono su token hardware o HSM: in quel caso usare un `sign` personalizzato
di electron-builder che invoca `signtool` con il provider del token.

**Gestione sicura:** certificato su HSM/token o in un gestore di segreti; accesso limitato; password mai nei log;
revoca immediata in caso di compromissione; timestamp sempre attivo (la firma resta valida dopo la scadenza del certificato).

## macOS

**Apple Developer ID:** certificato "Developer ID Application" ottenuto con l'Apple Developer Program.

**Hardened runtime:** modalità di esecuzione con protezioni aggiuntive, obbligatoria per la notarizzazione.
Le eccezioni necessarie sono in `build-config/entitlements.mac.plist` (JIT di V8, librerie del convertitore).

**Notarizzazione:** l'app firmata viene inviata ad Apple, che la analizza e rilascia un "ticket" poi
"pinzato" (stapled) all'app. **Gatekeeper** verifica firma e ticket al primo avvio.

**Tutti i binari** nel bundle (Electron, `converter` e le sue librerie in `_internal/`, incluse le `.dylib`/`.so` di PyAV e FFmpeg)
devono essere firmati con hardened runtime e timestamp, altrimenti la notarizzazione fallisce.

**Configurazione:**
```bash
export VIDEO2MP3_SIGN=1
export CSC_NAME="Developer ID Application: Nome Azienda (TEAMID)"   # certificato nel portachiavi
export APPLE_ID="sviluppatore@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="<password specifica per app>"
export APPLE_TEAM_ID="TEAMID"
npm run make:mac
```
Verifiche:
```bash
codesign --verify --deep --strict --verbose=2 "out/make/mac-arm64/Video to MP3.app"
```
```bash
spctl --assess --type execute --verbose "out/make/mac-arm64/Video to MP3.app"
```

**Build locale di test vs distribuzione:** in locale si usa `identity: null` (nessuna firma) e si apre l'app con
clic destro → Apri. Per la distribuzione pubblica firma e notarizzazione sono indispensabili.

## Linux

- **Permessi:** l'AppImage deve essere eseguibile (`chmod +x`); i binari interni ricevono i permessi in
  `prepare-resources.js`.
- **AppImage:** può contenere una firma GPG incorporata (`appimagetool --sign`), raramente verificata dagli utenti;
  più pratico pubblicare `SHA256SUMS` firmato con GPG.
- **.deb:** la firma avviene a livello di **repository APT** (file `Release` firmato con GPG); i singoli `.deb`
  scaricati a mano normalmente non sono verificati.
- **Differenze fra distribuzioni:** Debian/Ubuntu usano `.deb`; Fedora/openSUSE `.rpm` (target aggiungibile);
  l'AppImage funziona sulla maggior parte delle distribuzioni con glibc compatibile.

## Checklist

- [ ] certificati fuori dal repository, in un gestore di segreti
- [ ] tutti gli eseguibili firmati (app, installer, converter e librerie PyAV/FFmpeg)
- [ ] timestamp sulle firme
- [ ] macOS: notarizzazione riuscita e ticket pinzato
- [ ] verifica su sistema pulito senza avvisi di sicurezza inattesi
