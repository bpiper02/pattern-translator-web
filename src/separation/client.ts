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

export type FullSplitProfile = "balanced" | "hq";
export type DrumSplitProfile = "standard" | "hq";

export type SplitStem = {
  kind: SplitStemKind;
  label: string;
  url: string;
  fileName: string;
};

export type SplitResponse = {
  jobId: string;
  profile: string;
  engine: string;
  stems: SplitStem[];
};

const DEFAULT_API = "http://127.0.0.1:8788";
const HEALTH_TIMEOUT_MS = 2500;

export function splitterApiBase() {
  return (import.meta.env.VITE_SPLITTER_API as string | undefined)?.replace(/\/$/, "") || DEFAULT_API;
}

function resolveStemUrls(result: SplitResponse, apiBase: string): SplitResponse {
  const base = `${apiBase.replace(/\/$/, "")}/`;
  return {
    ...result,
    stems: result.stems.map((stem) => ({
      ...stem,
      url: new URL(stem.url, base).toString(),
    })),
  };
}

function backendUnavailable(apiBase: string) {
  return new Error(
    `Splitter backend unavailable at ${apiBase}. Start the local splitter API on port 8788, then retry.`,
  );
}

async function assertBackendAvailable(apiBase: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBase}/health`, { signal: controller.signal });
    if (!response.ok) throw backendUnavailable(apiBase);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Splitter backend unavailable")) throw error;
    throw backendUnavailable(apiBase);
  } finally {
    window.clearTimeout(timeout);
  }
}

async function postAudio(path: string, file: File, profile: string): Promise<SplitResponse> {
  const form = new FormData();
  form.append("file", file);
  const apiBase = splitterApiBase();

  await assertBackendAvailable(apiBase);

  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}?profile=${encodeURIComponent(profile)}`, {
      method: "POST",
      body: form,
    });
  } catch {
    throw backendUnavailable(apiBase);
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }

  const result = await response.json() as SplitResponse;
  return resolveStemUrls(result, apiBase);
}

export function splitFullMix(file: File, profile: FullSplitProfile = "balanced") {
  return postAudio("/split/full", file, profile);
}

export function splitDrumStem(file: File, profile: DrumSplitProfile = "hq") {
  return postAudio("/split/drums", file, profile);
}

export async function stemUrlToFile(stem: SplitStem): Promise<File> {
  let response: Response;
  try {
    response = await fetch(stem.url);
  } catch {
    throw new Error(`Could not download ${stem.label} from the splitter backend`);
  }
  if (!response.ok) throw new Error(`Could not fetch ${stem.label}: ${response.status} ${response.statusText}`);
  const blob = await response.blob();
  return new File([blob], stem.fileName || `${stem.kind}.wav`, { type: blob.type || "audio/wav" });
}
