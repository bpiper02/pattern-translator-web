from pathlib import Path
from tempfile import TemporaryDirectory

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


with TemporaryDirectory() as temp:
    root = Path(temp)
    input_path = root / "song.mp3"
    input_path.write_bytes(b"fake-audio")
    model_root = root / "models"

    outputs = run_separator(
        input_path,
        root / "balanced",
        model_root,
        model="htdemucs_ft.yaml",
        custom_output_names={
            "Drums": "drums",
            "Bass": "bass",
            "Vocals": "vocals",
            "Other": "other",
        },
        separator_factory=FakeSeparator,
    )
    balanced = FakeSeparator.instances[-1]
    check(balanced.loaded == "htdemucs_ft.yaml", "explicit model must be passed to load_model")
    check(balanced.kwargs["output_format"] == "WAV", "service must request WAV output")
    check(balanced.kwargs["use_soundfile"] is True, "service must use bounded-memory soundfile writer")
    check(balanced.kwargs["ensemble_preset"] is None, "model run must not accidentally enable an ensemble")
    check({path.name for path in outputs} == {"drums.wav", "bass.wav", "vocals.wav", "other.wav"}, "model outputs")

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
    check({path.name for path in outputs} == {"vocals.wav", "instrumental.wav"}, "ensemble outputs")

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

print("SEPARATOR SERVICE REGRESSION: PASS")
