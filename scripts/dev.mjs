import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const isWindows = process.platform === "win32";
const SPLITTER_URL = "http://127.0.0.1:8788";
const CORS_PROBE_ORIGIN = "http://localhost:5174";
const EXPECTED_SPLITTER_REVISION = "split-runtime-v3-python-api";
const RECOMMENDED_PYTHON = "3.12";
const MAX_SUPPORTED_PYTHON_MINOR = 13;
const venvPython = path.join(
  root,
  "backend",
  ".venv",
  isWindows ? "Scripts/python.exe" : "bin/python",
);
const viteEntry = path.join(root, "node_modules", "vite", "bin", "vite.js");

function pythonCandidates() {
  const candidates = [];
  if (existsSync(venvPython)) candidates.push({ command: venvPython, prefix: [], label: "backend/.venv" });
  if (isWindows) {
    candidates.push({ command: "py", prefix: ["-3.12"], label: "Python 3.12" });
    candidates.push({ command: "py", prefix: ["-3.13"], label: "Python 3.13" });
  }
  candidates.push({ command: isWindows ? "python" : "python3", prefix: [], label: "system Python" });
  if (!isWindows) candidates.push({ command: "python", prefix: [], label: "python" });
  return candidates;
}

function inspectPython(candidate) {
  const probe = spawnSync(
    candidate.command,
    [...candidate.prefix, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (probe.status !== 0) return null;
  const version = probe.stdout.trim();
  const [major, minor] = version.split(".").map(Number);
  return { version, supported: major === 3 && minor >= 10 && minor <= MAX_SUPPORTED_PYTHON_MINOR };
}

function findBackendPython() {
  const imports = "import fastapi, uvicorn, numpy, soundfile, drumsep, audio_separator";
  for (const candidate of pythonCandidates()) {
    const info = inspectPython(candidate);
    if (!info?.supported) continue;
    const check = spawnSync(
      candidate.command,
      [...candidate.prefix, "-c", imports],
      { cwd: root, stdio: "ignore", shell: false },
    );
    if (check.status === 0) return { ...candidate, version: info.version };
  }
  return null;
}

function existingVenvInfo() {
  if (!existsSync(venvPython)) return null;
  return inspectPython({ command: venvPython, prefix: [] });
}

async function probeSplitter() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(`${SPLITTER_URL}/health`, {
      signal: controller.signal,
      headers: { Origin: CORS_PROBE_ORIGIN },
    });
    if (!response.ok) return "stale";
    const allowedOrigin = response.headers.get("access-control-allow-origin");
    if (allowedOrigin !== CORS_PROBE_ORIGIN) return "stale";
    const health = await response.json().catch(() => null);
    return health?.revision === EXPECTED_SPLITTER_REVISION ? "current" : "stale";
  } catch {
    return "offline";
  } finally {
    clearTimeout(timeout);
  }
}

function printSetupHelp() {
  const venvInfo = existingVenvInfo();
  console.error("\nCHOPSTICKS DEV: splitter backend environment is not ready.\n");
  if (venvInfo && !venvInfo.supported) {
    console.error(`Detected backend/.venv Python ${venvInfo.version}. That interpreter is too new for the current Windows audio-separator dependency stack.`);
    console.error(`Use Python ${RECOMMENDED_PYTHON} for the splitter environment.\n`);
  }
  console.error("From the repo root run:");
  if (isWindows) {
    console.error("  Remove-Item -Recurse -Force .\\backend\\.venv -ErrorAction SilentlyContinue");
    console.error(`  py install ${RECOMMENDED_PYTHON}`);
    console.error(`  py -${RECOMMENDED_PYTHON} --version`);
    console.error(`  py -${RECOMMENDED_PYTHON} -m venv .\\backend\\.venv`);
    console.error("  .\\backend\\.venv\\Scripts\\python.exe -m pip install --upgrade pip");
    console.error("  .\\backend\\.venv\\Scripts\\python.exe -m pip install -r .\\backend\\requirements.txt");
  } else {
    console.error("  python3 -m venv ./backend/.venv");
    console.error("  ./backend/.venv/bin/python -m pip install --upgrade pip");
    console.error("  ./backend/.venv/bin/python -m pip install -r ./backend/requirements.txt");
  }
  console.error("\nThen run `npm run dev` again. Use `npm run dev:web` only if you intentionally want the frontend without SPLIT.\n");
}

const children = [];
let shuttingDown = false;

function launch(command, args, label) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`${label} failed to start:`, error.message);
    shutdown(1);
  });
  child.on("exit", (code) => {
    if (shuttingDown) return;
    if (code && code !== 0) {
      console.error(`${label} exited with code ${code}.`);
      shutdown(code);
    }
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 60);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const backendState = await probeSplitter();
if (backendState === "current") {
  console.log(`CHOPSTICKS DEV: splitter already healthy on ${SPLITTER_URL}`);
} else if (backendState === "stale") {
  console.error(`\nCHOPSTICKS DEV: port 8788 is occupied by an old/incompatible splitter process.`);
  console.error("Stop the old backend terminal/process, then run `npm run dev` again.\n");
  process.exit(1);
} else {
  const python = findBackendPython();
  if (!python) {
    printSetupHelp();
    process.exit(1);
  }
  console.log(`CHOPSTICKS DEV: starting splitter with Python ${python.version} on ${SPLITTER_URL}`);
  launch(
    python.command,
    [...python.prefix, "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", "8788"],
    "Splitter backend",
  );
}

if (!existsSync(viteEntry)) {
  console.error("CHOPSTICKS DEV: Vite is not installed. Run `npm install` and try again.");
  shutdown(1);
} else {
  console.log("CHOPSTICKS DEV: starting Vite frontend");
  launch(process.execPath, [viteEntry], "Vite frontend");
}
