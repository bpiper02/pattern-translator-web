from __future__ import annotations

import os
import tempfile
from pathlib import Path

from backend.job_storage import prune_job_directories


def make_job(root: Path, name: str, modified: float) -> None:
    path = root / name
    path.mkdir()
    (path / "marker.txt").write_text(name, encoding="utf-8")
    os.utime(path, (modified, modified))


with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    make_job(root, "expired", 10)
    make_job(root, "old", 80)
    make_job(root, "middle", 90)
    make_job(root, "new", 99)
    (root / "ignore.txt").write_text("not a job", encoding="utf-8")

    removed = prune_job_directories(root, ttl_seconds=50, max_jobs=2, now=100)
    assert "expired" in removed, removed
    assert "old" in removed, removed
    assert sorted(path.name for path in root.iterdir() if path.is_dir()) == ["middle", "new"]
    assert (root / "ignore.txt").exists()

    # Running cleanup twice should be idempotent.
    second = prune_job_directories(root, ttl_seconds=50, max_jobs=2, now=100)
    assert second == [], second

    try:
        prune_job_directories(root, ttl_seconds=-1, max_jobs=2, now=100)
    except ValueError:
        pass
    else:
        raise AssertionError("negative TTL should fail")

    try:
        prune_job_directories(root, ttl_seconds=50, max_jobs=0, now=100)
    except ValueError:
        pass
    else:
        raise AssertionError("max_jobs=0 should fail")

print("JOB STORAGE REGRESSION: PASS")
