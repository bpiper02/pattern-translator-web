from __future__ import annotations

import argparse
import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from backend.audio_contract import AudioInfo, inspect_audio, validate_stem
from backend.ffmpeg_runtime import ensure_ffmpeg_runtime

APP_ROOT = Path(__file__).resolve().parent
SMOKE_ROOT = APP_ROOT / "data" / "smoke"


def _make_clip(source: Path, destination: Path, *, start: float, seconds: float) -> AudioInfo:
    ffmpeg = ensure_ffmpeg_runtime()
    destination.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(ffmpeg),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        str(max(0.0, start)),
        "-t",
        str(seconds),
        "-i",
        str(source),
        "-vn",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "pcm_s16le",
        str(destination),
    ]
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=180,
        check=False,
    )
    if result.returncode != 0 or not destination.is_file():
        detail = (result.stderr or result.stdout or "FFmpeg clip creation failed").strip().splitlines()
        raise RuntimeError(detail[-1] if detail else "FFmpeg clip creation failed")
    info = inspect_audio(destination)
    if info.duration_seconds < min(2.0, seconds * 0.5):
        raise RuntimeError(
            f"Smoke clip is only {info.duration_seconds:.2f}s. Choose an earlier --start value for this source."
        )
    return info


def _multipart_body(path: Path) -> tuple[bytes, str]:
    boundary = f"----chopsticks-smoke-{uuid.uuid4().hex}"
    file_bytes = path.read_bytes()
    prefix = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode("utf-8")
    suffix = f"\r\n--{boundary}--\r\n".encode("utf-8")
    return prefix + file_bytes + suffix, boundary


def _request_json(request: urllib.request.Request, *, timeout: float) -> dict:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            detail = payload.get("detail") or payload
        except Exception:
            detail = exc.reason
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach Split API: {exc.reason}") from exc


def _health(api_base: str) -> dict:
    request = urllib.request.Request(f"{api_base}/health", method="GET")
    health = _request_json(request, timeout=5)
    if health.get("ok") is not True or health.get("jobApi") is not True:
        raise RuntimeError(f"Split API is not the v4 job runtime: {health}")
    return health


def _submit(api_base: str, clip: Path, profile: str) -> dict:
    body, boundary = _multipart_body(clip)
    request = urllib.request.Request(
        f"{api_base}/split/full?profile={urllib.parse.quote(profile)}",
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    return _request_json(request, timeout=30)


def _poll(api_base: str, job: dict, *, timeout_seconds: float) -> dict:
    job_id = job.get("jobId")
    if not job_id:
        raise RuntimeError(f"Split API did not return a job id: {job}")

    deadline = time.monotonic() + timeout_seconds
    last_phase = None
    current = job
    while True:
        phase = current.get("phase") or current.get("status") or "unknown"
        if phase != last_phase:
            print(f"  phase: {phase}")
            last_phase = phase

        status = current.get("status")
        if status == "complete":
            return current
        if status == "failed":
            raise RuntimeError(current.get("error") or "Split job failed")
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Split smoke job exceeded {timeout_seconds:.0f}s")

        time.sleep(1.0)
        request = urllib.request.Request(f"{api_base}/jobs/{job_id}", method="GET")
        current = _request_json(request, timeout=10)


def _download_and_validate(api_base: str, job: dict, output_dir: Path, source_info: AudioInfo) -> list[Path]:
    stems = job.get("stems") or []
    kinds = {stem.get("kind") for stem in stems}
    required = {"drums", "bass", "vocals", "other"}
    if not required.issubset(kinds):
        raise RuntimeError(f"Completed job is missing expected stems: got {sorted(k for k in kinds if k)}")

    downloaded: list[Path] = []
    for stem in stems:
        file_name = stem.get("fileName") or f"{stem.get('kind', 'stem')}.wav"
        relative_url = stem.get("url")
        if not relative_url:
            raise RuntimeError(f"Stem {file_name} has no download URL")
        url = urllib.parse.urljoin(f"{api_base}/", relative_url.lstrip("/"))
        destination = output_dir / file_name
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                destination.write_bytes(response.read())
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Could not download {file_name}: {exc}") from exc
        validate_stem(destination, source_info)
        downloaded.append(destination)
    return downloaded


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run a short real-audio Split job through the actual local HTTP API and validate every returned stem."
    )
    parser.add_argument("source", type=Path, help="Path to a real song/audio file")
    parser.add_argument("--start", type=float, default=20.0, help="Start time in seconds for the smoke clip (default: 20)")
    parser.add_argument("--seconds", type=float, default=12.0, help="Clip duration in seconds (default: 12)")
    parser.add_argument("--profile", choices=("balanced", "hq"), default="balanced")
    parser.add_argument("--api", default="http://127.0.0.1:8788")
    parser.add_argument("--timeout", type=float, default=1800.0, help="Maximum job wait in seconds (default: 1800)")
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"Source does not exist: {source}")
    if args.seconds <= 0:
        raise SystemExit("--seconds must be positive")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    output_dir = SMOKE_ROOT / f"{source.stem}-{stamp}"
    output_dir.mkdir(parents=True, exist_ok=False)
    clip = output_dir / "smoke-source.wav"

    print(f"CHOPSTICKS SPLIT SMOKE: {source.name}")
    print(f"  clip: {args.start:.1f}s → {args.start + args.seconds:.1f}s")
    source_info = _make_clip(source, clip, start=args.start, seconds=args.seconds)
    print(
        f"  prepared: {source_info.duration_seconds:.2f}s / {source_info.sample_rate} Hz / "
        f"{source_info.channels} ch / {source_info.subtype}"
    )

    health = _health(args.api.rstrip("/"))
    print(f"  backend: {health.get('revision')} / pipeline {health.get('pipelineRevision')}")

    started = time.monotonic()
    job = _submit(args.api.rstrip("/"), clip, args.profile)
    completed = _poll(args.api.rstrip("/"), job, timeout_seconds=args.timeout)
    elapsed = time.monotonic() - started
    stems = _download_and_validate(args.api.rstrip("/"), completed, output_dir, source_info)

    print(f"PASS: {len(stems)} validated stems in {elapsed:.1f}s")
    print(f"  engine: {completed.get('engine')}")
    print(f"  outputs: {output_dir}")
    for path in stems:
        info = inspect_audio(path)
        print(f"    {path.name}: {info.duration_seconds:.2f}s / {path.stat().st_size / (1024 * 1024):.2f} MiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
