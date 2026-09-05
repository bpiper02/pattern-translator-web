export type StemKind = "drums" | "bass" | "vocals" | "other";
export type DrumSubstemKind = "kick" | "snare" | "hats" | "cymbals" | "toms" | "percussion";

export type SeparatedStem = {
  kind: StemKind;
  label: string;
  audioUrl: string;
};

export type DrumSubstem = {
  kind: DrumSubstemKind;
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

export type DrumSubseparationRequest = {
  drumStemUrl: string;
};

export type DrumSubseparationResult = {
  stems: DrumSubstem[];
};

// Service boundary:
// full mix -> drums / bass / vocals / other
// drums -> kick / snare / hats / cymbals / toms / percussion
// UI code should depend on these contracts, not directly on Demucs, RoFormer, drumsep, or any future provider.
