from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from backend.job_storage import prune_job_directories
from backend.separation_profiles import drum_profile, full_mix_profile
from backend.split_jobs import (
    SplitJobState,
    complete_job,
    fail_job,
    read_job_state,
    set_job_phase,
    write_job_state,
)
from backend.split_pipeline import PIPELINE_REVISION, run_drum_pipeline, run_full_pipeline

APP_ROOT = Path(__file__).resolve().parent
DATA_ROOT = APP_ROOT / "data" / "jobs"
INCOMING_ROOT = APP_ROOT / "data" / "incoming"
MODEL_ROOT = APP_ROOT / "data" / "models"
DATA_ROOT.mkdir(parents=True, exist_ok=True)
INCOMING_ROOT.mkdir(parents=True, exist_ok=True)
MODEL_ROOT.mkdir(parents=True, exist_ok=True)

JOB_TTL_SECONDS = max(0, int(os.getenv("PT_JOB_TTL_SECONDS", "86400")))
MAX_JOB_DIRS = max(1, int(os.getenv("PT_MAX_JOB_DIRS", "30")))
MAX_UPLOAD_BYTES = max(1, int(os.getenv("PT_MAX_UPLOAD_BYTES", str(512 * 1024 * 1024))))
INCOMING_TTL_SECONDS = max(60, int(os.getenv("PT_INCOMING_TTL_SECONDS", "3600")))
API_REVISION = "split-runtime-v4-jobs"

app = FastAPI(title="Chopsticks Splitter", version="0.5")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_ACTIVE_TASKS: dict[str, asyncio.Task[None]] = {}
_JOB_CREATE_LOCK = asyncio.Lock()
_JOB_RUN_SEMAPHORE = asyncio.Semaphore(1)

