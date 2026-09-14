from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from backend.audio_contract import AudioInfo, normalize_for_split, validate_stem
from backend.separator_service import run_separator
from backend.separation_profiles import (
    FullMixProfile,
    DrumProfile,
    classify_broad,
    classify_drum,
    classify_pair,
    drum_profile,
    full_mix_profile,
)

PIPELINE_REVISION = "split-pipeline-v1"
PhaseCallback = Callable[[str], None]


def _noop_phase(_: str) -> None:
    return


def _collect_broad(paths: list[Path]) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for path in paths:
        kind = classify_broad(path)
        if kind and kind not in found:
            found[kind] = path
    return found


def _collect_pair(paths: list[Path]) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for path in paths:
        kind = classify_pair(path)
        if kind and kind not in found:
            found[kind] = path
    return found


def _mix_cymbals(paths: list[Path], output_path: Path) -> Path:
    arrays: list[np.ndarray] = []
    sample_rate: int | None = None
    max_frames = 0
    channels = 0
    for path in paths:
        audio, sr = sf.read(path, dtype="float32", always_2d=True)
        if sample_rate is None:
            sample_rate = int(sr)
        elif sr != sample_rate:
            raise RuntimeError("Cymbal sub-stems used different sample rates")
        arrays.append(audio)
        max_frames = max(max_frames, audio.shape[0])
        channels = max(channels, audio.shape[1])
    if sample_rate is None or not arrays:
        raise RuntimeError("No cymbal stems available to combine")
    combined = np.zeros((max_frames, channels), dtype=np.float32)
    for audio in arrays:
        if audio.shape[1] == 1 and channels == 2:
            audio = np.repeat(audio, 2, axis=1)
        combined[: audio.shape[0], : audio.shape[1]] += audio
    peak = float(np.max(np.abs(combined))) if combined.size else 0.0
    if peak > 1.0:
        combined /= peak
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output_path, combined, sample_rate, subtype="PCM_24")
    return output_path


def _collect_drum(paths: list[Path], output_dir: Path) -> dict[str, Path]:
    found: dict[str, Path] = {}
    cymbal_parts: list[Path] = []
    for path in paths:
        kind = classify_drum(path)
        if kind in {"ride", "crash"}:
            cymbal_parts.append(path)
        elif kind and kind not in found:
            found[kind] = path
    if "cymbals" not in found and cymbal_parts:
        found["cymbals"] = _mix_cymbals(cymbal_parts, output_dir / "cymbals-combined.wav")
    return found


def _run_rule_based_drums(input_path: Path, output_dir: Path) -> list[Path]:
    try:
        from drumsep import separate
    except ImportError as exc:
        raise RuntimeError("drumsep is not installed in the splitter environment") from exc
    output_dir.mkdir(parents=True, exist_ok=True)
    separate(str(input_path), output_dir=str(output_dir), enhanced=True)
    return list(output_dir.rglob("*.wav"))


def _publish_validated(
    job_dir: Path,
    source_info: AudioInfo,
    files: list[tuple[str, Path]],
) -> list[tuple[str, Path]]:
    """Validate every stem first, then publish canonical WAV names together."""
    if not files:
        raise RuntimeError("Separator returned no stems")

    stage = job_dir / "publish-stage"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True, exist_ok=True)
    staged: list[tuple[str, Path]] = []
    try:
        for kind, source in files:
            validate_stem(source, source_info)
            staged_path = stage / f"{kind}.wav"
            shutil.copy2(source, staged_path)
            validate_stem(staged_path, source_info)
            staged.append((kind, staged_path))

        published: list[tuple[str, Path]] = []
        for kind, staged_path in staged:
            destination = job_dir / f"{kind}.wav"
            os.replace(staged_path, destination)
            published.append((kind, destination))
        return published
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def _normalize(job_dir: Path, input_path: Path, on_phase: PhaseCallback) -> tuple[Path, AudioInfo]:
    on_phase("normalizing")
    normalized = job_dir / "normalized.wav"
    info = normalize_for_split(input_path, normalized)
    return normalized, info


