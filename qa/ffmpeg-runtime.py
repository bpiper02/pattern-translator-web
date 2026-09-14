from __future__ import annotations

import os
import tempfile
from pathlib import Path

from backend.ffmpeg_runtime import materialize_ffmpeg


with tempfile.TemporaryDirectory() as temp_root:
    root = Path(temp_root)
    source = root / "bundled-ffmpeg"
    runtime = root / "runtime"
    source.write_bytes(b"fake-ffmpeg-binary-v1")

    original_path = os.environ.get("PATH", "")
    try:
        target = materialize_ffmpeg(source, runtime)
        assert target.is_file(), "materialized ffmpeg must exist"
        assert target.read_bytes() == source.read_bytes(), "runtime ffmpeg must match bundled source"
        assert os.environ.get("PATH", "").split(os.pathsep)[0] == str(runtime.resolve()), "runtime directory must lead PATH"

        # Idempotent reruns should keep one target and should refresh when the
        # bundled binary changes size (e.g. dependency upgrade).
        same_target = materialize_ffmpeg(source, runtime)
        assert same_target == target
        source.write_bytes(b"fake-ffmpeg-binary-version-two-is-longer")
        refreshed = materialize_ffmpeg(source, runtime)
        assert refreshed == target
        assert refreshed.read_bytes() == source.read_bytes(), "changed bundled ffmpeg must refresh runtime copy"
    finally:
        os.environ["PATH"] = original_path

print("FFMPEG RUNTIME REGRESSION: PASS")
