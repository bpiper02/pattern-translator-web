from __future__ import annotations

import asyncio
import json
import os
import subprocess
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from backend.job_storage import prune_job_directories
from backend.separation_profiles import (
    classify_broad,
    classify_drum,
    classify_pair,
    drum_profile,
    full_mix_profile,
)

APP_ROOT = Path(__file__).resolve().parent
DATA_ROOT = APP_ROOT / "data" / "jobs"
MODEL_ROOT = APP_ROOT / "data" / "models"
DATA_ROOT.mkdir(parents=True, exist_ok=True)
MODEL_ROOT.mkdir(parents=True, exist_ok=True)

JOB_TTL_SECONDS = max(0, int(os.getenv("PT_JOB_TTL_SECONDS", "86400")))
MAX_JOB_DIRS = max(1, int(os.getenv("PT_MAX_JOB_DIRS", "30")))

app = FastAPI(title="Pattern Translator Splitter", version="0.3")
app.add_middleware(
    CORSMiddleware,
    # Vite will transparently move to 5174/5175/etc. when 5173 is occupied.
    # Restrict this regex to local development hosts while allowing that port
    # fallback instead of hard-coding one port and causing opaque fetch errors.
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def safe_suffix(filename: str | None) -> str:
    suffix = Path(filename or "input.wav").suffix.lower()
    return suffix if suffix in {".wav", ".mp3", ".m4a", ".flac", ".ogg"} else ".wav"


def public_url(job_id: str, path: Path) -> str:
    return f"/files/{job_id}/{path.name}"


def response_for(job_id: str, files: list[tuple[str, Path]], *, profile: str, engine: str) -> dict:
    labels = {
        "drums": "DRUMS", "bass": "BASS", "vocals": "VOCALS", "other": "OTHER",
        "kick": "KICK", "snare": "SNARE", "hihat": "HI-HAT", "cymbals": "CYMBALS", "toms": "TOMS",
    }
    return {
        "jobId": job_id,
        "profile": profile,
        "engine": engine,
        "stems": [
            {"kind": kind, "label": labels[kind], "url": public_url(job_id, path), "fileName": path.name}
            for kind, path in files
        ],
    }


def prepare_job_dir(job_id: str) -> Path:
    # Reserve one slot for the job we are about to create so the configured cap
    # is exact even immediately after creation.
    prune_job_directories(
        DATA_ROOT,
        ttl_seconds=JOB_TTL_SECONDS,
        max_jobs=max(0, MAX_JOB_DIRS - 1),
    )
    job_dir = DATA_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    return job_dir


async def save_upload(upload: UploadFile, job_dir: Path) -> Path:
    job_dir.mkdir(parents=True, exist_ok=True)
    input_path = job_dir / f"input{safe_suffix(upload.filename)}"
    with input_path.open("wb") as target:
        while chunk := await upload.read(1024 * 1024):
            target.write(chunk)
    await upload.close()
    if input_path.stat().st_size == 0:
        input_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Uploaded audio file was empty")
    return input_path


def run_audio_separator(
    input_path: Path,
    output_dir: Path,
    *,
    model: str | None = None,
    ensemble_preset: str | None = None,
    custom_output_names: dict[str, str] | None = None,
) -> list[Path]:
    if bool(model) == bool(ensemble_preset):
        raise RuntimeError("Specify exactly one separator model or ensemble preset")
    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        "audio-separator", str(input_path),
        "--output_format", "WAV",
        "--output_dir", str(output_dir),
        "--model_file_dir", str(MODEL_ROOT),
        "--use_soundfile",
    ]
    if ensemble_preset:
        command.extend(["--ensemble_preset", ensemble_preset])
    else:
        command.extend(["--model_filename", model or ""])
    if custom_output_names:
        command.extend(["--custom_output_names", json.dumps(custom_output_names, separators=(",", ":"))])
    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:
        raise RuntimeError("audio-separator is not installed in the splitter environment") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "audio-separator failed")[-2000:]
        raise RuntimeError(detail)
    return list(output_dir.rglob("*.wav"))


def collect_broad(paths: list[Path]) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for path in paths:
        kind = classify_broad(path)
        if kind and kind not in found:
            found[kind] = path
    return found


def collect_pair(paths: list[Path]) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for path in paths:
        kind = classify_pair(path)
        if kind and kind not in found:
            found[kind] = path
    return found


def mix_cymbals(paths: list[Path], output_path: Path) -> Path:
    arrays: list[np.ndarray] = []
    sample_rate: int | None = None
    max_frames = 0
    channels = 0
    for path in paths:
        audio, sr = sf.read(path, dtype="float32", always_2d=True)
        if sample_rate is None:
            sample_rate = sr
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
    sf.write(output_path, combined, sample_rate, subtype="PCM_24")
    return output_path


def collect_drum(paths: list[Path], output_dir: Path) -> dict[str, Path]:
    found: dict[str, Path] = {}
    cymbal_parts: list[Path] = []
    for path in paths:
        kind = classify_drum(path)
        if kind in {"ride", "crash"}:
            cymbal_parts.append(path)
        elif kind and kind not in found:
            found[kind] = path
    if "cymbals" not in found and cymbal_parts:
        found["cymbals"] = mix_cymbals(cymbal_parts, output_dir / "cymbals-combined.wav")
    return found


