# Qualità MP3

## Bitrate

Il **bitrate** è la quantità di dati usata per ogni secondo di audio, in kilobit al secondo (kbps).
L'MP3 è un formato **con perdita**: per ridurre la dimensione elimina le informazioni che l'orecchio percepisce
meno. Più bit sono disponibili, meno informazioni vengono scartate.

| Opzione | Uso tipico | Dimensione per minuto (circa) |
|---------|------------|-------------------------------|
| 128 kbps — Standard | parlato, podcast, ascolto occasionale | ~0,96 MB |
| **192 kbps — Alta (predefinita)** | musica, ottimo compromesso | ~1,44 MB |
| 256 kbps — Molto alta | musica su impianti buoni | ~1,92 MB |
| 320 kbps — Massima | massimo consentito dallo standard MP3 | ~2,40 MB |

Calcolo: `kbps × 1000 / 8 × 60` byte al minuto. Un video di 1 ora a 320 kbps produce circa 144 MB di MP3.

## CBR e VBR

- **CBR (Constant Bitrate):** ogni secondo usa lo stesso numero di bit. Dimensione prevedibile, massima compatibilità
  con lettori vecchi, autoradio, software di editing; la durata è calcolabile esattamente.
- **VBR (Variable Bitrate):** più bit ai passaggi complessi, meno a quelli semplici (silenzi, voce).
  A parità di dimensione la qualità è spesso migliore; la dimensione finale non è prevedibile e qualche
  lettore datato mostra durate errate.

## Scelta adottata: CBR

L'app usa l'encoder `libmp3lame` con `stream.bit_rate = <bitrate> × 1000`, cioè **CBR**, perché:
1. l'utente sceglie un numero (128/192/256/320) e ottiene esattamente quello: comportamento intuitivo;
2. la dimensione è prevedibile, quindi possiamo verificare lo spazio su disco prima di iniziare;
3. massima compatibilità con qualunque dispositivo.

Volendo offrire VBR in futuro: impostare la qualità VBR di libmp3lame (`-q:a 0..9` nella riga di comando di FFmpeg; in PyAV tramite le opzioni del codec) (0 = qualità massima ≈ 245 kbps medi, 2 ≈ 190 kbps).
Andrebbe aggiunta un'opzione all'allowlist in `validation.js` e in `convert.py`.

## Perché 320 kbps non migliora una sorgente scadente

La conversione non può **ricreare** informazioni perse. Se l'audio del video è già compresso a 96 kbps AAC,
codificarlo in MP3 a 320 kbps produce un file più grande ma con gli stessi difetti (anzi, ogni ricodifica con
perdita aggiunge un piccolo degrado). Regola pratica: scegli un bitrate pari o di poco superiore alla qualità
della sorgente. L'app mostra il codec audio della sorgente durante la conversione.

## Altre impostazioni

- **Frequenza di campionamento e canali:** conservati dalla sorgente; se la sorgente usa una frequenza non
  supportata dall'MP3 (es. 96 kHz), il convertitore la ricampiona alla più vicina supportata (es. 96 kHz → 48 kHz) con `AudioResampler` di PyAV.
- **Canali:** l'MP3 ha al massimo 2 canali; l'audio 5.1 viene ridotto a stereo, il mono resta mono.
- **Traccia audio:** viene usata la prima (`container.streams.audio[0]`). Video con più lingue: viene estratta la prima traccia.
- **Metadati:** intestazione ID3v2.3 (opzione `id3v2_version=3` del formato mp3), la più compatibile.
