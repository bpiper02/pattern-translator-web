export type SplitStemKind =
  | "drums"
  | "bass"
  | "vocals"
  | "other"
  | "kick"
  | "snare"
  | "hihat"
  | "cymbals"
  | "toms";

export type SplitStem = {
  kind: SplitStemKind;
  label: string;
  url: string;
  fileName: string;
};

export type SplitResponse = {
  jobId: string;
  stems: SplitStem[];
};

const DEFAULT_API = "http://127.0.0.1:8788";

export function splitterApiBase() {
  return (import.meta.env.VITE_SPLITTER_API as string | undefined)?.replace(/\/$/, "") || DEFAULT_API;
}

async function postAudio(path: string, file: File): Promise<SplitResponse> {
  const form = new FormData();
  form.append("file", file);

  const response = await fetch(`${splitterApiBase()}${path}`, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }

  return response.json() as Promise<SplitResponse>;
}

export function splitFullMix(file: File) {
  return postAudio("/split/full", file);
}

export function splitDrumStem(file: File) {
  return postAudio("/split/drums", file);
}

export async function stemUrlToFile(stem: SplitStem): Promise<File> {
  const response = await fetch(stem.url);
  if (!response.ok) throw new Error(`Could not fetch ${stem.label}`);
  const blob = await response.blob();
  return new File([blob], stem.fileName || `${stem.kind}.wav`, { type: blob.type || "audio/wav" });
}
