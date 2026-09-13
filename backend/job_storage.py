from __future__ import annotations

import shutil
import time
from pathlib import Path


def prune_job_directories(
    root: Path,
    *,
    ttl_seconds: int,
    max_jobs: int,
    now: float | None = None,
) -> list[str]:
    """Remove expired jobs, then cap the remaining store by oldest mtime.

    The splitter job directory is temporary cache material, not durable project
    storage. `max_jobs=0` is valid when a caller wants to reserve all capacity
    for a job it is about to create.
    """
    if ttl_seconds < 0:
        raise ValueError("ttl_seconds must be non-negative")
    if max_jobs < 0:
        raise ValueError("max_jobs must be non-negative")

    root.mkdir(parents=True, exist_ok=True)
    current_time = time.time() if now is None else now
    removed: list[str] = []
    surviving: list[tuple[float, Path]] = []

    for path in root.iterdir():
        if not path.is_dir():
            continue
        try:
            modified = path.stat().st_mtime
        except FileNotFoundError:
            continue

        expired = ttl_seconds > 0 and current_time - modified > ttl_seconds
        if expired:
            shutil.rmtree(path, ignore_errors=True)
            removed.append(path.name)
        else:
            surviving.append((modified, path))

    surviving.sort(key=lambda item: item[0], reverse=True)
    for _, path in surviving[max_jobs:]:
        shutil.rmtree(path, ignore_errors=True)
        removed.append(path.name)

    return removed
