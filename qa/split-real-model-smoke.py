from __future__ import annotations

import math
import os
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

import backend.app as splitter_app
from backend.audio_contract import inspect_audio
from backend.ffmpeg_runtime import ensure_ffmpeg_runtime


def make_fixture(path: Path, seconds: float = 8.0, sample_rate: int = 44_100) -> None:
    """Create a dense stereo music-like fixture without external test assets."""
    frames = int(seconds * sample_rate)
    t = np.arange(frames, dtype=np.float32) / sample_rate

    bass = 0.22 * np.sin(2 * math.pi * 82.41 * t)
    melody = 0.13 * np.sin(2 * math.pi * 329.63 * t) + 0.09 * np.sin(2 * math.pi * 493.88 * t)
    vocalish = 0.10 * np.sin(2 * math.pi * (220 + 8 * np.sin(2 * math.pi * 4.5 * t)) * t)

    percussion = np.zeros_like(t)
    pulse_length = int(0.045 * sample_rate)
    envelope = np.exp(-np.linspace(0, 7, pulse_length, dtype=np.float32))
    rng = np.random.default_rng(20260914)
    for beat in np.arange(0.15, seconds, 0.5):
        start = int(beat * sample_rate)
        end = min(frames, start + pulse_length)
        count = end - start
        if count > 0:
            noise = rng.normal(0, 1, count).astype(np.float32)
            percussion[start:end] += 0.18 * noise * envelope[:count]

    left = bass + melody + vocalish + percussion
    right = bass + 0.95 * melody + 0.9 * vocalish + np.roll(percussion, 23)
    stereo = np.column_stack((left, right))
    peak = float(np.max(np.abs(stereo)))
    if peak > 0.92:
        stereo *= 0.92 / peak
    sf.write(path, stereo, sample_rate, subtype="PCM_16")


def encode_mp3(source: Path, target: Path) -> None:
    ffmpeg = ensure_ffmpeg_runtime()
    result = subprocess.run(
        [
            str(ffmpeg),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "192k",
            str(target),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0 or not target.is_file():
        raise RuntimeError(f"Could not encode MP3 fixture: {(result.stderr or result.stdout).strip()}")


def wait_for_job(client: TestClient, job_id: str, timeout_seconds: float = 20 * 60) -> tuple[dict, list[str]]:
    deadline = time.monotonic() + timeout_seconds
    phases: list[str] = []
    last_phase = None
    while time.monotonic() < deadline:
        response = client.get(f"/jobs/{job_id}")
        assert response.status_code == 200, response.text
        job = response.json()
        phase = job.get("phase")
        if phase and phase != last_phase:
            phases.append(phase)
            last_phase = phase
            print(f"split job phase: {phase}", flush=True)
        if job["status"] == "complete":
            return job, phases
        if job["status"] == "failed":
            raise AssertionError(f"real split job failed: {job.get('error')}")
        time.sleep(1.0)
    raise TimeoutError(f"split job {job_id} did not finish within {timeout_seconds:.0f}s")


def main() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        source_wav = root / "fixture.wav"
        source_mp3 = root / "fixture.mp3"
        data_root = root / "jobs"
        incoming_root = root / "incoming"
        # Allow CI to cache model downloads outside the ephemeral temp dir.
        model_root = Path(os.environ.get("PT_SMOKE_MODEL_ROOT", str(root / "models"))).resolve()
        data_root.mkdir()
        incoming_root.mkdir()
        model_root.mkdir(parents=True, exist_ok=True)

        make_fixture(source_wav)
        encode_mp3(source_wav, source_mp3)
        original = inspect_audio(source_wav)
        payload = source_mp3.read_bytes()

        splitter_app.DATA_ROOT = data_root
        splitter_app.INCOMING_ROOT = incoming_root
        splitter_app.MODEL_ROOT = model_root
        splitter_app._ACTIVE_TASKS.clear()

        started = time.perf_counter()
        with TestClient(splitter_app.app) as client:
            health = client.get("/health")
            assert health.status_code == 200, health.text
            health_payload = health.json()
            assert health_payload["revision"] == "split-runtime-v4-jobs"
            assert health_payload["jobApi"] is True

            first = client.post(
                "/split/full?profile=balanced",
                files={"file": ("fixture.mp3", payload, "audio/mpeg")},
            )
            assert first.status_code == 202, first.text
            first_job = first.json()
            job_id = first_job["jobId"]
            assert first_job["status"] in {"queued", "running"}, first_job

            # Idempotency under overlap: the exact same source/profile while the
            # first job is active must attach to one job id, never launch another
            # expensive model run.
            duplicate = client.post(
                "/split/full?profile=balanced",
                files={"file": ("fixture.mp3", payload, "audio/mpeg")},
            )
            assert duplicate.status_code == 202, duplicate.text
            assert duplicate.json()["jobId"] == job_id, duplicate.text

            job, phases = wait_for_job(client, job_id)
            elapsed = time.perf_counter() - started
            assert job["profile"] == "balanced", job
            assert job["engine"] == "htdemucs.yaml", job
            assert "normalizing" in phases, phases
            assert "separating" in phases, phases
            assert "validating" in phases, phases

            stems = job["stems"]
            assert {stem["kind"] for stem in stems} == {"drums", "bass", "vocals", "other"}, stems
            for stem in stems:
                response = client.get(stem["url"])
                assert response.status_code == 200, (stem, response.text)
                assert len(response.content) > 44, stem
                path = root / f"download-{stem['kind']}.wav"
                path.write_bytes(response.content)
                info = sf.info(str(path))
                assert info.format == "WAV", (stem["kind"], info.format)
                assert str(info.subtype).startswith("PCM_"), (stem["kind"], info.subtype)
                assert info.frames > 0, stem["kind"]
                duration = info.frames / info.samplerate
                assert abs(duration - original.duration_seconds) <= 1.0, (
                    stem["kind"],
                    duration,
                    original.duration_seconds,
                )
                audio, _ = sf.read(path, dtype="float32", always_2d=True)
                assert np.isfinite(audio).all(), stem["kind"]

            # Internal source/work files must never become browser-readable.
            assert client.get(f"/files/{job_id}/input.mp3").status_code == 404
            assert client.get(f"/files/{job_id}/normalized.wav").status_code == 404

            job_dir = data_root / job_id
            assert not any(job_dir.glob("input.*")), list(job_dir.iterdir())
            assert not (job_dir / "normalized.wav").exists()
            assert not (job_dir / "work").exists()

            # Completed-result cache: identical input/profile returns immediately
            # with the same job instead of invoking Demucs again.
            cached_started = time.perf_counter()
            cached = client.post(
                "/split/full?profile=balanced",
                files={"file": ("fixture.mp3", payload, "audio/mpeg")},
            )
            cached_elapsed = time.perf_counter() - cached_started
            assert cached.status_code == 200, cached.text
            cached_payload = cached.json()
            assert cached_payload["jobId"] == job_id, cached_payload
            assert cached_payload["status"] == "complete", cached_payload
            assert cached_elapsed < 5.0, cached_elapsed

        print(
            "REAL SPLIT E2E: PASS | "
            f"engine=htdemucs.yaml | source=encoded MP3 | job+cache+4 WAVs | elapsed={elapsed:.1f}s"
        )


if __name__ == "__main__":
    main()
