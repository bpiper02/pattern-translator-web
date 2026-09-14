from __future__ import annotations

import shutil
from pathlib import Path
from typing import Callable


def resolve_audio_separator_executable(
    python_executable: str,
    *,
    which: Callable[[str], str | None] = shutil.which,
) -> str:
    """Resolve audio-separator from the same Python environment as FastAPI.

    Virtual environments place console scripts beside their Python executable
    (Scripts/ on Windows, bin/ on POSIX). Prefer that exact environment so the
    backend does not depend on the parent Node/terminal PATH.
    """
    scripts_dir = Path(python_executable).resolve().parent
    for name in ("audio-separator.exe", "audio-separator"):
        candidate = scripts_dir / name
        if candidate.is_file():
            return str(candidate)

    path_hit = which("audio-separator")
    if path_hit:
        return path_hit

    raise RuntimeError(
        "audio-separator package is importable, but its console script could not "
        f"be found beside Python ({python_executable}) or on PATH"
    )
