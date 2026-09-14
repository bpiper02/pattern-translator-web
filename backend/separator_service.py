from __future__ import annotations

import gc
import logging
import threading
from pathlib import Path
from typing import Callable, Protocol

from backend.ffmpeg_runtime import ensure_ffmpeg_runtime


class SeparatorLike(Protocol):
    def load_model(self, model_filename: str | None = None) -> None: ...
    def separate(self, audio_file_path: str, custom_output_names: dict[str, str] | None = None): ...


SeparatorFactory = Callable[..., SeparatorLike]
LOGGER = logging.getLogger(__name__)
# Local-first desktop target: one heavyweight model job at a time prevents two
# browser tabs/actions from doubling torch/onnx memory and destabilizing the PC.
_SEPARATOR_LOCK = threading.Lock()

# The library defaults Demucs to two random shifts, multiplying CPU work. Keep
# Balanced responsive and reserve extra inference for the explicit HQ model.
_DEMUCS_SHIFTS_BY_MODEL = {
    "htdemucs.yaml": 0,
    "htdemucs_ft.yaml": 1,
}


def _default_separator_factory(**kwargs) -> SeparatorLike:
    # Provision FFmpeg inside the same process that will instantiate
    # audio-separator. The package shells out to `ffmpeg` during __init__, so a
    # probe in a different process is not sufficient to make PATH correct here.
    ensure_ffmpeg_runtime()

    # Import lazily so lightweight backend policy/unit tests do not need to load
    # torch/onnx/audio-separator merely by importing this module.
    from audio_separator.separator import Separator

    return Separator(**kwargs)


def run_separator(
    input_path: Path,
    output_dir: Path,
    model_root: Path,
    *,
    model: str | None = None,
    ensemble_preset: str | None = None,
    custom_output_names: dict[str, str] | None = None,
    demucs_shifts: int | None = None,
    separator_factory: SeparatorFactory | None = None,
) -> list[Path]:
    """Run audio-separator through its supported Python API.

    Exactly one of ``model`` or ``ensemble_preset`` must be supplied. WAV
    outputs deliberately use the FFmpeg/pydub writer rather than soundfile.
    audio-separator 0.47.0 preserves an MP3 input subtype (MPEG_LAYER_III) when
    ``use_soundfile=True`` and then asks libsndfile to write that encoding into
    a WAV container, which fails only after inference has completed.
    """
    if bool(model) == bool(ensemble_preset):
        raise ValueError("Specify exactly one separator model or ensemble preset")
    if demucs_shifts is not None and demucs_shifts < 0:
        raise ValueError("Demucs shifts cannot be negative")

    output_dir.mkdir(parents=True, exist_ok=True)
    model_root.mkdir(parents=True, exist_ok=True)
    factory = separator_factory or _default_separator_factory

    effective_shifts = demucs_shifts
    if effective_shifts is None and model:
        effective_shifts = _DEMUCS_SHIFTS_BY_MODEL.get(Path(model).name)

    separator_kwargs: dict[str, object] = {
        "model_file_dir": str(model_root),
        "output_dir": str(output_dir),
        "output_format": "WAV",
        # WAV export through pydub/FFmpeg uses the detected bit depth instead of
        # trying to preserve a lossy input codec as the WAV subtype.
        "use_soundfile": False,
        "ensemble_preset": ensemble_preset,
    }
    if effective_shifts is not None:
        separator_kwargs["demucs_params"] = {
            "segment_size": "Default",
            "shifts": effective_shifts,
            "overlap": 0.25,
            "segments_enabled": True,
        }

    with _SEPARATOR_LOCK:
        separator: SeparatorLike | None = None
        try:
            separator = factory(**separator_kwargs)

            if ensemble_preset:
                # The library resolves the preset's model list internally.
                separator.load_model()
            else:
                separator.load_model(model_filename=model)

            separator.separate(str(input_path), custom_output_names or None)
            outputs = sorted(path for path in output_dir.rglob("*.wav") if path.is_file())
            if not outputs:
                raise RuntimeError("Separator completed without producing WAV stems")
            return outputs
        except Exception as exc:
            LOGGER.exception("Audio separation failed for %s", input_path)
            # Keep the HTTP-facing message concise; the full traceback is
            # retained in the backend terminal via LOGGER.exception above.
            raise RuntimeError(f"{type(exc).__name__}: {exc}") from exc
        finally:
            # Release model references promptly between local jobs. This matters
            # on memory-constrained laptops where repeated splits can otherwise
            # retain large torch/onnx objects until a later GC cycle.
            separator = None
            gc.collect()
