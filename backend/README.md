# Pattern Translator Splitter Backend

This service keeps heavy source separation out of the Vite frontend.

Pipeline:

- full mix -> `audio-separator` using `htdemucs_ft.yaml` -> drums / bass / vocals / other
- isolated drums -> `drumsep` -> kick / snare / hihat / cymbals / toms
- frontend previews the returned WAV stems directly, preserving the separated source timbre

## Windows PowerShell

Audio-separator currently has a much safer compatibility path on Python 3.11/3.12 than Python 3.14 because of its Torch/ONNX dependencies.

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

## Notes

The first full-mix split downloads the selected separation model, so the first run takes longer. Drumsep does not download a model and runs on CPU.

`backend/data/` is intentionally ignored by git because it contains downloaded models, uploaded audio, and generated stems.
