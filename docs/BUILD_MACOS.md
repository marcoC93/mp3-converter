# Build su macOS

## Prerequisiti

- macOS 12 o successivo; Xcode Command Line Tools (`xcode-select --install`)
- Node.js ≥ 22.12 e Python ≥ 3.10 **dell'architettura del target**
  - arm64: Python e Node nativi Apple Silicon
  - x64: su Mac Intel, oppure su Apple Silicon con un terminale Rosetta (`arch -x86_64 zsh`) e Python/Node x86_64
- Per la distribuzione: account Apple Developer e certificato "Developer ID Application" ([CODE_SIGNING.md](CODE_SIGNING.md))

## Passi (esempio arm64)

```bash
npm ci
```

Non serve procurare FFmpeg: lo script installa PyAV (con le librerie FFmpeg incluse) e PyInstaller
nel `.venv` e compila il convertitore ([MEDIA_ENGINE.md](MEDIA_ENGINE.md)).

```bash
bash scripts/build-python-macos.sh
```

```bash
npm run verify:converter -- --built
```

Controlla anche la licenza riportata: il wheel PyAV per macOS può includere librerie diverse da quello Windows.

```bash
npm run third-party
```

Licenze integrali e sorgente corrispondente (GPL) del convertitore. Al primo uso su questa piattaforma lo script
si ferma finché il manifesto non viene verificato: vedi [LICENSE_COMPLIANCE.md](LICENSE_COMPLIANCE.md#piattaforme-verificate).

```bash
npm test
```

```bash
npm run make:mac:arm64
```

Output: `out/make/Video to MP3-1.0.0-mac-arm64-UNSIGNED-DEV.dmg` e `out/make/mac-arm64/Video to MP3.app`.

## Entrambe le architetture

`npm run make:mac` produce DMG arm64 e x64 e richiede:
- `resources/python-converter/darwin-arm64/` e `resources/python-converter/darwin-x64/`
  (compilati rispettivamente con Python arm64 e x86_64, ciascuno con il proprio wheel PyAV).

Su Apple Silicon la build x64 si può fare in un terminale Rosetta (`arch -x86_64 zsh`) con Python e Node x86_64.

## Build locale non firmata

`identity: null` nella configurazione: l'app **non è firmata**. Al primo avvio Gatekeeper la blocca;
per provarla localmente: clic destro sull'app → Apri → Apri. Non distribuire build non firmate.
Firma, hardened runtime e notarizzazione: [CODE_SIGNING.md](CODE_SIGNING.md).

## Problemi frequenti

| Sintomo | Causa | Soluzione |
|---------|-------|-----------|
| "converter non può essere aperto perché lo sviluppatore non può essere verificato" | quarantena (cartella copiata da un download) | `xattr -dr com.apple.quarantine resources/python-converter` |
| `BINARY_WRONG_ARCH` | convertitore Intel in cartella arm64 o viceversa | `file resources/python-converter/darwin-arm64/converter/converter` per verificare |
| Notarizzazione rifiutata per binari non firmati | converter o librerie PyAV (`.dylib`, `.so`) non firmati con hardened runtime | electron-builder firma i Mach-O nel bundle; verifica con `codesign -dv --verbose=4` |