_LABELS = {
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


def safe_suffix(filename: str | None) -> str:
    suffix = Path(filename or "input.wav").suffix.lower()
    return suffix if suffix in {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".aiff"} else ".wav"


def public_url(job_id: str, file_name: str) -> str:
    return f"/files/{job_id}/{file_name}"


def _job_payload(state: SplitJobState) -> dict:
    return {
        "jobId": state.job_id,
        "mode": state.mode,
        "profile": state.profile,
        "status": state.status,
        "phase": state.phase,
        "engine": state.engine,
        "error": state.error,
        "stems": [
            {
                **stem,
                "url": public_url(state.job_id, stem["fileName"]),
            }
            for stem in state.stems
        ],
    }


def _completed_job_is_usable(job_dir: Path, state: SplitJobState) -> bool:
    if state.status != "complete" or not state.engine or not state.stems:
        return False
    expected = {"drums", "bass", "vocals", "other"} if state.mode == "full" else {"kick", "snare", "hihat"}
    kinds = {stem.get("kind") for stem in state.stems}
    if not expected.issubset(kinds):
        return False
    for stem in state.stems:
        file_name = stem.get("fileName")
        if not file_name:
            return False
        path = job_dir / file_name
        try:
            if not path.is_file() or path.stat().st_size <= 44:
                return False
        except OSError:
            return False
    return True


async def _save_incoming(upload: UploadFile) -> tuple[Path, str, Path]:
    # Clean only abandoned upload staging dirs; active jobs have already moved
    # into DATA_ROOT and are protected separately.
    prune_job_directories(
        INCOMING_ROOT,
        ttl_seconds=INCOMING_TTL_SECONDS,
        max_jobs=10,
    )
    incoming_id = uuid.uuid4().hex
    incoming_dir = INCOMING_ROOT / incoming_id
    incoming_dir.mkdir(parents=True, exist_ok=False)
    input_path = incoming_dir / f"input{safe_suffix(upload.filename)}"
    digest = hashlib.sha256()
    total = 0
    try:
        with input_path.open("wb") as target:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Uploaded audio file is too large")
                digest.update(chunk)
                target.write(chunk)
    except BaseException:
        shutil.rmtree(incoming_dir, ignore_errors=True)
        raise
    finally:
        await upload.close()
    if total == 0 or not input_path.is_file():
        shutil.rmtree(incoming_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Uploaded audio file was empty")
    return incoming_dir, digest.hexdigest(), input_path


def _job_id(mode: str, profile: str, content_hash: str) -> str:
    material = f"{PIPELINE_REVISION}|{mode}|{profile}|{content_hash}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:32]


def _stems_payload(files: list[tuple[str, Path]]) -> list[dict[str, str]]:
    return [
        {
            "kind": kind,
            "label": _LABELS[kind],
            "fileName": path.name,
        }
        for kind, path in files
    ]


async def _run_job(job_dir: Path, state: SplitJobState, input_path: Path) -> None:
    def phase(name: str) -> None:
        set_job_phase(job_dir, state, name)

    try:
        async with _JOB_RUN_SEMAPHORE:
            if state.mode == "full":
                engine, files, resolved_profile = await asyncio.to_thread(
                    run_full_pipeline,
                    input_path,
                    job_dir,
                    MODEL_ROOT,
                    state.profile,
                    on_phase=phase,
                )
            else:
                engine, files, resolved_profile = await asyncio.to_thread(
                    run_drum_pipeline,
                    input_path,
                    job_dir,
                    MODEL_ROOT,
                    state.profile,
                    on_phase=phase,
                )
        state.profile = resolved_profile
        complete_job(job_dir, state, engine=engine, stems=_stems_payload(files))
        input_path.unlink(missing_ok=True)
    except Exception as exc:
        fail_job(job_dir, state, exc)
    finally:
        _ACTIVE_TASKS.pop(state.job_id, None)


async def _start_job(file: UploadFile, *, mode: str, profile: str) -> JSONResponse:
    try:
        if mode == "full":
            full_mix_profile(profile)
        else:
            drum_profile(profile)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    incoming_dir, content_hash, incoming_path = await _save_incoming(file)
    job_id = _job_id(mode, profile, content_hash)
    job_dir = DATA_ROOT / job_id

    try:
        async with _JOB_CREATE_LOCK:
            existing = read_job_state(job_dir) if job_dir.exists() else None
            if existing and _completed_job_is_usable(job_dir, existing):
                shutil.rmtree(incoming_dir, ignore_errors=True)
                return JSONResponse(_job_payload(existing), status_code=200)
            if existing and existing.status in {"queued", "running"} and job_id in _ACTIVE_TASKS:
                shutil.rmtree(incoming_dir, ignore_errors=True)
                return JSONResponse(_job_payload(existing), status_code=202)

            if job_dir.exists():
                shutil.rmtree(job_dir, ignore_errors=True)
            prune_job_directories(
                DATA_ROOT,
                ttl_seconds=JOB_TTL_SECONDS,
                max_jobs=max(0, MAX_JOB_DIRS - 1),
                protected_names=set(_ACTIVE_TASKS),
            )
            os.replace(incoming_dir, job_dir)
            input_path = job_dir / incoming_path.name
            state = SplitJobState(job_id=job_id, mode=mode, profile=profile)
            write_job_state(job_dir, state)
            task = asyncio.create_task(_run_job(job_dir, state, input_path))
            _ACTIVE_TASKS[job_id] = task
            return JSONResponse(_job_payload(state), status_code=202)
    except BaseException:
        # If ownership was never moved to DATA_ROOT, do not leak incoming temp
        # material when request/task setup fails.
        if incoming_dir.exists():
            shutil.rmtree(incoming_dir, ignore_errors=True)
        raise


@app.get("/")
def root() -> dict:
    return {"name": "Chopsticks Splitter", "ok": True, "revision": API_REVISION}


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "revision": API_REVISION,
        "pipelineRevision": PIPELINE_REVISION,
        "jobApi": True,
        "fullProfiles": ["balanced", "hq"],
        "drumProfiles": ["standard", "hq"],
        "jobTtlSeconds": JOB_TTL_SECONDS,
        "maxJobs": MAX_JOB_DIRS,
        "maxUploadBytes": MAX_UPLOAD_BYTES,
    }


@app.post("/split/full")
async def split_full(file: UploadFile = File(...), profile: str = "balanced") -> JSONResponse:
    return await _start_job(file, mode="full", profile=profile)


@app.post("/split/drums")
async def split_drums(file: UploadFile = File(...), profile: str = "hq") -> JSONResponse:
    return await _start_job(file, mode="drums", profile=profile)


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    if not job_id or any(char not in "0123456789abcdef" for char in job_id.lower()) or len(job_id) != 32:
        raise HTTPException(status_code=404, detail="Job not found")
    job_dir = DATA_ROOT / job_id
    state = read_job_state(job_dir)
    if state is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if state.status in {"queued", "running"} and job_id not in _ACTIVE_TASKS:
        fail_job(job_dir, state, "Split was interrupted by a backend restart. Retry the source.")
    if state.status == "complete" and not _completed_job_is_usable(job_dir, state):
        fail_job(job_dir, state, "Cached split outputs are missing or incomplete. Retry the source.")
    return _job_payload(state)


@app.get("/files/{job_id}/{file_name}")
def get_file(job_id: str, file_name: str) -> FileResponse:
    job_dir = DATA_ROOT / job_id
    state = read_job_state(job_dir)
    if state is None or not _completed_job_is_usable(job_dir, state):
        raise HTTPException(status_code=404, detail="File not found")
    allowed = {stem["fileName"] for stem in state.stems}
    if file_name not in allowed:
        raise HTTPException(status_code=404, detail="File not found")
    path = (job_dir / file_name).resolve()
    try:
        path.relative_to(job_dir.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="File not found") from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, media_type="audio/wav", filename=path.name)
