# Motore multimediale: PyAV

## In breve

La conversione è fatta **dentro il convertitore Python** con la libreria [PyAV](https://github.com/PyAV-Org/PyAV)
(pacchetto `av`). PyAV contiene già, compilate al suo interno, le librerie di FFmpeg (libavformat,
libavcodec, libswresample...) con l'encoder MP3 **libmp3lame**.

Conseguenze pratiche:
- **nessun binario `ffmpeg`/`ffprobe` da procurare**: PyAV si installa con `pip` ed entra
  automaticamente nell'eseguibile PyInstaller;
- l'utente finale non installa nulla: tutto è dentro il pacchetto dell'app;
- per lo sviluppatore il setup è `pip install -r src/python/requirements-build.txt`.

## Perché PyAV (e non un'altra libreria)

Domanda frequente: *esiste una libreria Python che converta video in MP3 senza FFmpeg?*
In pratica **no**: leggere MP4, MKV, AVI, WMV, FLV... e i loro codec audio (AAC, AC-3, Opus, WMA...)
richiede un insieme enorme di decoder, e l'unico progetto libero completo è FFmpeg.
Le alternative si dividono così:

| Libreria | Contiene FFmpeg? | Note |
|----------|------------------|------|
| **PyAV** (scelta) | sì, come librerie nel wheel | API diretta, avanzamento reale per frame, nessun processo esterno |
| moviepy, pydub, ffmpeg-python | **no**: chiamano il programma `ffmpeg` | richiedono comunque i binari |
| imageio-ffmpeg | sì, come **eseguibile** dentro il wheel | build GPL, si torna a lanciare un processo `ffmpeg` |
| soundfile, audioread, librosa | no / solo audio | non leggono i contenitori video |
| lameenc | solo encoder MP3 | serve comunque qualcosa che decodifichi il video |

PyAV è quindi l'unica opzione che elimina i binari separati **e** permette di controllare la conversione
frame per frame da Python (avanzamento reale, annullamento immediato).

## Come funziona la conversione

File: [`src/python/convert.py`](../src/python/convert.py)

1. `av.open(video)` apre il contenitore → `analyze_container()` legge durata, codec, tracce
   (fa il lavoro che prima faceva `ffprobe`); senza traccia audio → `NO_AUDIO_STREAM`.
2. Si apre il file di uscita `output.mp3.part` con formato `mp3`, encoder `libmp3lame`, bitrate CBR scelto.
3. `source.demux(audio)` legge **solo** i pacchetti audio (il video non viene decodificato: è veloce).
4. Ogni frame audio passa da `AudioResampler`: frequenza ammessa dall'MP3 (max 48 kHz) e al massimo 2 canali.
5. Avanzamento: `frame.time` (secondi elaborati) / durata totale → evento `progress`.
6. Annullamento: a ogni pacchetto si controlla il flag impostato da stdin (`cancel` o EOF).
7. A fine conversione `.part` → `output.mp3`, evento `completed`.

Il protocollo JSON Lines verso Node.js **non è cambiato**: Electron, Express e GUI non sanno quale
motore viene usato.

## Verifica

```bash
npm run verify:converter
```
Controlla che il convertitore si avvii, che PyAV sia disponibile con `libmp3lame`, mostra le versioni delle
librerie FFmpeg e la **licenza valutata**. Con `-- --built` verifica l'eseguibile PyInstaller.

`npm run build:python` ripete gli stessi controlli sull'eseguibile compilato e li registra in
`resources/python-converter/<piattaforma>-<arch>/build-info.json`; `prepare-resources.js` rifiuta il
packaging se mancano.

## Licenza: attenzione

La libreria libavcodec inclusa in PyAV 19.0.2 **dichiara** "LGPL version 3 or later", ma la stessa build è
collegata a **x264 e x265, che sono GPL**. Per la distribuzione la combinazione va trattata come
**GPL-3.0-or-later**. Lo script di verifica lo segnala automaticamente. Dettagli e alternative
(es. ricompilare PyAV con un FFmpeg solo LGPL) in [LICENSE_COMPLIANCE.md](LICENSE_COMPLIANCE.md).

## Dimensioni

PyAV aggiunge circa 70 MB (librerie FFmpeg e codec) all'eseguibile del convertitore su Windows x64.
È il prezzo per non dipendere da nulla di esterno.

## Aggiornare PyAV

1. Cambiare la versione in `src/python/requirements.txt`.
2. `pip install -r src/python/requirements-build.txt` nel `.venv`.
3. `npm run verify:converter` — controllare **licenza** e presenza di `libmp3lame` (cambiano fra versioni).
4. `npm test`, poi `npm run build:python` su **ogni** piattaforma.
5. Creare il manifesto `third-party/pyav-<versione>.json` ed eseguire `npm run third-party`
   (procedura in [LICENSE_COMPLIANCE.md](LICENSE_COMPLIANCE.md#aggiornare-pyav-mantenendo-gli-obblighi)); aggiornare `THIRD-PARTY-NOTICES.txt`.

## File di prova

```bash
node scripts/generate-test-media.js
```
Crea in `build/test-media/` video sintetici generati con PyAV (immagine fissa + tono a 440 Hz), un video
senza audio, un MKV a 96 kHz mono, un nome con spazi e Unicode e un file danneggiato.
