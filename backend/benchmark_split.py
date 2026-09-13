from __future__ import annotations

import argparse
import shutil
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from backend.app import collect_broad, collect_drum, collect_pair, run_audio_separator, run_rule_based_drums
from backend.separation_profiles import drum_profile, full_mix_profile

FULL_KINDS = ("drums", "bass", "vocals", "other")
DRUM_KINDS = ("kick", "snare", "hihat", "cymbals", "toms")


def read_audio(path: Path) -> tuple[np.ndarray, int]:
    audio, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    return audio, sample_rate


def write_mix(paths: list[Path], output_path: Path) -> None:
    loaded = [read_audio(path) for path in paths]
    sample_rates = {sample_rate for _, sample_rate in loaded}
    if len(sample_rates) != 1:
        raise RuntimeError(f"Ground-truth stems must share one sample rate, got {sorted(sample_rates)}")
    channels = max(audio.shape[1] for audio, _ in loaded)
    frames = max(audio.shape[0] for audio, _ in loaded)
    mix = np.zeros((frames, channels), dtype=np.float32)
    for audio, _ in loaded:
        if audio.shape[1] == 1 and channels == 2:
            audio = np.repeat(audio, 2, axis=1)
        mix[: audio.shape[0], : audio.shape[1]] += audio
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    if peak > 1.0:
        mix /= peak
    sf.write(output_path, mix, next(iter(sample_rates)), subtype="PCM_24")


def si_sdr(reference: np.ndarray, estimate: np.ndarray) -> float:
    frames = min(reference.shape[0], estimate.shape[0])
    channels = min(reference.shape[1], estimate.shape[1])
    reference = reference[:frames, :channels].astype(np.float64).reshape(-1)
    estimate = estimate[:frames, :channels].astype(np.float64).reshape(-1)
    reference -= reference.mean()
    estimate -= estimate.mean()
    denom = float(np.dot(reference, reference))
    if denom <= 1e-12:
        return float("nan")
    scale = float(np.dot(estimate, reference)) / denom
    target = scale * reference
    noise = estimate - target
    return 10.0 * np.log10((np.dot(target, target) + 1e-12) / (np.dot(noise, noise) + 1e-12))


def score_outputs(truth_dir: Path, outputs: dict[str, Path], kinds: tuple[str, ...]) -> dict[str, float]:
    scores: dict[str, float] = {}
    for kind in kinds:
        truth_path = truth_dir / f"{kind}.wav"
        output_path = outputs.get(kind)
        if not truth_path.exists() or output_path is None:
            continue
        truth, truth_sr = read_audio(truth_path)
        estimate, estimate_sr = read_audio(output_path)
        if truth_sr != estimate_sr:
            raise RuntimeError(f"{kind}: truth is {truth_sr} Hz but estimate is {estimate_sr} Hz")
        scores[kind] = si_sdr(truth, estimate)
    return scores


def print_scores(label: str, scores: dict[str, float]) -> None:
    values = [value for value in scores.values() if np.isfinite(value)]
    mean = sum(values) / len(values) if values else float("nan")
    detail = "  ".join(f"{kind}={value:.2f}dB" for kind, value in scores.items())
    print(f"{label:14s} mean={mean:.2f}dB  {detail}")


def benchmark_full(truth_dir: Path, work: Path) -> None:
    required = [truth_dir / f"{kind}.wav" for kind in FULL_KINDS]
    missing = [path.name for path in required if not path.exists()]
    if missing:
        raise RuntimeError(f"Missing full-mix truth stems: {', '.join(missing)}")
    mix_path = work / "truth-mix.wav"
    write_mix(required, mix_path)

    balanced = full_mix_profile("balanced")
    balanced_outputs = collect_broad(
        run_audio_separator(mix_path, work / "full-balanced", model=balanced.broad_model)
    )
    print_scores("FULL BALANCED", score_outputs(truth_dir, balanced_outputs, FULL_KINDS))

    hq = full_mix_profile("hq")
    pair = collect_pair(
        run_audio_separator(
            mix_path,
            work / "hq-vocals",
            ensemble_preset=hq.vocal_ensemble_preset,
        )
    )
    if "vocals" not in pair or "instrumental" not in pair:
        raise RuntimeError("HQ ensemble did not return vocals + instrumental")
    broad = collect_broad(
        run_audio_separator(pair["instrumental"], work / "hq-broad", model=hq.broad_model)
    )
    hq_outputs = {kind: path for kind, path in broad.items() if kind in {"drums", "bass", "other"}}
    hq_outputs["vocals"] = pair["vocals"]
    print_scores("FULL HQ", score_outputs(truth_dir, hq_outputs, FULL_KINDS))


def benchmark_drums(truth_dir: Path, work: Path) -> None:
    existing_truth = [truth_dir / f"{kind}.wav" for kind in DRUM_KINDS if (truth_dir / f"{kind}.wav").exists()]
    if len(existing_truth) < 3:
        raise RuntimeError("Drum truth directory needs at least three of kick/snare/hihat/cymbals/toms.wav")
    mix_path = work / "truth-drums.wav"
    write_mix(existing_truth, mix_path)

    standard_paths = run_rule_based_drums(mix_path, work / "drums-standard")
    standard_outputs = collect_drum(standard_paths, work / "drums-standard")
    print_scores("DRUM STANDARD", score_outputs(truth_dir, standard_outputs, DRUM_KINDS))

    hq = drum_profile("hq")
    if not hq.model:
        raise RuntimeError("HQ drum profile has no model")
    hq_paths = run_audio_separator(mix_path, work / "drums-hq", model=hq.model)
    hq_outputs = collect_drum(hq_paths, work / "drums-hq")
    print_scores("DRUM HQ", score_outputs(truth_dir, hq_outputs, DRUM_KINDS))


def main() -> None:
    parser = argparse.ArgumentParser(description="Objective Pattern Translator separator bakeoff using known ground-truth WAV stems.")
    parser.add_argument("kind", choices=["full", "drums"])
    parser.add_argument("truth_dir", type=Path, help="Directory containing named ground-truth WAV stems")
    parser.add_argument("--keep", type=Path, help="Keep generated mixes/outputs in this directory")
    args = parser.parse_args()

    if args.keep:
        args.keep.mkdir(parents=True, exist_ok=True)
        work = args.keep
        cleanup = False
    else:
        work = Path(tempfile.mkdtemp(prefix="pattern-translator-bakeoff-"))
        cleanup = True

    try:
        if args.kind == "full":
            benchmark_full(args.truth_dir, work)
        else:
            benchmark_drums(args.truth_dir, work)
        print(f"outputs: {work}")
    finally:
        if cleanup:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