def run_full_pipeline(
    input_path: Path,
    job_dir: Path,
    model_root: Path,
    profile_name: str,
    *,
    on_phase: PhaseCallback = _noop_phase,
) -> tuple[str, list[tuple[str, Path]], str]:
    selected: FullMixProfile = full_mix_profile(profile_name)
    work = job_dir / "work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)
    normalized, source_info = _normalize(job_dir, input_path, on_phase)
    fallback = False

    try:
        if selected.name == "hq":
            try:
                on_phase("separating-vocals")
                pair_dir = work / "vocal-pair"
                pair_paths = run_separator(
                    normalized,
                    pair_dir,
                    model_root,
                    ensemble_preset=selected.vocal_ensemble_preset,
                    custom_output_names={"Vocals": "vocals", "Instrumental": "instrumental"},
                )
                pair = _collect_pair(pair_paths)
                vocals = pair.get("vocals")
                instrumental = pair.get("instrumental")
                if not vocals or not instrumental:
                    raise RuntimeError("Vocal ensemble did not return vocals + instrumental")
                validate_stem(vocals, source_info)
                validate_stem(instrumental, source_info)

                on_phase("separating-instruments")
                broad_dir = work / "instrumental-broad"
                broad_paths = run_separator(
                    instrumental,
                    broad_dir,
                    model_root,
                    model=selected.broad_model,
                    custom_output_names={
                        "Drums": "drums",
                        "Bass": "bass",
                        "Vocals": "discard-vocals",
                        "Other": "other",
                    },
                )
                broad = _collect_broad(broad_paths)
                required = {"drums", "bass", "other"}
                if not required.issubset(broad):
                    raise RuntimeError("Instrumental separator did not return drums/bass/other")
                on_phase("validating")
                published = _publish_validated(
                    job_dir,
                    source_info,
                    [
                        ("drums", broad["drums"]),
                        ("bass", broad["bass"]),
                        ("vocals", vocals),
                        ("other", broad["other"]),
                    ],
                )
                return (
                    f"ensemble:{selected.vocal_ensemble_preset} -> {selected.broad_model}",
                    published,
                    "hq",
                )
            except Exception:
                selected = full_mix_profile("balanced")
                fallback = True

        on_phase("separating")
        broad_dir = work / "broad"
        broad_paths = run_separator(
            normalized,
            broad_dir,
            model_root,
            model=selected.broad_model,
            custom_output_names={
                "Drums": "drums",
                "Bass": "bass",
                "Vocals": "vocals",
                "Other": "other",
            },
        )
        broad = _collect_broad(broad_paths)
        required = {"drums", "bass", "vocals", "other"}
        if not required.issubset(broad):
            raise RuntimeError("Separator did not return all broad stems")
        on_phase("validating")
        published = _publish_validated(
            job_dir,
            source_info,
            [(kind, broad[kind]) for kind in ("drums", "bass", "vocals", "other")],
        )
        engine = f"fallback:{selected.broad_model}" if fallback else selected.broad_model
        return engine, published, "balanced-fallback" if fallback else "balanced"
    finally:
        shutil.rmtree(work, ignore_errors=True)
        normalized.unlink(missing_ok=True)


def run_drum_pipeline(
    input_path: Path,
    job_dir: Path,
    model_root: Path,
    profile_name: str,
    *,
    on_phase: PhaseCallback = _noop_phase,
) -> tuple[str, list[tuple[str, Path]], str]:
    selected: DrumProfile = drum_profile(profile_name)
    work = job_dir / "work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)
    normalized, source_info = _normalize(job_dir, input_path, on_phase)
    fallback = False

    try:
        if selected.name == "hq":
            try:
                on_phase("separating-drums")
                output_dir = work / "drum-hq"
                paths = run_separator(normalized, output_dir, model_root, model=selected.model)
                found = _collect_drum(paths, output_dir)
                required = {"kick", "snare", "hihat", "toms"}
                if not required.issubset(found):
                    raise RuntimeError("MDX23C DrumSep did not return the expected drum families")
                files = [(kind, found[kind]) for kind in ("kick", "snare", "hihat", "cymbals", "toms") if kind in found]
                on_phase("validating")
                published = _publish_validated(job_dir, source_info, files)
                return selected.model or "MDX23C DrumSep", published, "hq"
            except Exception:
                selected = drum_profile("standard")
                fallback = True

        on_phase("separating-drums")
        output_dir = work / "drum-standard"
        paths = _run_rule_based_drums(normalized, output_dir)
        found = _collect_drum(paths, output_dir)
        required = {"kick", "snare", "hihat"}
        if not required.issubset(found):
            raise RuntimeError("Standard drum splitter did not return kick/snare/hi-hat")
        files = [(kind, found[kind]) for kind in ("kick", "snare", "hihat", "cymbals", "toms") if kind in found]
        on_phase("validating")
        published = _publish_validated(job_dir, source_info, files)
        return "fallback:drumsep" if fallback else "drumsep", published, "standard-fallback" if fallback else "standard"
    finally:
        shutil.rmtree(work, ignore_errors=True)
        normalized.unlink(missing_ok=True)
