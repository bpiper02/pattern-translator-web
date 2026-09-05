export type StemKind = "drums" | "bass" | "vocals" | "other";

export type SeparatedStem = {
  kind: StemKind;
  label: string;
  audioUrl: string;
};

export type SeparationRequest = {
  fileName: string;
  mimeType: string;
};

export type SeparationResult = {
  stems: SeparatedStem[];
};

// Future service boundary:
// full mix -> drums / bass / vocals / other
// drums -> kick / snare / hats / cymbals / toms
// Keep model/provider details behind this contract so the UI does not depend on Demucs/RoFormer/drumsep directly.
