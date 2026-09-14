from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

JobStatus = Literal["queued", "running", "complete", "failed"]


@dataclass
class SplitJobState:
    job_id: str
    mode: str
    profile: str
    status: JobStatus = "queued"
    phase: str = "queued"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    engine: str | None = None
    error: str | None = None
    stems: list[dict[str, str]] = field(default_factory=list)


def manifest_path(job_dir: Path) -> Path:
    return Path(job_dir) / "job.json"


def write_job_state(job_dir: Path, state: SplitJobState) -> None:
    job_dir = Path(job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)
    state.updated_at = time.time()
    target = manifest_path(job_dir)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text(json.dumps(asdict(state), indent=2, sort_keys=True), encoding="utf-8")
    os.replace(temporary, target)


def read_job_state(job_dir: Path) -> SplitJobState | None:
    target = manifest_path(job_dir)
    if not target.is_file():
        return None
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
        return SplitJobState(**payload)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def set_job_phase(job_dir: Path, state: SplitJobState, phase: str) -> None:
    state.status = "running"
    state.phase = phase
    state.error = None
    write_job_state(job_dir, state)


def complete_job(
    job_dir: Path,
    state: SplitJobState,
    *,
    engine: str,
    stems: list[dict[str, str]],
) -> None:
    state.status = "complete"
    state.phase = "complete"
    state.engine = engine
    state.error = None
    state.stems = stems
    write_job_state(job_dir, state)


def fail_job(job_dir: Path, state: SplitJobState, error: Exception | str) -> None:
    state.status = "failed"
    state.phase = "failed"
    state.error = str(error)
    write_job_state(job_dir, state)
