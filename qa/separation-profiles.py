from pathlib import Path
import runpy

from backend.separation_profiles import (
    classify_broad,
    classify_drum,
    classify_pair,
    drum_profile,
    full_mix_profile,
)


def check(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


check(full_mix_profile("balanced").broad_model, "htdemucs_ft.yaml", "balanced broad model")
check(full_mix_profile("balanced").vocal_model, None, "balanced vocal stage")
check(full_mix_profile("balanced").vocal_ensemble_preset, None, "balanced vocal ensemble")
check(full_mix_profile("hq").vocal_ensemble_preset, "vocal_balanced", "hq vocal ensemble")
check(drum_profile("standard").model, None, "standard drum model")
check(drum_profile("hq").model, "MDX23C-DrumSep-aufr33-jarredou.ckpt", "hq drum model")

for bad, resolver in (("turbo", full_mix_profile), ("magic", drum_profile)):
    try:
        resolver(bad)
    except ValueError:
        pass
    else:
        raise AssertionError(f"invalid profile {bad!r} should fail")

broad_cases = {
    "song_(Vocals)_htdemucs_ft.wav": "vocals",
    "song_(Drums)_htdemucs_ft.wav": "drums",
    "song_(Bass)_htdemucs_ft.wav": "bass",
    "song_(Other)_htdemucs_ft.wav": "other",
}
for name, expected in broad_cases.items():
    check(classify_broad(Path(name)), expected, name)

pair_cases = {
    "song_(Vocals)_vocal_balanced.wav": "vocals",
    "song_(Instrumental)_vocal_balanced.wav": "instrumental",
    "song_no_vocals.wav": "instrumental",
}
for name, expected in pair_cases.items():
    check(classify_pair(Path(name)), expected, name)

drum_cases = {
    "song_(Kick)_MDX23C.wav": "kick",
    "song_(Snare)_MDX23C.wav": "snare",
    "song_(HH)_MDX23C.wav": "hihat",
    "song_(Hi-Hat)_MDX23C.wav": "hihat",
    "song_(Toms)_MDX23C.wav": "toms",
    "song_(Ride)_MDX23C.wav": "ride",
    "song_(Crash)_MDX23C.wav": "crash",
    "song_(Cymbals)_drumsep.wav": "cymbals",
}
for name, expected in drum_cases.items():
    check(classify_drum(Path(name)), expected, name)

# app.py consumes dataclass profiles. A previous regression converted the profile
# definitions to dataclasses but left dictionary-style selected["..."] access in
# the endpoint, which only failed at runtime. Keep the producer/consumer contract
# checked in this dependency-free test.
app_source = (Path(__file__).parents[1] / "backend" / "app.py").read_text(encoding="utf-8")
if "selected[" in app_source:
    raise AssertionError("backend app must use typed profile attributes, not selected[...] dictionary access")
for token in (
    "selected.name",
    "selected.broad_model",
    "selected.vocal_ensemble_preset",
    "selected.model",
):
    if token not in app_source:
        raise AssertionError(f"backend endpoint profile contract missing {token}")

print("SEPARATION PROFILE REGRESSION: PASS")

# Keep backend policy checks in the same dependency-free CI step so storage
# lifecycle regressions fail before heavyweight separator dependencies matter.
runpy.run_path(Path(__file__).with_name("job-storage.py"), run_name="__main__")
