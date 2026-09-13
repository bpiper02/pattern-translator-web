# Pattern Translator Splitter Backend

This service keeps heavy source separation out of the Vite frontend while the browser workbench stays local-first with the returned WAV files.

## Separation profiles

### Full song / mix

- `balanced` — `htdemucs_ft.yaml` -> drums / bass / vocals / other.
- `hq` — `audio-separator`'s curated `vocal_balanced` RoFormer ensemble -> vocals + instrumental, then `htdemucs_ft.yaml` splits the instrumental remainder into drums / bass / other.
- If the HQ ensemble cannot load or run, the API falls back to the balanced Demucs path and reports `balanced-fallback` in the response instead of pretending HQ succeeded.

### Drum audio

- `hq` (default) — `MDX23C-DrumSep-aufr33-jarredou.ckpt` -> kick / snare / toms / hi-hat / ride / crash. Ride + crash are combined into the current CYMBALS project asset so no cymbal material is silently discarded.
- `standard` — deterministic `drumsep` -> kick / snare / hi-hat / cymbals / toms.
- If MDX23C cannot load or run, the API falls back to deterministic `drumsep` and reports `standard-fallback`.

The frontend shows the actual engine used after each split.

## Windows PowerShell

Audio-separator has a safer compatibility path on Python 3.11/3.12 than bleeding-edge Python versions because of Torch/ONNX dependencies.

Check installed Python versions:

```powershell
py -0p
```

From the repository root, using Python 3.12 if installed:

```powershell
cd C:\Users\brent\Desktop\pattern-translator-web
py -3.12 -m venv .\backend\.venv
.\backend\.venv\Scripts\python.exe -m pip install --upgrade pip
.\backend\.venv\Scripts\python.exe -m pip install -r .\backend\requirements.txt
```

Then verify audio-separator and FFmpeg detection:

```powershell
.\backend\.venv\Scripts\audio-separator.exe --env_info
.\backend\.venv\Scripts\audio-separator.exe --list_presets
```

Run the API:

```powershell
.\backend\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8788
```

In a second PowerShell window, run the frontend normally:

```powershell
cd C:\Users\brent\Desktop\pattern-translator-web
npm.cmd run dev
```

The frontend defaults to `http://127.0.0.1:8788`. For another backend URL, create `.env.local`:

```text
VITE_SPLITTER_API=http://127.0.0.1:8788
```

## First-run downloads and performance

The first use of a profile downloads its selected checkpoint(s) into `backend/data/models/`. HQ full-song mode is intentionally heavier because the curated vocal ensemble runs multiple models before Demucs. HQ drum mode downloads the MDX23C DrumSep checkpoint. Subsequent runs reuse the cached files.

Environment overrides:

```text
PT_BROAD_MODEL=htdemucs_ft.yaml
PT_VOCAL_ENSEMBLE=vocal_balanced
PT_DRUM_MODEL=MDX23C-DrumSep-aufr33-jarredou.ckpt
```

## Objective bakeoff

If you have known ground-truth WAV stems, compare the profiles instead of relying on reputation alone.

Full mix truth directory must contain:

```text
vocals.wav
bass.wav
drums.wav
other.wav
```

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m backend.benchmark_split full C:\path\to\truth --keep C:\temp\pt-full-bakeoff
```

For drums, provide at least three of `kick.wav`, `snare.wav`, `hihat.wav`, `cymbals.wav`, `toms.wav` and run:

```powershell
.\backend\.venv\Scripts\python.exe -m backend.benchmark_split drums C:\path\to\drum-truth --keep C:\temp\pt-drum-bakeoff
```

The script prints per-stem SI-SDR for the standard/balanced and HQ paths.

## Model licensing note

`audio-separator`, Demucs/RoFormer implementations, and the surrounding integration are open source, but community checkpoint weights can have separate or incompletely documented usage terms. Pattern Translator therefore keeps the community-weight HQ profiles optional and retains cleaner fallback paths. Re-check checkpoint licensing before commercial distribution or bundling.

`backend/data/` is intentionally ignored by git because it contains downloaded models, uploaded audio, and generated stems.
