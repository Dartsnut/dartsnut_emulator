import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const venvDir = path.join(repoRoot, ".venv");
const pythonInVenv = path.join(venvDir, "bin", "python");
const requirementsPath = path.join(repoRoot, "requirement.txt");

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

if (!fs.existsSync(venvDir)) {
  console.log("Creating .venv...");
  run("python3", ["-m", "venv", ".venv"]);
}

console.log("Upgrading pip/setuptools/wheel...");
run(pythonInVenv, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"]);

if (!fs.existsSync(requirementsPath)) {
  console.error("Missing requirement.txt");
  process.exit(1);
}

console.log("Installing Python dependencies...");
run(pythonInVenv, ["-m", "pip", "install", "-r", "requirement.txt"]);

console.log("Done. Local environment ready at .venv");
