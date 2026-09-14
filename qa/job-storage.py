from __future__ import annotations

import os
import tempfile
from pathlib import Path

from backend.job_storage import prune_job_directories


def make_job(root: Path, name: str, modified: float, *, manifest_modified: float | None = None) -> None:
    path = root / name
    path.mkdir()
    (path / "marker.txt").write_text(name, encoding="utf-8")
    os.utime(path, (modified, modified))
    if manifest_modified is not None:
        manifest = path / "job.json"
        manifest.write_text("{}", encoding="utf-8")
        os.utime(manifest, (manifest_modified, manifest_modified))


with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    make_job(root, "expired", 10)
    make_job(root, "old", 80)
    make_job(root, "middle", 90)
    make_job(root, "new", 99)
    # Simulates a long-running model job whose directory itself looks ancient.
    make_job(root, "active", 1)
    # Manifest freshness should outrank an old directory mtime.
    make_job(root, "manifest-fresh", 1, manifest_modified=98)
    (root / "ignore.txt").write_text("not a job", encoding="utf-8")

    removed = prune_job_directories(
        root,
        ttl_seconds=50,
        max_jobs=3,
        now=100,
        protected_names={"active"},
    )
    assert "expired" in removed, removed
    assert "old" in removed, removed
    assert (root / "active").is_dir(), "active job must never be pruned"
    assert (root / "manifest-fresh").is_dir(), "fresh manifest should protect cached job from TTL"
    survivors = sorted(path.name for path in root.iterdir() if path.is_dir())
    assert survivors == ["active", "manifest-fresh", "middle", "new"], survivors
    assert (root / "ignore.txt").exists()

    # Running cleanup twice should be idempotent.
    second = prune_job_directories(
        root,
        ttl_seconds=50,
        max_jobs=3,
        now=100,
        protected_names={"active"},
    )
    assert second == [], second

    # Zero inactive capacity still cannot delete a protected active job.
    zero = prune_job_directories(
        root,
        ttl_seconds=50,
        max_jobs=0,
        now=100,
        protected_names={"active"},
    )
    assert sorted(zero) == ["manifest-fresh", "middle", "new"], zero
    assert sorted(path.name for path in root.iterdir() if path.is_dir()) == ["active"]

    try:
        prune_job_directories(root, ttl_seconds=-1, max_jobs=2, now=100)
    except ValueError:
        pass
    else:
        raise AssertionError("negative TTL should fail")

    try:
        prune_job_directories(root, ttl_seconds=50, max_jobs=-1, now=100)
    except ValueError:
        pass
    else:
        raise AssertionError("negative max_jobs should fail")

print("JOB STORAGE REGRESSION: PASS")