def run_rule_based_drums(input_path: Path, output_dir: Path) -> list[Path]:
    try:
        from drumsep import separate
    except ImportError as exc:
        raise RuntimeError("drumsep is not installed in the splitter environment") from exc
    output_dir.mkdir(parents=True, exist_ok=True)
    separate(str(input_path), output_dir=str(output_dir), enhanced=True)
    return list(output_dir.rglob("*.wav"))


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "fullProfiles": ["balanced", "hq"],
        "drumProfiles": ["standard", "hq"],
        "jobTtlSeconds": JOB_TTL_SECONDS,
        "maxJobs": MAX_JOB_DIRS,
    }


@app.post("/split/full")
async def split_full(file: UploadFile = File(...), profile: str = "balanced") -> dict:
    try:
        selected = full_mix_profile(profile)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    job_id = uuid.uuid4().hex
    job_dir = prepare_job_dir(job_id)
    input_path = await save_upload(file, job_dir)

    try:
        if selected["profile"] == "hq":
            try:
                pair_dir = job_dir / "vocal_pair"
                pair_paths = await asyncio.to_thread(
                    run_audio_separator,
                    input_path,
                    pair_dir,
                    ensemble_preset=selected["vocal_ensemble"],
                    custom_output_names={"Vocals": "vocals", "Instrumental": "instrumental"},
                )
                pair = collect_pair(pair_paths)
                vocals = pair.get("vocals")
                instrumental = pair.get("instrumental")
                if not vocals or not instrumental:
                    raise RuntimeError("Vocal ensemble did not return vocals + instrumental")

                broad_dir = job_dir / "instrumental_broad"
                broad_paths = await asyncio.to_thread(
                    run_audio_separator,
                    instrumental,
                    broad_dir,
                    model=selected["broad_model"],
                )
                broad = collect_broad(broad_paths)
                required = {"drums", "bass", "other"}
                if not required.issubset(broad):
                    raise RuntimeError("Instrumental separator did not return drums/bass/other")
                files = [
                    ("drums", broad["drums"]),
                    ("bass", broad["bass"]),
                    ("vocals", vocals),
                    ("other", broad["other"]),
                ]
                return response_for(
                    job_id,
                    files,
                    profile="hq",
                    engine=f"ensemble:{selected['vocal_ensemble']} -> {selected['broad_model']}",
                )
            except Exception:
                # Preserve a usable path when optional community checkpoints or
                # their transitive runtime dependencies are unavailable.
                selected = full_mix_profile("balanced")
                fallback = True
            else:
                fallback = False
        else:
            fallback = False

        broad_dir = job_dir / "broad"
        broad_paths = await asyncio.to_thread(
            run_audio_separator,
            input_path,
            broad_dir,
            model=selected["broad_model"],
        )
        broad = collect_broad(broad_paths)
        required = {"drums", "bass", "vocals", "other"}
        if not required.issubset(broad):
            raise RuntimeError("Separator did not return all broad stems")
        files = [(kind, broad[kind]) for kind in ("drums", "bass", "vocals", "other")]
        return response_for(
            job_id,
            files,
            profile="balanced-fallback" if fallback else "balanced",
            engine=f"fallback:{selected['broad_model']}" if fallback else selected["broad_model"],
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/split/drums")
async def split_drums(file: UploadFile = File(...), profile: str = "hq") -> dict:
    try:
        selected = drum_profile(profile)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    job_id = uuid.uuid4().hex
    job_dir = prepare_job_dir(job_id)
    input_path = await save_upload(file, job_dir)

    try:
        fallback = False
        if selected["profile"] == "hq":
            try:
                output_dir = job_dir / "drum_hq"
                paths = await asyncio.to_thread(
                    run_audio_separator,
                    input_path,
                    output_dir,
                    model=selected["model"],
                )
                found = collect_drum(paths, output_dir)
                required = {"kick", "snare", "hihat", "toms"}
                if not required.issubset(found):
                    raise RuntimeError("MDX23C DrumSep did not return the expected drum families")
            except Exception:
                selected = drum_profile("standard")
                fallback = True
            else:
                files = [(kind, found[kind]) for kind in ("kick", "snare", "hihat", "cymbals", "toms") if kind in found]
                return response_for(
                    job_id,
                    files,
                    profile="hq",
                    engine=selected["model"],
                )

        output_dir = job_dir / "drum_standard"
        paths = await asyncio.to_thread(run_rule_based_drums, input_path, output_dir)
        found = collect_drum(paths, output_dir)
        required = {"kick", "snare", "hihat"}
        if not required.issubset(found):
            raise RuntimeError("Standard drum splitter did not return kick/snare/hi-hat")
        files = [(kind, found[kind]) for kind in ("kick", "snare", "hihat", "cymbals", "toms") if kind in found]
        return response_for(
            job_id,
            files,
            profile="standard-fallback" if fallback else "standard",
            engine="fallback:drumsep" if fallback else "drumsep",
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/files/{job_id}/{file_name}")
def get_file(job_id: str, file_name: str) -> FileResponse:
    path = (DATA_ROOT / job_id / file_name).resolve()
    try:
        path.relative_to(DATA_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="File not found") from exc
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, media_type="audio/wav", filename=path.name)
