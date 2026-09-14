import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const isWindows = process.platform === "win32";
const venvPython = path.join(
  root,
  "backend",
  ".venv",
  isWindows ? "Scripts/python.exe" : "bin/python",
);

function pythonCandidates() {
  const candidates = [];
  if (existsSync(venvPython)) candidates.push({ command: venvPython, prefix: [] });
  if (isWindows) candidates.push({ command: "py", prefix: ["-3.12"] });
  candidates.push({ command: isWindows ? "python" : "python3", prefix: [] });
  if (!isWindows) candidates.push({ command: "python", prefix: [] });
  return candidates;
}

function findBackendPython() {
  for (const candidate of pythonCandidates()) {
    const check = spawnSync(
      candidate.command,
      [...candidate.prefix, "-c", "import fastapi, uvicorn"],
      { cwd: root, stdio: "ignore", shell: false },
    );
    if (check.status === 0) return candidate;
  }
  return null;
}

const python = findBackendPython();
if (!python) {
  console.error("\nCHOPSTICKS DEV: splitter backend environment is not ready.\n");
  console.error("From the repo root run:");
  if (isWindows) {
    console.error("  py -3.12 -m venv .\\backend\\.venv");
    console.error("  .\\backend\\.venv\\Scripts\\python.exe -m pip install -r .\\backend\\requirements.txt");
  } else {
    console.error("  python3 -m venv ./backend/.venv");
    console.error("  ./backend/.venv/bin/python -m pip install -r ./backend/requirements.txt");
  }
  console.error("\nUse `npm run dev:web` only if you intentionally want the frontend without SPLIT.\n");
  process.exit(1);
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

console.log("CHOPSTICKS DEV: starting splitter on http://127.0.0.1:8788");
launch(
  python.command,
  [...python.prefix, "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", "8788"],
  "Splitter backend",
);

const npx = isWindows ? "npx.cmd" : "npx";
console.log("CHOPSTICKS DEV: starting Vite frontend");
launch(npx, ["vite"], "Vite frontend");
