from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent
DEFAULT_RUNTIME_DIR = APP_ROOT / "data" / "runtime"


def _ffmpeg_name() -> str:
    return "ffmpeg.exe" if os.name == "nt" else "ffmpeg"


def _prepend_path(directory: Path) -> None:
    directory_text = str(directory.resolve())
    current = os.environ.get("PATH", "")
    entries = [entry for entry in current.split(os.pathsep) if entry]
    normalized = {os.path.normcase(os.path.abspath(entry)) for entry in entries}
    if os.path.normcase(directory_text) not in normalized:
        os.environ["PATH"] = directory_text + (os.pathsep + current if current else "")


def materialize_ffmpeg(source: Path, runtime_dir: Path = DEFAULT_RUNTIME_DIR) -> Path:
    """Expose a bundled FFmpeg binary under the conventional ffmpeg name.

    imageio-ffmpeg ships a versioned executable filename. audio-separator calls
    ``ffmpeg`` directly, so Windows cannot discover that bundled binary unless
    we give it the conventional name and put its directory on PATH.
    """
    source = Path(source).resolve()
    if not source.is_file():
        raise RuntimeError(f"Bundled FFmpeg executable does not exist: {source}")

    runtime_dir = Path(runtime_dir).resolve()
    runtime_dir.mkdir(parents=True, exist_ok=True)
    target = runtime_dir / _ffmpeg_name()

    source_stat = source.stat()
    needs_copy = True
    if target.is_file():
        try:
            needs_copy = target.stat().st_size != source_stat.st_size
        except OSError:
            needs_copy = True

    if needs_copy:
        temporary = target.with_name(target.name + ".tmp")
        try:
            shutil.copy2(source, temporary)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    if os.name != "nt":
        target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    _prepend_path(runtime_dir)
    return target


def _verify_ffmpeg(executable: Path | str) -> None:
    try:
        result = subprocess.run(
            [str(executable), "-version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=8,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError(f"FFmpeg could not start: {exc}") from exc
    if result.returncode != 0 or "ffmpeg version" not in (result.stdout or "").lower():
        detail = (result.stdout or "").strip().splitlines()
        tail = detail[-1] if detail else f"exit code {result.returncode}"
        raise RuntimeError(f"FFmpeg runtime check failed: {tail}")


def ensure_ffmpeg_runtime(runtime_dir: Path = DEFAULT_RUNTIME_DIR) -> Path:
    """Return a working FFmpeg executable and make ``ffmpeg`` PATH-resolvable.

    Prefer an already-working system FFmpeg. Otherwise use imageio-ffmpeg's
    bundled binary, materialize it under ``backend/data/runtime/ffmpeg(.exe)``,
    and prepend that directory to this process' PATH. No global OS install is
    required.
    """
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        try:
            _verify_ffmpeg(system_ffmpeg)
            return Path(system_ffmpeg).resolve()
        except RuntimeError:
            # A broken PATH entry should not prevent the bundled fallback.
            pass

    try:
        import imageio_ffmpeg
    except ImportError as exc:
        raise RuntimeError(
            "FFmpeg runtime is unavailable. Install backend requirements so "
            "imageio-ffmpeg can provide the local binary."
        ) from exc

    try:
        bundled = Path(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception as exc:
        raise RuntimeError(f"Could not locate bundled FFmpeg: {exc}") from exc

    target = materialize_ffmpeg(bundled, runtime_dir)
    _verify_ffmpeg(target)

    # Verify the exact lookup audio-separator performs.
    resolved = shutil.which("ffmpeg")
    if not resolved:
        raise RuntimeError("FFmpeg was provisioned but is still not PATH-resolvable")
    _verify_ffmpeg(resolved)
    return target
