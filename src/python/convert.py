#!/usr/bin/env python3
"""
Motore di conversione video -> MP3.

Questo programma viene avviato da Electron (Node.js) come PROCESSO FIGLIO.
Non ha interfaccia grafica: riceve parametri da riga di comando e comunica
il proprio stato scrivendo eventi JSON Lines (un oggetto JSON per riga) su
stdout. I dettagli tecnici (log) vanno invece su stderr.

Perché questa separazione?
- stdout = "canale applicativo": solo eventi strutturati che Node.js valida.
- stderr = "canale diagnostico": testo libero, finisce nei log tecnici.

Motore multimediale: PyAV (pacchetto Python "av").
PyAV contiene al suo interno le librerie di FFmpeg (libavformat, libavcodec,
libswresample...) già compilate, incluso l'encoder MP3 libmp3lame. Viene
installato con pip e PyInstaller lo include nell'eseguibile: il programma
finale non richiede binari ffmpeg/ffprobe separati né installazioni.
Licenze: vedi docs/LICENSE_COMPLIANCE.md.

Codici di uscita (documentati anche in docs/ARCHITECTURE.md):
    0   conversione completata
    1   errore interno inatteso
    2   argomenti non validi (es. bitrate non ammesso)
    3   motore multimediale non disponibile o encoder MP3 assente
    4   file di input mancante, non leggibile o non decodificabile
    5   il file non contiene tracce audio
    6   errore durante la codifica
    7   spazio su disco insufficiente
    130 conversione annullata
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import shutil
import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

CONVERTER_VERSION = "2.0.0"
PROTOCOL_VERSION = 1

# Allowlist dei bitrate: qualsiasi altro valore viene rifiutato.
# La stessa lista esiste in Node.js (src/main/validation.js): la doppia
# validazione è voluta ("defense in depth").
ALLOWED_BITRATES = (128, 192, 256, 320)

# Frequenze di campionamento ammesse dallo standard MP3 (MPEG-1/2/2.5).
MP3_SAMPLE_RATES = (8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000)

# Valore di AV_DISPOSITION_ATTACHED_PIC in FFmpeg (copertina incorporata).
ATTACHED_PIC = 1024

EXIT_OK = 0
EXIT_INTERNAL = 1
EXIT_INVALID_ARGS = 2
EXIT_ENGINE = 3
EXIT_INPUT = 4
EXIT_NO_AUDIO = 5
EXIT_ENCODE = 6
EXIT_DISK = 7
EXIT_CANCELLED = 130


class ConverterError(Exception):
    """Errore "previsto": ha un codice stabile che Node.js traduce per l'utente."""

    def __init__(self, code: str, message: str, exit_code: int, details: str = ""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code
        self.details = details


class Cancelled(Exception):
    pass


# --------------------------------------------------------------------------
# Output del protocollo
# --------------------------------------------------------------------------

_emit_lock = threading.Lock()


def emit(event: dict) -> None:
    """Scrive un evento JSON Lines su stdout.

    ensure_ascii=True: l'output è puro ASCII (i caratteri Unicode diventano
    sequenze \\uXXXX), quindi non dipende dalla codifica della console o
    della pipe, problema classico su Windows.
    """
    line = json.dumps(event, ensure_ascii=True, separators=(",", ":"))
    with _emit_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(message: str) -> None:
    """Log tecnico su stderr (non fa parte del protocollo)."""
    try:
        sys.stderr.write(f"[converter] {message}\n")
        sys.stderr.flush()
    except Exception:  # stderr chiuso: non c'è niente di utile da fare
        pass


# --------------------------------------------------------------------------
# Motore multimediale (import ritardato)
# --------------------------------------------------------------------------


def load_engine():
    """Importa PyAV solo quando serve.

    Così --version e i test delle funzioni pure funzionano anche se PyAV
    manca, e l'assenza viene segnalata con un codice d'errore chiaro.
    """
    try:
        import av  # noqa: PLC0415
    except ImportError as exc:
        raise ConverterError("MEDIA_ENGINE_MISSING", "Il motore multimediale (PyAV) non è disponibile", EXIT_ENGINE, str(exc))
    if "libmp3lame" not in av.codecs_available:
        raise ConverterError("ENCODER_NOT_AVAILABLE", "La libreria multimediale inclusa non supporta l'encoder MP3 (libmp3lame)", EXIT_ENGINE)
    return av


def engine_info() -> dict:
    """Versioni e licenza delle librerie FFmpeg incluse in PyAV (per 'Informazioni')."""
    try:
        import av  # noqa: PLC0415
        from av import _core  # noqa: PLC0415
    except ImportError:
        return {"available": False}
    meta = _core.library_meta.get("libavcodec", {})
    return {
        "available": True,
        "pyav": av.__version__,
        "ffmpegLibraries": {name: ".".join(map(str, ver)) for name, ver in av.library_versions.items()},
        "license": str(meta.get("license", "")),
        "configuration": str(meta.get("configuration", "")),
        "libmp3lame": "libmp3lame" in av.codecs_available,
    }


# --------------------------------------------------------------------------
# Validazione
# --------------------------------------------------------------------------


def validate_bitrate(value) -> int:
    try:
        bitrate = int(str(value).strip())
    except (TypeError, ValueError):
        raise ConverterError("INVALID_BITRATE", f"Bitrate non valido: {value!r}", EXIT_INVALID_ARGS)
    if bitrate not in ALLOWED_BITRATES:
        raise ConverterError("INVALID_BITRATE", f"Bitrate non ammesso: {bitrate}", EXIT_INVALID_ARGS)
    return bitrate


def validate_paths(input_path: str, output_path: str) -> tuple[str, str]:
    if not input_path or not os.path.isabs(input_path):
        raise ConverterError("INVALID_ARGUMENTS", "Il percorso di input deve essere assoluto", EXIT_INVALID_ARGS)
    if not output_path or not os.path.isabs(output_path):
        raise ConverterError("INVALID_ARGUMENTS", "Il percorso di output deve essere assoluto", EXIT_INVALID_ARGS)
    input_path = os.path.normpath(input_path)
    output_path = os.path.normpath(output_path)
    if not output_path.lower().endswith(".mp3"):
        raise ConverterError("INVALID_ARGUMENTS", "Il file di output deve avere estensione .mp3", EXIT_INVALID_ARGS)
    if not os.path.isfile(input_path) or not os.access(input_path, os.R_OK):
        raise ConverterError("INPUT_NOT_FOUND", "Il file di input non esiste o non è leggibile", EXIT_INPUT)
    if not os.path.isdir(os.path.dirname(output_path)):
        raise ConverterError("INVALID_ARGUMENTS", "La cartella di output non esiste", EXIT_INVALID_ARGS)
    return input_path, output_path


# --------------------------------------------------------------------------
# Analisi del file (equivalente di ffprobe)
# --------------------------------------------------------------------------


@dataclass
class ProbeResult:
    duration_seconds: Optional[float]
    audio_codec: str
    container: str
    has_video: bool
    sample_rate: int
    channels: int


def _positive(value) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number <= 0:  # NaN o non positivo
        return None
    return number


def analyze_container(container) -> ProbeResult:
    """Descrive un contenitore aperto con PyAV. Non decodifica nulla."""
    audio_streams = list(container.streams.audio)
    if not audio_streams:
        raise ConverterError("NO_AUDIO_STREAM", "Il file non contiene una traccia audio", EXIT_NO_AUDIO)
    audio = audio_streams[0]

    # container.duration è espressa in microsecondi (AV_TIME_BASE).
    duration = _positive(container.duration / 1_000_000) if container.duration else None
    if duration is None and audio.duration and audio.time_base:
        duration = _positive(float(audio.duration * audio.time_base))

    # Una copertina (attached_pic) è tecnicamente una traccia video, ma non è un video.
    has_video = any(not int(getattr(s, "disposition", 0)) & ATTACHED_PIC for s in container.streams.video)
    ctx = audio.codec_context
    channels = len(ctx.layout.channels) if ctx.layout is not None else 0
    return ProbeResult(
        duration_seconds=duration,
        audio_codec=str(ctx.name or "sconosciuto"),
        container=str(container.format.name or "sconosciuto"),
        has_video=has_video,
        sample_rate=int(ctx.sample_rate or 0),
        channels=channels,
    )


def open_input(av, input_path: str):
    try:
        return av.open(input_path, mode="r")
    except FileNotFoundError:
        raise ConverterError("INPUT_NOT_FOUND", "Il file di input non esiste", EXIT_INPUT)
    except PermissionError:
        raise ConverterError("INPUT_NOT_FOUND", "Il file di input non è leggibile", EXIT_INPUT)
    except av.error.FFmpegError as exc:
        raise ConverterError("INVALID_MEDIA", "Il file è danneggiato o non è un video supportato", EXIT_INPUT, str(exc))


# --------------------------------------------------------------------------
# Parametri di uscita
# --------------------------------------------------------------------------


def choose_sample_rate(source_rate: int) -> int:
    """MP3 accetta solo alcune frequenze: si sceglie la più vicina (max 48 kHz)."""
    if source_rate in MP3_SAMPLE_RATES:
        return source_rate
    if source_rate <= 0:
        return 44100
    return min(MP3_SAMPLE_RATES, key=lambda rate: abs(rate - source_rate))


def choose_layout(channels: int) -> str:
    """MP3 supporta al massimo 2 canali: il 5.1 viene ridotto a stereo."""
    return "mono" if channels == 1 else "stereo"


# --------------------------------------------------------------------------
# Spazio su disco
# --------------------------------------------------------------------------


def estimate_output_bytes(duration_seconds: Optional[float], bitrate_kbps: int) -> int:
    """Stima della dimensione MP3: bitrate * durata, più un margine del 10% + 1 MB."""
    if not duration_seconds:
        return 0
    return int(duration_seconds * bitrate_kbps * 1000 / 8 * 1.1) + 1024 * 1024


def check_disk_space(output_dir: str, required_bytes: int, disk_usage: Callable = shutil.disk_usage) -> None:
    if required_bytes <= 0:
        return
    try:
        free = disk_usage(output_dir).free
    except OSError:
        return  # non verificabile: l'eventuale errore emergerà in scrittura
    if free < required_bytes:
        raise ConverterError("INSUFFICIENT_DISK_SPACE", "Spazio su disco insufficiente per la conversione", EXIT_DISK)


# --------------------------------------------------------------------------
# Avanzamento
# --------------------------------------------------------------------------


class ProgressReporter:
    """Trasforma il tempo dei frame decodificati in eventi di avanzamento.

    L'avanzamento è REALE: si confronta il timestamp dell'ultimo frame audio
    elaborato con la durata totale del file. Per non inondare Node.js di
    messaggi, si emette solo quando la percentuale cresce di almeno 0,1 punti
    o sono passati 0,5 secondi dall'ultimo evento.
    """

    MIN_DELTA_PERCENT = 0.1
    MIN_INTERVAL_SECONDS = 0.5

    def __init__(self, duration_seconds: Optional[float], clock: Callable[[], float] = time.monotonic):
        self.duration = duration_seconds
        self.clock = clock
        self.processed = 0.0
        self.last_percent: Optional[float] = None
        self.last_time = 0.0

    def update(self, seconds: Optional[float]) -> Optional[dict]:
        if seconds is None or seconds < 0:
            return None
        self.processed = max(self.processed, float(seconds))
        percent = None
        if self.duration:
            percent = max(0.0, min(99.9, self.processed / self.duration * 100))
        now = self.clock()
        if percent is not None and self.last_percent is not None:
            if percent - self.last_percent < self.MIN_DELTA_PERCENT and now - self.last_time < self.MIN_INTERVAL_SECONDS:
                return None
        elif percent is None and now - self.last_time < self.MIN_INTERVAL_SECONDS:
            return None
        self.last_percent = percent if percent is not None else self.last_percent
        self.last_time = now
        return {"type": "progress", "progress": round(percent, 1) if percent is not None else None, "processedSeconds": round(self.processed, 3)}

    def finish(self) -> dict:
        return {"type": "progress", "progress": 100.0, "processedSeconds": round(self.processed, 3)}


# --------------------------------------------------------------------------
# Conversione
# --------------------------------------------------------------------------


def _is_disk_full(exc: BaseException) -> bool:
    return getattr(exc, "errno", None) in (errno.ENOSPC, getattr(errno, "EDQUOT", -1)) or "no space left" in str(exc).lower()


def transcode(av, input_path: str, output_path: str, bitrate: int, probe: ProbeResult,
              cancel_event: threading.Event, on_progress: Callable[[dict], None]) -> ProgressReporter:
    """Decodifica la prima traccia audio e la codifica in MP3 CBR.

    Nessun processo esterno e nessuna shell: tutto avviene dentro questo
    processo tramite le librerie FFmpeg incluse in PyAV.
    """
    reporter = ProgressReporter(probe.duration_seconds)
    rate = choose_sample_rate(probe.sample_rate)
    layout = choose_layout(probe.channels)

    with open_input(av, input_path) as source:
        audio = source.streams.audio[0]
        # Il video non viene decodificato: si leggono solo i pacchetti audio.
        with av.open(output_path, mode="w", format="mp3", options={"id3v2_version": "3"}) as target:
            stream = target.add_stream("libmp3lame", rate=rate)
            stream.layout = layout
            stream.bit_rate = bitrate * 1000  # CBR: vedi docs/AUDIO_QUALITY.md
            resampler = av.AudioResampler(format="s16p", layout=layout, rate=rate)

            def write(frames):
                for out_frame in frames:
                    for packet in stream.encode(out_frame):
                        target.mux(packet)

            try:
                for packet in source.demux(audio):
                    if cancel_event.is_set():
                        raise Cancelled()
                    try:
                        frames = packet.decode()
                    except av.error.InvalidDataError as exc:
                        # Un pacchetto rovinato non deve far fallire tutto il file.
                        log(f"pacchetto audio non decodificabile, ignorato: {exc}")
                        continue
                    for frame in frames:
                        write(resampler.resample(frame))
                        event = reporter.update(frame.time)
                        if event:
                            on_progress(event)
                write(resampler.resample(None))
                for packet in stream.encode(None):
                    target.mux(packet)
            except Cancelled:
                raise
            except av.error.FFmpegError as exc:
                if _is_disk_full(exc):
                    raise ConverterError("INSUFFICIENT_DISK_SPACE", "Spazio su disco esaurito durante la conversione", EXIT_DISK, str(exc))
                raise ConverterError("INVALID_MEDIA", "Il file sembra danneggiato", EXIT_INPUT, str(exc))
            except OSError as exc:
                if _is_disk_full(exc):
                    raise ConverterError("INSUFFICIENT_DISK_SPACE", "Spazio su disco esaurito durante la conversione", EXIT_DISK, str(exc))
                raise ConverterError("ENCODE_FAILED", "Errore durante la scrittura dell'MP3", EXIT_ENCODE, str(exc))
    return reporter


# --------------------------------------------------------------------------
# Annullamento tramite stdin
# --------------------------------------------------------------------------


def watch_stdin(cancel_event: threading.Event) -> None:
    """Annulla quando Node.js scrive 'cancel' oppure chiude stdin.

    La chiusura di stdin (EOF) avviene anche quando il processo padre muore
    all'improvviso: così il convertitore non resta orfano in esecuzione.
    Funziona in modo identico su Windows, macOS e Linux.
    """
    try:
        for line in sys.stdin:
            if line.strip().lower() == "cancel":
                break
    except (OSError, ValueError):
        pass
    cancel_event.set()


# --------------------------------------------------------------------------
# Flusso principale
# --------------------------------------------------------------------------


def convert(args: argparse.Namespace, cancel_event: threading.Event) -> str:
    bitrate = validate_bitrate(args.bitrate)
    input_path, output_path = validate_paths(args.input, args.output)
    av = load_engine()

    emit({"type": "status", "status": "analyzing", "message": "Analisi del file"})
    with open_input(av, input_path) as container:
        probe = analyze_container(container)
    emit({
        "type": "probe",
        "durationSeconds": probe.duration_seconds,
        "audioCodec": probe.audio_codec,
        "container": probe.container,
        "hasVideo": probe.has_video,
    })
    if cancel_event.is_set():
        raise Cancelled()

    check_disk_space(os.path.dirname(output_path), estimate_output_bytes(probe.duration_seconds, bitrate))

    # Scriviamo su un file ".part" e rinominiamo solo a conversione riuscita:
    # un MP3 incompleto non viene mai scambiato per un risultato valido.
    partial_path = output_path + ".part"
    emit({"type": "status", "status": "converting", "message": "Conversione in corso"})
    try:
        reporter = transcode(av, input_path, partial_path, bitrate, probe, cancel_event, emit)
        if not os.path.isfile(partial_path) or os.path.getsize(partial_path) == 0:
            raise ConverterError("ENCODE_FAILED", "Non è stato prodotto alcun audio", EXIT_ENCODE)
        emit({"type": "status", "status": "finalizing", "message": "Finalizzazione"})
        os.replace(partial_path, output_path)
    finally:
        if os.path.exists(partial_path):
            try:
                os.remove(partial_path)
            except OSError:
                log("Impossibile rimuovere il file parziale")

    emit(reporter.finish())
    return output_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Converte la traccia audio di un video in MP3 (JSON Lines su stdout).")
    parser.add_argument("--version", action="store_true", help="stampa versione e informazioni sul motore in JSON ed esce")
    parser.add_argument("--input", help="percorso assoluto del video")
    parser.add_argument("--output", help="percorso assoluto del file .mp3 da creare")
    parser.add_argument("--bitrate", help="bitrate in kbps: " + ", ".join(map(str, ALLOWED_BITRATES)))
    parser.add_argument("--control-stdin", action="store_true", help="annulla quando stdin riceve 'cancel' o viene chiuso")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(errors="backslashreplace")

    parser = build_parser()
    args = parser.parse_args(argv)

    if args.version:
        emit({
            "type": "version",
            "converter": CONVERTER_VERSION,
            "protocol": PROTOCOL_VERSION,
            "python": sys.version.split()[0],
            "frozen": bool(getattr(sys, "frozen", False)),
            "engine": engine_info(),
        })
        return EXIT_OK

    missing = [name for name in ("input", "output", "bitrate") if not getattr(args, name)]
    if missing:
        emit({"type": "error", "code": "INVALID_ARGUMENTS", "message": "Argomenti mancanti: " + ", ".join(missing)})
        return EXIT_INVALID_ARGS

    cancel_event = threading.Event()
    if args.control_stdin:
        threading.Thread(target=watch_stdin, args=(cancel_event,), daemon=True).start()

    started = time.monotonic()
    try:
        output_path = convert(args, cancel_event)
    except Cancelled:
        emit({"type": "cancelled", "message": "Conversione annullata"})
        return EXIT_CANCELLED
    except ConverterError as exc:
        if exc.details:
            log(f"{exc.code}: {exc.details}")
        emit({"type": "error", "code": exc.code, "message": exc.message})
        return exc.exit_code
    except Exception as exc:  # noqa: BLE001 - ultimo livello di protezione
        log(f"Errore inatteso: {exc!r}")
        emit({"type": "error", "code": "INTERNAL_ERROR", "message": "Errore interno del convertitore"})
        return EXIT_INTERNAL

    log(f"Completato in {time.monotonic() - started:.1f}s")
    emit({"type": "completed", "outputPath": output_path})
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
