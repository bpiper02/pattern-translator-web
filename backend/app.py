from __future__ import annotations

import subprocess
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

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

app = FastAPI(title="Pattern Translator Splitter", version="0.2")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def safe_suffix(filename: str | None) -> str:
    suffix = Path(filename or "input.wav").suffix.lower()
    return suffix if suffix in {".wav", ".mp3", ".m4a", ".flac", ".ogg"} else ".wav"


def public_url(job_id: str, path: Path) -> str:
    return f"http://127.0.0.1:8788/files/{job_id}/{path.name}"


def response_for(job_id: str, files: list[tuple[str, Path]], *, profile: str, engine: str) -> dict:
    labels = {
        "drums": "DRUMS",
        "bass": "BASS",
        "vocals": "VOCALS",
        "other": "OTHER",
        "kick": "KICK",
        "snare": "SNARE",
        "hihat": "HI-HAT",
        "cymbals": "CYMBALS",
        "toms": "TOMS",
    }
    return {
        "jobId": job_id,
        "profile": profile,
        "engine": engine,
        "stems": [
            {
                "kind": kind,
                "label": labels[kind],
                "url": public_url(job_id, path),
                "fileName": path.name,
            }
            for kind, path in files
        ],
    }


async def save_upload(upload: UploadFile, job_dir: Path) -> Path:
    input_path = job_dir / f"input{safe_suffix(upload.filename)}"
    with input_path.open("wb") as target:
        while chunk := await upload.read(1024 * 1024):
            target.write(chunk)
    await upload.close()
    if input_path.stat().st_size == 0:
        raise HTTPException(status_code=400, detail="Uploaded audio file was empty")
    return input_path


def run_audio_separator(input_path: Path, output_dir: Path, model: str) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        "audio-separator",
        str(input_path),
        "--model_filename",
        model,
        "--output_format",
        "WAV",
        "--output_dir",
        str(output_dir),
        "--model_file_dir",
        str(MODEL_ROOT),
    ]
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
    separate(str(input_path), output_dir=str(output_dir), enhanced=True)
    return list(output_dir.rglob("*.wav"))


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "fullProfiles": ["balanced", "hq"],
        "drumProfiles": ["standard", "hq"],
    }


@app.post("/split/full")
async def split_full(file: UploadFile = File(...), profile: str = "balanced") -> dict:
    try:
        selected = full_mix_profile(profile)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    job_id = uuid.uuid4().hex
    job_dir = DATA_ROOT / job_id
    input_path = await save_upload(file, job_dir)

    try:
        if selected.vocal_model:
            pair_paths = run_audio_separator(input_path, job_dir / "vocal_refine", selected.vocal_model)
            pair = collect_pair(pair_paths)
            if "vocals" not in pair or "instrumental" not in pair:
                raise RuntimeError("HQ vocal separator did not produce both vocals and instrumental")
            broad_paths = run_audio_separator(pair["instrumental"], job_dir / "broad", selected.broad_model)
            broad = collect_broad(broad_paths)
            found = {kind: path for kind, path in broad.items() if kind in {"drums", "bass", "other"}}
            found["vocals"] = pair["vocals"]
            engine = f"{selected.vocal_model} -> {selected.broad_model}"
        else:
            found = collect_broad(run_audio_separator(input_path, job_dir / "broad", selected.broad_model))
            engine = selected.broad_model
    except RuntimeError as exc:
        if profile != "hq":
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        fallback = full_mix_profile("balanced")
        try:
            found = collect_broad(run_audio_separator(input_path, job_dir / "broad_fallback", fallback.broad_model))
            engine = f"fallback:{fallback.broad_model}"
            profile = "balanced-fallback"
        except RuntimeError as fallback_exc:
            raise HTTPException(status_code=500, detail=str(fallback_exc)) from fallback_exc

    ordered = [(kind, found[kind]) for kind in ("drums", "bass", "vocals", "other") if kind in found]
    if len(ordered) < 3:
        raise HTTPException(status_code=500, detail="Separator finished but too few recognizable stems were produced")
    return response_for(job_id, ordered, profile=profile, engine=engine)


@app.post("/split/drums")
async def split_drums(file: UploadFile = File(...), profile: str = "hq") -> dict:
    try:
        selected = drum_profile(profile)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    job_id = uuid.uuid4().hex
    job_dir = DATA_ROOT / job_id
    output_dir = job_dir / "drums"
    output_dir.mkdir(parents=True, exist_ok=True)
    input_path = await save_upload(file, job_dir)

    engine = "drumsep"
    try:
        if selected.model:
            paths = run_audio_separator(input_path, output_dir / "mdx23c", selected.model)
            engine = selected.model
        else:
            paths = run_rule_based_drums(input_path, output_dir / "rule_based")
    except Exception as exc:
        if not selected.fallback_rule_based or not selected.model:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        try:
            paths = run_rule_based_drums(input_path, output_dir / "fallback")
            engine = "fallback:drumsep"
            profile = "standard-fallback"
        except Exception as fallback_exc:
            raise HTTPException(status_code=500, detail=str(fallback_exc)) from fallback_exc

    found = collect_drum(paths, output_dir)
    ordered = [(kind, found[kind]) for kind in ("kick", "snare", "hihat", "cymbals", "toms") if kind in found]
    if not ordered:
        raise HTTPException(status_code=500, detail="Drum separator finished but no recognizable substems were produced")
    return response_for(job_id, ordered, profile=profile, engine=engine)


@app.get("/files/{job_id}/{file_name}")
def serve_file(job_id: str, file_name: str) -> FileResponse:
    if not job_id.isalnum() or Path(file_name).name != file_name:
        raise HTTPException(status_code=400, detail="Invalid file path")

    job_dir = DATA_ROOT / job_id
    matches = list(job_dir.rglob(file_name))
    if not matches:
        raise HTTPException(status_code=404, detail="Stem not found")
    return FileResponse(matches[0], media_type="audio/wav", filename=file_name)
