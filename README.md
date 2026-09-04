# Pattern Translator Web

A local-first browser prototype for translating **drum** and **bass** patterns into editable MIDI at a new BPM/key.

## What V0.1 does

### Drums
- Upload a drum stem
- Detect likely transient hits
- Group repeating hit timbres into A/B/C-style lanes
- Quantize to 1/8, 1/16, or 1/32
- Click grid cells to fix/add/remove hits
- Change target BPM
- Export MIDI

### Bass
- Upload a mostly monophonic bass stem
- Detect note attacks and rough pitch with browser-side autocorrelation
- Change source/target key root
- Change target BPM
- Remove bad notes from the piano roll
- Export MIDI

Everything runs in-browser. There is no backend and no audio upload/storage.

## Local setup

Use Node 20+.

```powershell
npm install
npm run dev
```

Vite prints a local URL, usually `http://localhost:5173`.

## Cloudflare Pages deployment

### Option A — GitHub → Cloudflare Pages

1. Put this project in a GitHub repo.
2. In Cloudflare Dashboard, create a **Pages** project and connect the repo.
3. Framework preset: `Vite`
4. Build command:
   `npm run build`
5. Build output directory:
   `dist`
6. Deploy.

### Option B — Wrangler from your machine

```powershell
npm install
npx wrangler login
npm run deploy
```

The included deploy script builds and runs:

```powershell
npx wrangler pages deploy dist
```

## Important V0 limitations

This is deliberately not pretending transcription is perfect.

- Automatic BPM can pick half-time/double-time. The source BPM is editable.
- Drum lanes are generic sound classes, not guaranteed kick/snare/hat labels.
- Layered drum hits are treated as one transient class; V0 does not unmix the individual samples.
- Bass pitch detection is intentionally lightweight and works best with a clean isolated bass stem.
- The first detected event is treated as the pattern start rather than doing advanced downbeat detection.

## Next high-ROI iteration

1. Audible recreated-pattern preview before MIDI export
2. Rename/remap drum lanes to a personal kit (e.g. Q / W / J)
3. Drag bass notes instead of only deleting them
4. Loop selection so you can analyze only 2–8 bars
5. Whole reference song → client-side or worker-based stem separation → feed stems into this same engine
