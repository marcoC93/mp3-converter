#!/usr/bin/env python3
"""
Genera file video SINTETICI con PyAV, senza file multimediali nel repository.

Video: immagine fissa a 160x120 (codec mpeg4). Audio: tono sinusoidale a 440 Hz.
Usato dai test Python e di integrazione e dallo script generate-test-media.js.

Uso da riga di comando:
    python make_media.py <file.mp4|.mkv|.avi|.mov> [--seconds 5] [--no-audio]
                         [--rate 48000] [--channels 2]
"""

from __future__ import annotations

import argparse
import math
import os
from array import array

import av

# FLAC in MKV permette di testare frequenze non ammesse dall'MP3 (es. 96 kHz).
AUDIO_CODECS = {".mp4": "aac", ".mov": "aac", ".m4v": "aac", ".mkv": "flac", ".webm": "libopus", ".avi": "mp3"}


def make_video(path: str, seconds: float = 5.0, audio: bool = True, rate: int = 48000, channels: int = 2, video: bool = True) -> str:
    ext = os.path.splitext(path)[1].lower()
    with av.open(path, mode="w") as out:
        vstream = None
        if video:
            vstream = out.add_stream("mpeg4", rate=10)
            vstream.width, vstream.height, vstream.pix_fmt = 160, 120, "yuv420p"
        astream = None
        layout = "mono" if channels == 1 else "stereo"
        if audio:
            astream = out.add_stream(AUDIO_CODECS.get(ext, "aac"), rate=rate)
            astream.layout = layout

        if vstream is not None:
            for i in range(max(1, int(seconds * 10))):
                frame = av.VideoFrame(160, 120, "yuv420p")
                frame.pts = i
                for packet in vstream.encode(frame):
                    out.mux(packet)
            for packet in vstream.encode(None):
                out.mux(packet)

        if astream is not None:
            # Un secondo di tono a 440 Hz (periodo intero), riutilizzato: genera
            # anche file lunghi in pochi secondi senza dipendere da numpy.
            one_second = array("h")
            for n in range(rate):
                one_second.extend([int(9000 * math.sin(2 * math.pi * 440 * n / rate))] * channels)
            data = one_second.tobytes() * 2  # doppio: ogni blocco si legge senza "a capo"
            bytes_per_sample = 2 * channels
            chunk = 1024
            total = int(seconds * rate)
            for start in range(0, total, chunk):
                count = min(chunk, total - start)
                offset = (start % rate) * bytes_per_sample
                piece = data[offset:offset + count * bytes_per_sample]
                frame = av.AudioFrame(format="s16", layout=layout, samples=count)
                frame.planes[0].update(piece)
                frame.sample_rate = rate
                frame.pts = start
                for packet in astream.encode(frame):
                    out.mux(packet)
            for packet in astream.encode(None):
                out.mux(packet)
    return path


def make_corrupted(path: str) -> str:
    with open(path, "wb") as handle:
        handle.write(("questo non è un video " * 300).encode("utf-8"))
    return path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path")
    parser.add_argument("--seconds", type=float, default=5.0)
    parser.add_argument("--no-audio", action="store_true")
    parser.add_argument("--rate", type=int, default=48000)
    parser.add_argument("--channels", type=int, default=2)
    parser.add_argument("--corrupted", action="store_true")
    a = parser.parse_args()
    if a.corrupted:
        make_corrupted(a.path)
    else:
        make_video(a.path, a.seconds, not a.no_audio, a.rate, a.channels)
    print(a.path)
