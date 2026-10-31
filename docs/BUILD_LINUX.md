# Build su Linux

## Prerequisiti

- Distribuzione x64 o arm64. Per la massima compatibilità compila sulla distribuzione **più vecchia**
  che vuoi supportare: l'eseguibile PyInstaller richiede una glibc uguale o più recente di quella di build
  (es. build su Ubuntu 22.04 → funziona su 22.04, 24.04, Debian 12...).
- Node.js ≥ 22.12, Python ≥ 3.10 con `venv` (`sudo apt install python3-venv`)
- Per creare il `.deb` su distribuzioni non Debian può servire `fakeroot`/`dpkg`; per l'AppImage nulla di particolare.

## Passi (linux-x64)

```bash
npm ci
```

Non serve procurare FFmpeg: lo script installa PyAV (i wheel `manylinux` contengono già le librerie FFmpeg,
senza dipendere da quelle di sistema) e PyInstaller, poi compila il convertitore ([MEDIA_ENGINE.md](MEDIA_ENGINE.md)).

```bash
bash scripts/build-python-linux.sh
```

```bash
npm run verify:converter -- --built
```

```bash
npm run third-party
```

Licenze integrali e sorgente corrispondente (GPL) del convertitore. Al primo uso su questa piattaforma lo script
si ferma finché il manifesto non viene verificato: vedi [LICENSE_COMPLIANCE.md](LICENSE_COMPLIANCE.md#piattaforme-verificate).

```bash
npm test
```

```bash
npm run make:linux
```

Output in `out/make/`: un file `.AppImage` e un file `.deb`, con il suffisso `-UNSIGNED-DEV`
(il nome dell'architettura può comparire come `x64`/`x86_64`/`amd64` a seconda del formato).

## Uso dei pacchetti

- **AppImage**: un solo file. L'utente deve renderlo eseguibile (`chmod +x` o Proprietà → Permessi).
  Su alcune distribuzioni recenti serve `libfuse2` (Ubuntu 24.04: `sudo apt install libfuse2t64`).
- **.deb**: `sudo apt install ./file.deb` (risolve le dipendenze di Electron). Crea voce di menu e disinstallazione.
- Altre famiglie (Fedora, Arch): usare l'AppImage, oppure aggiungere il target `rpm` in `electron-builder.config.js`.

## Sandbox di Chromium su Linux

Electron usa la sandbox del kernel (user namespaces). Su alcune distribuzioni (es. Ubuntu 24.04 con AppArmor)
gli user namespaces non privilegiati sono limitati e l'AppImage può non avviarsi. Soluzioni: installare il `.deb`
(electron-builder imposta correttamente `chrome-sandbox`), oppure un profilo AppArmor per l'app.
**Non** disabilitare la sandbox con `--no-sandbox` nelle build distribuite.

## Firma (facoltativa)

I pacchetti Linux di solito non sono firmati singolarmente; si firma il **repository** APT (chiave GPG)
da cui vengono distribuiti, oppure si pubblicano checksum SHA-256 firmati accanto agli AppImage.
Vedi [CODE_SIGNING.md](CODE_SIGNING.md).

## arm64

Su una macchina Linux arm64 (dove esiste il wheel PyAV `manylinux_aarch64`): `bash scripts/build-python-linux.sh`
e `npm run make:linux:arm64`.

## Problemi frequenti

| Sintomo | Causa | Soluzione |
|---------|-------|-----------|
| `BINARY_NOT_EXECUTABLE` | manca `chmod +x` o il disco dell'app è montato `noexec` | `chmod +x`, oppure installa l'app su un disco senza `noexec` (la cartella temporanea contiene solo dati, quindi `/tmp` noexec non è un problema) |
| `GLIBC_2.xx not found` all'avvio del convertitore | build su distribuzione troppo recente | ricompila su una distribuzione più vecchia |
| AppImage non parte | FUSE o sandbox | vedi sopra |
