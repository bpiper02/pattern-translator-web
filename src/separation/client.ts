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

type SplitJobStatus = "queued" | "running" | "complete" | "failed";

type SplitJobResponse = {
  jobId: string;
  mode: "full" | "drums";
  profile: string;
  status: SplitJobStatus;
  phase: string;
  engine: string | null;
  error: string | null;
  stems: SplitStem[];
};

type SplitProgress = (phase: string) => void;

const DEFAULT_API = "http://127.0.0.1:8788";
const HEALTH_TIMEOUT_MS = 2500;
const POLL_INTERVAL_MS = 1200;

export function splitterApiBase() {
  return (import.meta.env.VITE_SPLITTER_API as string | undefined)?.replace(/\/$/, "") || DEFAULT_API;
}

function resolveStemUrls<T extends { stems: SplitStem[] }>(result: T, apiBase: string): T {
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

function abortError() {
  return new DOMException("Split cancelled", "AbortError");
}

async function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function assertBackendAvailable(apiBase: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(`${apiBase}/health`, { signal: controller.signal });
    if (!response.ok) throw backendUnavailable(apiBase);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (error instanceof Error && error.message.startsWith("Splitter backend unavailable")) throw error;
    throw backendUnavailable(apiBase);
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function responseError(response: Response) {
  let detail = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json() as { detail?: string };
    if (body.detail) detail = body.detail;
  } catch {}
  return new Error(detail);
}

async function pollJob(
  apiBase: string,
  initial: SplitJobResponse,
  onProgress?: SplitProgress,
  signal?: AbortSignal,
): Promise<SplitResponse> {
  let job = initial;
  let lastPhase = "";

  while (true) {
    if (signal?.aborted) throw abortError();
    if (job.phase !== lastPhase) {
      lastPhase = job.phase;
      onProgress?.(job.phase);
    }
    if (job.status === "failed") throw new Error(job.error || "Split failed");
    if (job.status === "complete") {
      if (!job.engine || job.stems.length === 0) throw new Error("Split completed without usable stems");
      const resolved = resolveStemUrls(job, apiBase);
      return {
        jobId: resolved.jobId,
        profile: resolved.profile,
        engine: resolved.engine,
        stems: resolved.stems,
      };
    }

    await delay(POLL_INTERVAL_MS, signal);
    let response: Response;
    try {
      response = await fetch(`${apiBase}/jobs/${encodeURIComponent(job.jobId)}`, { signal });
    } catch {
      if (signal?.aborted) throw abortError();
      throw backendUnavailable(apiBase);
    }
    if (!response.ok) throw await responseError(response);
    job = await response.json() as SplitJobResponse;
  }
}

async function postAudio(
  path: string,
  file: File,
  profile: string,
  onProgress?: SplitProgress,
  signal?: AbortSignal,
): Promise<SplitResponse> {
  const form = new FormData();
  form.append("file", file);
  const apiBase = splitterApiBase();

  await assertBackendAvailable(apiBase, signal);

  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}?profile=${encodeURIComponent(profile)}`, {
      method: "POST",
      body: form,
      signal,
    });
  } catch {
    if (signal?.aborted) throw abortError();
    throw backendUnavailable(apiBase);
  }

  if (!response.ok) throw await responseError(response);
  const job = await response.json() as SplitJobResponse;
  return pollJob(apiBase, job, onProgress, signal);
}

export function splitFullMix(
  file: File,
  profile: FullSplitProfile = "balanced",
  onProgress?: SplitProgress,
  signal?: AbortSignal,
) {
  return postAudio("/split/full", file, profile, onProgress, signal);
}

export function splitDrumStem(
  file: File,
  profile: DrumSplitProfile = "hq",
  onProgress?: SplitProgress,
  signal?: AbortSignal,
) {
  return postAudio("/split/drums", file, profile, onProgress, signal);
}

export async function stemUrlToFile(stem: SplitStem, signal?: AbortSignal): Promise<File> {
  let response: Response;
  try {
    response = await fetch(stem.url, { signal });
  } catch {
    if (signal?.aborted) throw abortError();
    throw new Error(`Could not download ${stem.label} from the splitter backend`);
  }
  if (!response.ok) throw new Error(`Could not fetch ${stem.label}: ${response.status} ${response.statusText}`);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error(`${stem.label} stem was empty`);
  return new File([blob], stem.fileName || `${stem.kind}.wav`, { type: blob.type || "audio/wav" });
}
