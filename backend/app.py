from __future__ import annotations

import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

APP_ROOT = Path(__file__).resolve().parent
DATA_ROOT = APP_ROOT / "data" / "jobs"
MODEL_ROOT = APP_ROOT / "data" / "models"
DATA_ROOT.mkdir(parents=True, exist_ok=True)
MODEL_ROOT.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Pattern Translator Splitter", version="0.1")
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


def classify_broad(path: Path) -> str | None:
    name = path.stem.lower()
    for kind in ("drums", "bass", "vocals", "other"):
        if kind in name:
            return kind
    return None


def classify_drum(path: Path) -> str | None:
    name = path.stem.lower().replace("-", "_")
    aliases = {
        "kick": ("kick", "bd"),
        "snare": ("snare", "sd"),
        "hihat": ("hihat", "hi_hat", "hat"),
        "cymbals": ("cymbal", "cymbals", "ride", "crash"),
        "toms": ("tom", "toms"),
    }
    for kind, tokens in aliases.items():
        if any(token in name for token in tokens):
            return kind
    return None


def response_for(job_id: str, files: list[tuple[str, Path]]) -> dict:
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


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/split/full")
async def split_full(file: UploadFile = File(...)) -> dict:
    job_id = uuid.uuid4().hex
    job_dir = DATA_ROOT / job_id
    output_dir = job_dir / "broad"
    output_dir.mkdir(parents=True, exist_ok=True)
    input_path = await save_upload(file, job_dir)

    command = [
        "audio-separator",
        str(input_path),
        "--model_filename",
        "htdemucs_ft.yaml",
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
        raise HTTPException(status_code=503, detail="audio-separator is not installed in the splitter environment") from exc

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "audio-separator failed")[-2000:]
        raise HTTPException(status_code=500, detail=detail)

    found: dict[str, Path] = {}
    for path in output_dir.rglob("*.wav"):
        kind = classify_broad(path)
        if kind and kind not in found:
            found[kind] = path

    ordered = [(kind, found[kind]) for kind in ("drums", "bass", "vocals", "other") if kind in found]
    if not ordered:
        raise HTTPException(status_code=500, detail="Separator finished but no recognizable stems were produced")

    return response_for(job_id, ordered)


@app.post("/split/drums")
async def split_drums(file: UploadFile = File(...)) -> dict:
    job_id = uuid.uuid4().hex
    job_dir = DATA_ROOT / job_id
    output_dir = job_dir / "drums"
    output_dir.mkdir(parents=True, exist_ok=True)
    input_path = await save_upload(file, job_dir)

    try:
        from drumsep import separate
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="drumsep is not installed in the splitter environment") from exc

    try:
        separate(str(input_path), output_dir=str(output_dir), enhanced=True)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"drumsep failed: {exc}") from exc

    found: dict[str, Path] = {}
    for path in output_dir.rglob("*.wav"):
        kind = classify_drum(path)
        if kind and kind not in found:
            found[kind] = path

    ordered = [(kind, found[kind]) for kind in ("kick", "snare", "hihat", "cymbals", "toms") if kind in found]
    if not ordered:
        raise HTTPException(status_code=500, detail="drumsep finished but no recognizable drum substems were produced")

    return response_for(job_id, ordered)


@app.get("/files/{job_id}/{file_name}")
def serve_file(job_id: str, file_name: str) -> FileResponse:
    if not job_id.isalnum() or Path(file_name).name != file_name:
        raise HTTPException(status_code=400, detail="Invalid file path")

    job_dir = DATA_ROOT / job_id
    matches = list(job_dir.rglob(file_name))
    if not matches:
        raise HTTPException(status_code=404, detail="Stem not found")
    return FileResponse(matches[0], media_type="audio/wav", filename=file_name)
