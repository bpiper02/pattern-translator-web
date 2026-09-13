export type AudioAssetKind =
  | "mix"
  | "drums"
  | "bass"
  | "vocals"
  | "other"
  | "kick"
  | "snare"
  | "hihat"
  | "cymbals"
  | "toms"
  | "sample"
  | "translated"
  | "render";

export type AudioAssetOrigin = "upload" | "split" | "resample" | "translate";

export type ProjectAudioAsset = {
  id: string;
  file: File;
  kind: AudioAssetKind;
  label: string;
  origin: AudioAssetOrigin;
  parentId?: string;
  createdAt: number;
};

export type NewProjectAudioAsset = Omit<ProjectAudioAsset, "id" | "createdAt"> & {
  id?: string;
  createdAt?: number;
};

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isSameAsset(a: ProjectAudioAsset, b: NewProjectAudioAsset) {
  return (
    a.kind === b.kind &&
    a.parentId === b.parentId &&
    a.file.name === b.file.name &&
    a.file.size === b.file.size
  );
}

export function addProjectAsset(
  current: ProjectAudioAsset[],
  input: NewProjectAudioAsset,
): { assets: ProjectAudioAsset[]; asset: ProjectAudioAsset; added: boolean } {
  const existing = current.find((asset) => isSameAsset(asset, input));
  if (existing) return { assets: current, asset: existing, added: false };

  const asset: ProjectAudioAsset = {
    ...input,
    id: input.id ?? makeId(),
    createdAt: input.createdAt ?? Date.now(),
  };
  return { assets: [...current, asset], asset, added: true };
}

export function removeProjectAsset(current: ProjectAudioAsset[], id: string) {
  const removedIds = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const asset of current) {
      if (asset.parentId && removedIds.has(asset.parentId) && !removedIds.has(asset.id)) {
        removedIds.add(asset.id);
        changed = true;
      }
    }
  }
  return current.filter((asset) => !removedIds.has(asset.id));
}

export function assetKindLabel(kind: AudioAssetKind) {
  return kind === "hihat" ? "HI-HAT" : kind.toUpperCase();
}
