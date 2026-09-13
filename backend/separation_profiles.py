from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class FullMixProfile:
    name: str
    broad_model: str
    vocal_model: str | None = None
    vocal_ensemble_preset: str | None = None


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
    # HQ remix: community-curated RoFormer vocal ensemble first, then Demucs on
    # the complementary instrumental remainder for drums/bass/other.
    "hq": FullMixProfile(
        name="hq",
        broad_model=os.getenv("PT_BROAD_MODEL", "htdemucs_ft.yaml"),
        vocal_ensemble_preset=os.getenv("PT_VOCAL_ENSEMBLE", "vocal_balanced"),
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


def classify_broad(path: Path) -> str | None:
    name = path.stem.lower()
    for kind in ("drums", "bass", "vocals", "other"):
        if kind in name:
            return kind
    return None


def classify_pair(path: Path) -> str | None:
    name = path.stem.lower()
    if "instrumental" in name or "no_vocals" in name or "no vocals" in name:
        return "instrumental"
    if "vocals" in name or "vocal" in name:
        return "vocals"
    return None


def classify_drum(path: Path) -> str | None:
    name = path.stem.lower().replace("-", "_")
    aliases = {
        "kick": ("kick", "bd"),
        "snare": ("snare", "sd"),
        "hihat": ("hihat", "hi_hat", "hh"),
        "ride": ("ride",),
        "crash": ("crash",),
        "cymbals": ("cymbal", "cymbals"),
        "toms": ("tom", "toms"),
    }
    for kind, tokens in aliases.items():
        if any(token in name for token in tokens):
            return kind
    return None
