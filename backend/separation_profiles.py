from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class FullMixProfile:
    name: str
    broad_model: str
    vocal_model: str | None = None


@dataclass(frozen=True)
class DrumProfile:
    name: str
    model: str | None
    fallback_rule_based: bool = True


FULL_MIX_PROFILES = {
    "balanced": FullMixProfile(
        name="balanced",
        broad_model=os.getenv("PT_BROAD_MODEL", "htdemucs_ft.yaml"),
    ),
    # Two-stage remix profile: a high-quality vocal/instrumental model first,
    # then Demucs on the instrumental remainder for drums/bass/other.
    "hq": FullMixProfile(
        name="hq",
        broad_model=os.getenv("PT_BROAD_MODEL", "htdemucs_ft.yaml"),
        vocal_model=os.getenv("PT_VOCAL_MODEL", "melband_roformer_big_beta4.ckpt"),
    ),
}

DRUM_PROFILES = {
    "standard": DrumProfile(name="standard", model=None, fallback_rule_based=True),
    "hq": DrumProfile(
        name="hq",
        model=os.getenv("PT_DRUM_MODEL", "MDX23C-DrumSep-aufr33-jarredou.ckpt"),
        fallback_rule_based=True,
    ),
}


def full_mix_profile(name: str) -> FullMixProfile:
    if name not in FULL_MIX_PROFILES:
        raise ValueError(f"Unknown full-mix profile: {name}")
    return FULL_MIX_PROFILES[name]


def drum_profile(name: str) -> DrumProfile:
    if name not in DRUM_PROFILES:
        raise ValueError(f"Unknown drum profile: {name}")
    return DRUM_PROFILES[name]
