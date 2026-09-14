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
    protected_names: set[str] | None = None,
) -> list[str]:
    """Remove expired cache jobs and cap inactive survivors.

    Active job ids can be protected explicitly. Protected directories never
    count against ``max_jobs`` and are never removed by TTL/cap pruning.
    """
    if ttl_seconds < 0:
        raise ValueError("ttl_seconds must be non-negative")
    if max_jobs < 0:
        raise ValueError("max_jobs must be non-negative")

    root.mkdir(parents=True, exist_ok=True)
    current_time = time.time() if now is None else now
    protected = protected_names or set()
    removed: list[str] = []
    surviving: list[tuple[float, Path]] = []

    for path in root.iterdir():
        if not path.is_dir() or path.name in protected:
            continue
        try:
            modified = path.stat().st_mtime
            manifest = path / "job.json"
            if manifest.is_file():
                # The manifest is updated for every phase transition and is a
                # much better freshness signal than directory mtime.
                modified = max(modified, manifest.stat().st_mtime)
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
