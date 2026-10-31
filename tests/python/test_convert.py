"""
Test del convertitore Python (unittest della libreria standard).

Esecuzione:  npm run test:python
             (equivale a: python -m unittest discover -s tests/python -v)

I test end-to-end generano video sintetici con PyAV (tests/fixtures/make_media.py)
in una cartella temporanea ed eseguono convert.py come processo separato.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from collections import namedtuple
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src" / "python"))
sys.path.insert(0, str(ROOT / "tests" / "fixtures"))

import convert  # noqa: E402

try:
    import av  # noqa: E402,F401
    import make_media  # noqa: E402
    HAVE_AV = True
except ImportError:
    HAVE_AV = False

CONVERTER = str(ROOT / "src" / "python" / "convert.py")


class ValidationTests(unittest.TestCase):
    def test_bitrate_allowlist(self):
        for value in (128, 192, 256, 320, "192", " 320 "):
            self.assertIn(convert.validate_bitrate(value), convert.ALLOWED_BITRATES)
        for value in (0, 64, 193, "abc", None, "192k", 1000):
            with self.assertRaises(convert.ConverterError) as ctx:
                convert.validate_bitrate(value)
            self.assertEqual(ctx.exception.code, "INVALID_BITRATE")
            self.assertEqual(ctx.exception.exit_code, convert.EXIT_INVALID_ARGS)

    def test_validate_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            video = Path(tmp) / "vidéo con spazi.mp4"
            video.write_bytes(b"x")
            out = Path(tmp) / "out.mp3"
            self.assertEqual(convert.validate_paths(str(video), str(out))[0], os.path.normpath(str(video)))
            with self.assertRaises(convert.ConverterError):
                convert.validate_paths("relativo.mp4", str(out))
            with self.assertRaises(convert.ConverterError):
                convert.validate_paths(str(video), str(Path(tmp) / "out.wav"))
            with self.assertRaises(convert.ConverterError) as ctx:
                convert.validate_paths(str(Path(tmp) / "manca.mp4"), str(out))
            self.assertEqual(ctx.exception.code, "INPUT_NOT_FOUND")


class EngineTests(unittest.TestCase):
    def test_engine_missing(self):
        # Simula un ambiente senza PyAV: l'import fallisce.
        with mock.patch.dict(sys.modules, {"av": None}):
            with self.assertRaises(convert.ConverterError) as ctx:
                convert.load_engine()
            self.assertEqual(ctx.exception.code, "MEDIA_ENGINE_MISSING")
            self.assertEqual(ctx.exception.exit_code, convert.EXIT_ENGINE)
            self.assertEqual(convert.engine_info(), {"available": False})

    @unittest.skipUnless(HAVE_AV, "PyAV non installato")
    def test_engine_info(self):
        info = convert.engine_info()
        self.assertTrue(info["available"])
        self.assertTrue(info["libmp3lame"])
        self.assertIn("libavcodec", info["ffmpegLibraries"])
        self.assertIn("--enable-libmp3lame", info["configuration"])


class AudioParameterTests(unittest.TestCase):
    def test_sample_rate(self):
        self.assertEqual(convert.choose_sample_rate(44100), 44100)
        self.assertEqual(convert.choose_sample_rate(48000), 48000)
        self.assertEqual(convert.choose_sample_rate(96000), 48000)
        self.assertEqual(convert.choose_sample_rate(88200), 48000)
        self.assertEqual(convert.choose_sample_rate(22000), 22050)
        self.assertEqual(convert.choose_sample_rate(0), 44100)

    def test_layout(self):
        self.assertEqual(convert.choose_layout(1), "mono")
        self.assertEqual(convert.choose_layout(2), "stereo")
        self.assertEqual(convert.choose_layout(6), "stereo")  # 5.1 -> stereo


class ProgressTests(unittest.TestCase):
    def test_percent_and_throttle(self):
        now = [0.0]
        reporter = convert.ProgressReporter(100.0, clock=lambda: now[0])
        self.assertEqual(reporter.update(42.5), {"type": "progress", "progress": 42.5, "processedSeconds": 42.5})
        self.assertIsNone(reporter.update(42.55))  # variazione troppo piccola e troppo presto
        now[0] = 1.0
        self.assertIsNotNone(reporter.update(42.56))  # dopo 0,5 s si emette comunque
        self.assertEqual(reporter.update(150)["progress"], 99.9)  # mai 100 prima della fine
        self.assertEqual(reporter.finish()["progress"], 100.0)

    def test_monotonic_and_invalid(self):
        reporter = convert.ProgressReporter(10.0, clock=lambda: 0.0)
        reporter.update(5)
        self.assertIsNone(reporter.update(3))  # i timestamp non tornano indietro
        self.assertEqual(reporter.processed, 5)
        self.assertIsNone(reporter.update(None))
        self.assertIsNone(reporter.update(-1))

    def test_unknown_duration(self):
        reporter = convert.ProgressReporter(None, clock=lambda: 10.0)
        event = reporter.update(3)
        self.assertIsNone(event["progress"])
        self.assertEqual(event["processedSeconds"], 3.0)


class DiskSpaceTests(unittest.TestCase):
    Usage = namedtuple("Usage", "total used free")

    def test_estimate(self):
        self.assertEqual(convert.estimate_output_bytes(None, 192), 0)
        self.assertGreater(convert.estimate_output_bytes(60, 320), 60 * 320 * 1000 // 8)

    def test_insufficient(self):
        with self.assertRaises(convert.ConverterError) as ctx:
            convert.check_disk_space("/x", 10_000_000, disk_usage=lambda _p: self.Usage(0, 0, 1000))
        self.assertEqual(ctx.exception.code, "INSUFFICIENT_DISK_SPACE")
        convert.check_disk_space("/x", 1000, disk_usage=lambda _p: self.Usage(0, 0, 10_000))


@unittest.skipUnless(HAVE_AV, "PyAV non installato")
class EndToEndTests(unittest.TestCase):
    """Esegue convert.py come processo, su video sintetici, e legge il protocollo JSON Lines."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="v2m-py-"))
        cls.video = Path(make_media.make_video(str(cls.tmp / "vidéo prova 日本.mp4"), seconds=4))
        cls.silent = Path(make_media.make_video(str(cls.tmp / "muto.mp4"), seconds=2, audio=False))
        cls.broken = Path(make_media.make_corrupted(str(cls.tmp / "rotto.mp4")))
        cls.long = Path(make_media.make_video(str(cls.tmp / "lungo.mkv"), seconds=1800, rate=16000, channels=1, video=False))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_converter(self, video, bitrate="192", extra=None, cancel_after_progress=False):
        out = self.tmp / f"out-{time.time_ns()}.mp3"
        args = [sys.executable, "-u", CONVERTER, "--input", str(video), "--output", str(out), "--bitrate", bitrate] + (extra or [])
        proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        events = []
        if cancel_after_progress:
            for raw in proc.stdout:
                events.append(json.loads(raw))
                if events[-1]["type"] == "progress":
                    proc.stdin.write(b"cancel\n")
                    proc.stdin.flush()
                    break
        stdout, stderr = proc.communicate(timeout=120)
        events += [json.loads(line) for line in stdout.decode("ascii").splitlines() if line.strip()]
        return proc.returncode, events, out, stderr.decode("utf-8", "replace")

    def test_success(self):
        code, events, out, _ = self.run_converter(self.video, bitrate="256")
        self.assertEqual(code, 0)
        types = [e["type"] for e in events]
        self.assertEqual(types[0], "status")
        self.assertIn("probe", types)
        self.assertIn("progress", types)
        self.assertEqual(events[-1], {"type": "completed", "outputPath": str(out)})
        probe = next(e for e in events if e["type"] == "probe")
        self.assertAlmostEqual(probe["durationSeconds"], 4.0, delta=0.2)
        self.assertEqual(probe["audioCodec"], "aac")
        self.assertTrue(probe["hasVideo"])
        progress = [e["progress"] for e in events if e["type"] == "progress"]
        self.assertEqual(progress, sorted(progress))
        self.assertEqual(progress[-1], 100.0)
        self.assertFalse(Path(str(out) + ".part").exists())
        with av.open(str(out)) as result:
            stream = result.streams.audio[0]
            self.assertTrue(stream.codec_context.name.startswith("mp3"))
            self.assertEqual(stream.bit_rate, 256000)

    def test_no_audio(self):
        code, events, out, _ = self.run_converter(self.silent)
        self.assertEqual(code, convert.EXIT_NO_AUDIO)
        self.assertEqual(events[-1]["code"], "NO_AUDIO_STREAM")
        self.assertFalse(out.exists())

    def test_corrupted(self):
        code, events, out, stderr = self.run_converter(self.broken)
        self.assertEqual(code, convert.EXIT_INPUT)
        self.assertEqual(events[-1]["code"], "INVALID_MEDIA")
        self.assertIn("INVALID_MEDIA", stderr)  # dettagli tecnici solo su stderr
        self.assertFalse(out.exists())

    def test_invalid_bitrate(self):
        code, events, _, _ = self.run_converter(self.video, bitrate="999")
        self.assertEqual(code, convert.EXIT_INVALID_ARGS)
        self.assertEqual(events[-1]["code"], "INVALID_BITRATE")

    def test_cancel_via_stdin(self):
        started = time.monotonic()
        code, events, out, _ = self.run_converter(self.long, bitrate="320", extra=["--control-stdin"], cancel_after_progress=True)
        self.assertEqual(code, convert.EXIT_CANCELLED)
        self.assertEqual(events[-1]["type"], "cancelled")
        self.assertFalse(out.exists())
        self.assertFalse(Path(str(out) + ".part").exists())
        self.assertLess(time.monotonic() - started, 30)

    def test_version(self):
        proc = subprocess.run([sys.executable, CONVERTER, "--version"], capture_output=True, timeout=60)
        info = json.loads(proc.stdout)
        self.assertEqual(info["type"], "version")
        self.assertEqual(info["converter"], convert.CONVERTER_VERSION)
        self.assertTrue(info["engine"]["available"])
        self.assertTrue(info["engine"]["libmp3lame"])


if __name__ == "__main__":
    unittest.main()
