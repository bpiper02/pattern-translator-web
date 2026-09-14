from pathlib import Path
from tempfile import TemporaryDirectory
import wave

from backend.separator_service import run_separator


class FakeSeparator:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.loaded = None
        self.separated = None
        FakeSeparator.instances.append(self)

    def load_model(self, model_filename=None):
        self.loaded = model_filename

    def separate(self, audio_file_path, custom_output_names=None):
        self.separated = (audio_file_path, custom_output_names)
        output_dir = Path(self.kwargs["output_dir"])
        output_dir.mkdir(parents=True, exist_ok=True)
        names = custom_output_names or {"Vocals": "vocals", "Instrumental": "instrumental"}
        for output_name in names.values():
            (output_dir / f"{output_name}.wav").write_bytes(b"RIFFfake")
        return [f"{name}.wav" for name in names.values()]


def check(condition, label):
    if not condition:
        raise AssertionError(label)


def write_pcm_wav(path: Path, frames: int = 4410):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(44100)
        output.writeframes(b"\x00\x00" * 2 * frames)


with TemporaryDirectory() as temp:
    root = Path(temp)
    input_path = root / "normalized.wav"
    write_pcm_wav(input_path)
    model_root = root / "models"

    outputs = run_separator(
        input_path,
        root / "balanced",
        model_root,
        model="htdemucs.yaml",
        custom_output_names={
            "Drums": "drums",
            "Bass": "bass",
            "Vocals": "vocals",
            "Other": "other",
        },
        separator_factory=FakeSeparator,
    )
    balanced = FakeSeparator.instances[-1]
    check(balanced.loaded == "htdemucs.yaml", "balanced model must reach load_model")
    check(balanced.kwargs["output_format"] == "WAV", "service must request WAV output")
    check(balanced.kwargs["use_soundfile"] is True, "normalized PCM WAV should use bounded soundfile writer")
    check(balanced.kwargs["ensemble_preset"] is None, "model run must not accidentally enable an ensemble")
    check(balanced.kwargs["demucs_params"]["shifts"] == 0, "balanced Demucs must avoid shift multiplication on CPU")
    check({path.name for path in outputs} == {"drums.wav", "bass.wav", "vocals.wav", "other.wav"}, "model outputs")

    run_separator(
        input_path,
        root / "hq-demucs",
        model_root,
        model="htdemucs_ft.yaml",
        custom_output_names={"Vocals": "vocals"},
        separator_factory=FakeSeparator,
    )
    hq_demucs = FakeSeparator.instances[-1]
    check(hq_demucs.kwargs["demucs_params"]["shifts"] == 1, "HQ fine-tuned Demucs should use one shift, not library default two")

    outputs = run_separator(
        input_path,
        root / "ensemble",
        model_root,
        ensemble_preset="vocal_balanced",
        custom_output_names={"Vocals": "vocals", "Instrumental": "instrumental"},
        separator_factory=FakeSeparator,
    )
    ensemble = FakeSeparator.instances[-1]
    check(ensemble.loaded is None, "ensemble preset must use load_model() without an explicit filename")
    check(ensemble.kwargs["ensemble_preset"] == "vocal_balanced", "ensemble preset must reach Separator constructor")
    check(ensemble.kwargs["use_soundfile"] is True, "ensemble gets the same normalized PCM writer contract")
    check("demucs_params" not in ensemble.kwargs, "non-Demucs ensemble must not inherit broad-model shift tuning")
    check({path.name for path in outputs} == {"vocals.wav", "instrumental.wav"}, "ensemble outputs")

    compressed = root / "song.mp3"
    compressed.write_bytes(b"fake")
    try:
        run_separator(
            compressed,
            root / "compressed-invalid",
            model_root,
            model="htdemucs.yaml",
            separator_factory=FakeSeparator,
        )
    except ValueError as exc:
        check("normalized PCM WAV" in str(exc), "compressed input error should explain engine contract")
    else:
        raise AssertionError("separator engine must reject compressed input before model construction")

    for kwargs in ({}, {"model": "a", "ensemble_preset": "b"}):
        try:
            run_separator(
                input_path,
                root / "invalid",
                model_root,
                separator_factory=FakeSeparator,
                **kwargs,
            )
        except ValueError:
            pass
        else:
            raise AssertionError("exactly one of model/ensemble_preset must be required")

    try:
        run_separator(
            input_path,
            root / "invalid-shifts",
            model_root,
            model="htdemucs.yaml",
            demucs_shifts=-1,
            separator_factory=FakeSeparator,
        )
    except ValueError:
        pass
    else:
        raise AssertionError("negative Demucs shifts must be rejected")

print("SEPARATOR SERVICE REGRESSION: PASS")
