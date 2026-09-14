from __future__ import annotations

import gc
import logging
import threading
from pathlib import Path
from typing import Callable, Protocol

import soundfile as sf

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
    ensure_ffmpeg_runtime()
    from audio_separator.separator import Separator
    return Separator(**kwargs)


def _assert_engine_input(path: Path) -> None:
    """The separator engine only accepts decoded PCM WAV material.

    Codec/container handling belongs to the ingest layer. Keeping this guard at
    the engine boundary makes the old MP3-subtype-to-WAV export failure
    impossible even if a future caller bypasses the normal pipeline.
    """
    path = Path(path)
    if path.suffix.lower() != ".wav":
        raise ValueError("Separator engine input must be normalized PCM WAV")
    try:
        info = sf.info(str(path))
    except Exception as exc:
        raise ValueError(f"Separator engine input is not decodable WAV: {exc}") from exc
    subtype = str(info.subtype or "")
    if not subtype.startswith("PCM_"):
        raise ValueError(f"Separator engine input must use PCM WAV, got {subtype or 'unknown subtype'}")
    if info.frames <= 0 or info.channels <= 0 or info.samplerate <= 0:
        raise ValueError("Separator engine input is empty or invalid")


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
    """Run audio-separator behind a strict PCM-WAV engine boundary."""
    if bool(model) == bool(ensemble_preset):
        raise ValueError("Specify exactly one separator model or ensemble preset")
    if demucs_shifts is not None and demucs_shifts < 0:
        raise ValueError("Demucs shifts cannot be negative")

    _assert_engine_input(input_path)
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
        # Every engine input is PCM WAV now, so audio-separator's soundfile
        # writer can safely preserve the PCM subtype. It avoids the extra pydub
        # conversion/memory overhead while retaining bounded-memory output.
        "use_soundfile": True,
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
            raise RuntimeError(f"{type(exc).__name__}: {exc}") from exc
        finally:
            separator = None
            gc.collect()
