from pathlib import Path

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
check(full_mix_profile("hq").vocal_model, "melband_roformer_big_beta4.ckpt", "hq vocal model")
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
    "song_(Vocals)_melband_roformer_big_beta4.wav": "vocals",
    "song_(Instrumental)_melband_roformer_big_beta4.wav": "instrumental",
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

print("SEPARATION PROFILE REGRESSION: PASS")
