import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const venvDir = path.join(repoRoot, ".venv");
const requirementsPath = path.join(repoRoot, "requirements.txt");

function venvPythonPath() {
  if (process.platform === "win32") {
    return path.join(venvDir, "Scripts", "python.exe");
  }
  return path.join(venvDir, "bin", "python");
}

const pythonInVenv = venvPythonPath();

/** @returns {{ command: string, prefixArgs: string[] }} */
function resolveHostPython() {
  const tryRun = (command, prefixArgs) => {
    const result = spawnSync(command, [...prefixArgs, "-c", "print(1)"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    if (result.status === 0) {
      return { command, prefixArgs };
    }
    return null;
  };

  if (process.platform === "win32") {
    return (
      tryRun("py", ["-3"]) ??
      tryRun("python", []) ??
      null
    );
  }
  return (
    tryRun("python3", []) ??
    tryRun("python", []) ??
    null
  );
}

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const hostPython = resolveHostPython();
if (!hostPython) {
  console.error(
    "Could not find Python. Install Python 3 and ensure `python` / `python3` (Unix) or `py -3` / `python` (Windows) works on PATH.",
  );
  process.exit(1);
}

if (!fs.existsSync(venvDir)) {
  console.log("Creating .venv...");
  run(hostPython.command, [...hostPython.prefixArgs, "-m", "venv", ".venv"]);
}

if (!fs.existsSync(pythonInVenv)) {
  console.error(
    `Expected venv interpreter at ${pythonInVenv} but it is missing. Remove the broken .venv folder and run this script again.`,
  );
  process.exit(1);
}

console.log("Upgrading pip/setuptools/wheel...");
run(pythonInVenv, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"]);

if (!fs.existsSync(requirementsPath)) {
  console.error("Missing requirements.txt");
  process.exit(1);
}

console.log("Installing Python dependencies...");
run(pythonInVenv, ["-m", "pip", "install", "-r", "requirements.txt"]);

console.log("Done. Local environment ready at .venv");
