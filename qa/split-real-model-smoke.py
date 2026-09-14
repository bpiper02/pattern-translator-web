from __future__ import annotations

import math
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from backend.audio_contract import inspect_audio
from backend.ffmpeg_runtime import ensure_ffmpeg_runtime
from backend.split_pipeline import run_full_pipeline


def make_fixture(path: Path, seconds: float = 8.0, sample_rate: int = 44_100) -> None:
    """Create a dense stereo music-like fixture without external test assets."""
    frames = int(seconds * sample_rate)
    t = np.arange(frames, dtype=np.float32) / sample_rate

    bass = 0.22 * np.sin(2 * math.pi * 82.41 * t)
    melody = 0.13 * np.sin(2 * math.pi * 329.63 * t) + 0.09 * np.sin(2 * math.pi * 493.88 * t)
    vocalish = 0.10 * np.sin(2 * math.pi * (220 + 8 * np.sin(2 * math.pi * 4.5 * t)) * t)

    percussion = np.zeros_like(t)
    pulse_length = int(0.045 * sample_rate)
    envelope = np.exp(-np.linspace(0, 7, pulse_length, dtype=np.float32))
    rng = np.random.default_rng(20260914)
    for beat in np.arange(0.15, seconds, 0.5):
        start = int(beat * sample_rate)
        end = min(frames, start + pulse_length)
        count = end - start
        if count > 0:
            noise = rng.normal(0, 1, count).astype(np.float32)
            percussion[start:end] += 0.18 * noise * envelope[:count]

    left = bass + melody + vocalish + percussion
    right = bass + 0.95 * melody + 0.9 * vocalish + np.roll(percussion, 23)
    stereo = np.column_stack((left, right))
    peak = float(np.max(np.abs(stereo)))
    if peak > 0.92:
        stereo *= 0.92 / peak
    sf.write(path, stereo, sample_rate, subtype="PCM_16")


def encode_mp3(source: Path, target: Path) -> None:
    ffmpeg = ensure_ffmpeg_runtime()
    result = subprocess.run(
        [
            str(ffmpeg),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "192k",
            str(target),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0 or not target.is_file():
        raise RuntimeError(f"Could not encode MP3 fixture: {(result.stderr or result.stdout).strip()}")


def main() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        source_wav = root / "fixture.wav"
        source_mp3 = root / "fixture.mp3"
        job_dir = root / "job"
        model_root = root / "models"
        job_dir.mkdir()
        model_root.mkdir()

        make_fixture(source_wav)
        encode_mp3(source_wav, source_mp3)
        original = inspect_audio(source_wav)
        phases: list[str] = []

        started = time.perf_counter()
        engine, files, profile = run_full_pipeline(
            source_mp3,
            job_dir,
            model_root,
            "balanced",
            on_phase=phases.append,
        )
        elapsed = time.perf_counter() - started

        assert profile == "balanced", profile
        assert engine == "htdemucs.yaml", engine
        assert "normalizing" in phases, phases
        assert "separating" in phases, phases
        assert "validating" in phases, phases

        by_kind = dict(files)
        assert set(by_kind) == {"drums", "bass", "vocals", "other"}, by_kind
        for kind, path in by_kind.items():
            assert path == job_dir / f"{kind}.wav", (kind, path)
            info = sf.info(str(path))
            assert info.format == "WAV", (kind, info.format)
            assert str(info.subtype).startswith("PCM_"), (kind, info.subtype)
            assert info.frames > 0, kind
            duration = info.frames / info.samplerate
            assert abs(duration - original.duration_seconds) <= 1.0, (kind, duration, original.duration_seconds)
            audio, _ = sf.read(path, dtype="float32", always_2d=True)
            assert np.isfinite(audio).all(), kind
            assert float(np.max(np.abs(audio))) > 0.0, f"{kind} stem is silent"

        # The pipeline must clean private work material and leave only published
        # canonical stems. This is the product boundary served to the browser.
        assert not (job_dir / "normalized.wav").exists()
        assert not (job_dir / "work").exists()

        print(
            "REAL SPLIT SMOKE: PASS | "
            f"engine={engine} | source=MP3 | stems=4 | elapsed={elapsed:.1f}s"
        )


if __name__ == "__main__":
    main()
