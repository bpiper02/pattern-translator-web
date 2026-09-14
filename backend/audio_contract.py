from __future__ import annotations

import hashlib
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

import soundfile as sf

from backend.ffmpeg_runtime import ensure_ffmpeg_runtime

NORMALIZED_SAMPLE_RATE = 44_100
NORMALIZED_CHANNELS = 2
MAX_SOURCE_SECONDS = int(os.getenv("PT_MAX_SPLIT_SECONDS", "600"))


@dataclass(frozen=True)
class AudioInfo:
    sample_rate: int
    channels: int
    frames: int
    duration_seconds: float
    subtype: str


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        while chunk := source.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_audio(path: Path) -> AudioInfo:
    info = sf.info(str(path))
    if info.frames <= 0 or info.samplerate <= 0 or info.channels <= 0:
        raise RuntimeError(f"Audio file is empty or invalid: {path.name}")
    return AudioInfo(
        sample_rate=int(info.samplerate),
        channels=int(info.channels),
        frames=int(info.frames),
        duration_seconds=float(info.frames) / float(info.samplerate),
        subtype=str(info.subtype or ""),
    )


def normalize_for_split(source: Path, destination: Path) -> AudioInfo:
    """Decode arbitrary supported input to the one format split engines receive.

    The model layer never sees MP3/M4A/etc. This removes codec/subtype behavior
    from inference and guarantees that every downstream stem is based on a
    stereo 44.1 kHz PCM WAV source.
    """
    source = Path(source).resolve()
    destination = Path(destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = ensure_ffmpeg_runtime()

    temporary = destination.with_name(destination.name + ".tmp.wav")
    temporary.unlink(missing_ok=True)
    command = [
        str(ffmpeg),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-vn",
        "-ac",
        str(NORMALIZED_CHANNELS),
        "-ar",
        str(NORMALIZED_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        str(temporary),
    ]
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=180,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"Could not decode source audio: {exc}") from exc

    if result.returncode != 0 or not temporary.is_file():
        temporary.unlink(missing_ok=True)
        detail = (result.stderr or result.stdout or "FFmpeg decode failed").strip().splitlines()
        raise RuntimeError(detail[-1] if detail else "FFmpeg decode failed")

    info = inspect_audio(temporary)
    if info.duration_seconds > MAX_SOURCE_SECONDS:
        temporary.unlink(missing_ok=True)
        raise ValueError(
            f"Source is {info.duration_seconds / 60:.1f} minutes; local Split currently supports up to "
            f"{MAX_SOURCE_SECONDS / 60:.0f} minutes per job."
        )
    if info.sample_rate != NORMALIZED_SAMPLE_RATE or info.channels != NORMALIZED_CHANNELS:
        temporary.unlink(missing_ok=True)
        raise RuntimeError("Normalized audio did not match the Split PCM contract")
    if "PCM_16" not in info.subtype:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"Normalized audio has unexpected subtype {info.subtype}")

    os.replace(temporary, destination)
    return info


def validate_stem(path: Path, source: AudioInfo, *, duration_tolerance_seconds: float = 1.0) -> AudioInfo:
    """Reject corrupt/truncated model output before it can enter the Crate."""
    stem = inspect_audio(path)
    if stem.channels > 2:
        raise RuntimeError(f"Stem {path.name} has unsupported channel count {stem.channels}")
    if abs(stem.duration_seconds - source.duration_seconds) > duration_tolerance_seconds:
        raise RuntimeError(
            f"Stem {path.name} duration {stem.duration_seconds:.2f}s does not match source "
            f"{source.duration_seconds:.2f}s"
        )
    return stem
