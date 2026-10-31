# Icone dell'applicazione

`icon.svg` è la sorgente. electron-builder cerca in questa cartella (`buildResources`):

| File | Piattaforma | Requisiti |
|------|-------------|-----------|
| `icon.ico` | Windows | multi-risoluzione, almeno 256×256 |
| `icon.icns` | macOS | generato da un PNG 1024×1024 |
| `icon.png` | Linux | 512×512 o 1024×1024 |

Se i file mancano, electron-builder usa l'icona predefinita di Electron (accettabile per build di sviluppo).

Generazione (esempio, con strumenti installati localmente dallo sviluppatore):

```bash
# PNG 1024x1024 da SVG (Inkscape o rsvg-convert)
rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png
# ICO (ImageMagick)
magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
# ICNS (solo macOS)
mkdir icon.iconset && sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png && iconutil -c icns icon.iconset
```
