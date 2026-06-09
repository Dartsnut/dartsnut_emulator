import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requirementsPath = path.join(repoRoot, "requirements.txt");
const runtimeOutputDir = path.join(repoRoot, "apps", "desktop", "resources", "python-runtime");
const uvOutputDir = path.join(repoRoot, "apps", "desktop", "resources", "uv");

const PYTHON_RELEASE = "20241016";
const PYTHON_VERSION = "3.12.7";
const PYTHON_BASE_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}`;

const UV_VERSION = "0.11.19";
const UV_BASE_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

/** @type {Record<string, { archive: string; standalonePythonRel: string }>} */
const PYTHON_TARGETS = {
  "darwin-arm64": {
    archive: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz`,
    standalonePythonRel: "python/bin/python3",
  },
  "win-x64": {
    archive: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-x86_64-pc-windows-msvc-shared-install_only_stripped.tar.gz`,
    standalonePythonRel: "python/python.exe",
  },
};

/** @type {Record<string, { archive: string; archiveKind: "tar.gz" | "zip"; uvRel: string }>} */
const UV_TARGETS = {
  "darwin-arm64": {
    archive: `uv-aarch64-apple-darwin.tar.gz`,
    archiveKind: "tar.gz",
    uvRel: "uv-aarch64-apple-darwin/uv",
  },
  "win-x64": {
    archive: `uv-x86_64-pc-windows-msvc.zip`,
    archiveKind: "zip",
    uvRel: "uv.exe",
  },
};

function parseArgs(argv) {
  let target = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target" && argv[i + 1]) {
      target = argv[i + 1];
      i += 1;
    }
  }
  return { target };
}

function detectTarget() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      return "darwin-arm64";
    }
    throw new Error(`Unsupported macOS arch for bundled Python: ${process.arch}`);
  }
  if (process.platform === "win32") {
    if (process.arch === "x64") {
      return "win-x64";
    }
    throw new Error(`Unsupported Windows arch for bundled Python: ${process.arch}`);
  }
  throw new Error(
    `Bundled Python build is only supported on macOS arm64 and Windows x64 (got ${process.platform}/${process.arch}).`,
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function venvPythonPath(venvDir) {
  if (process.platform === "win32") {
    return path.join(venvDir, "Scripts", "python.exe");
  }
  return path.join(venvDir, "bin", "python");
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  return bytes;
}

async function verifySha256(archivePath, checksumUrl) {
  const response = await fetch(checksumUrl);
  if (!response.ok) {
    console.warn(`Skipping SHA256 verification (missing ${checksumUrl}).`);
    return;
  }
  const expected = (await response.text()).trim().split(/\s+/)[0];
  const actual = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
  if (expected !== actual) {
    throw new Error(`SHA256 mismatch for ${path.basename(archivePath)}`);
  }
}

function extractTarGz(archivePath, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", extractDir]);
}

function extractZip(archivePath, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
    ]);
    return;
  }
  run("unzip", ["-oq", archivePath, "-d", extractDir]);
}

async function ensureUvBinary(target) {
  const uvConfig = UV_TARGETS[target];
  const cacheDir = path.join(repoRoot, ".cache", "uv", UV_VERSION);
  const archivePath = path.join(cacheDir, uvConfig.archive);
  const extractDir = path.join(cacheDir, "extracted");

  if (!fs.existsSync(archivePath)) {
    const archiveUrl = `${UV_BASE_URL}/${uvConfig.archive}`;
    console.log(`Downloading ${archiveUrl}`);
    await downloadFile(archiveUrl, archivePath);
  } else {
    console.log(`Using cached uv archive ${archivePath}`);
  }

  await verifySha256(archivePath, `${UV_BASE_URL}/${uvConfig.archive}.sha256`);

  if (fs.existsSync(uvOutputDir)) {
    fs.rmSync(uvOutputDir, { recursive: true, force: true });
  }
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  console.log("Extracting uv...");
  if (uvConfig.archiveKind === "zip") {
    extractZip(archivePath, extractDir);
  } else {
    extractTarGz(archivePath, extractDir);
  }

  const extractedUv = path.join(extractDir, uvConfig.uvRel);
  if (!fs.existsSync(extractedUv)) {
    throw new Error(`Expected uv binary at ${extractedUv}`);
  }

  fs.mkdirSync(uvOutputDir, { recursive: true });
  const uvBinName = process.platform === "win32" ? "uv.exe" : "uv";
  const destUv = path.join(uvOutputDir, uvBinName);
  fs.copyFileSync(extractedUv, destUv);
  if (process.platform !== "win32") {
    fs.chmodSync(destUv, 0o755);
  }

  const marker = {
    target,
    uvVersion: UV_VERSION,
    builtAt: new Date().toISOString(),
    host: `${os.platform()}/${os.arch()}`,
  };
  fs.writeFileSync(path.join(uvOutputDir, ".bundled-uv.json"), `${JSON.stringify(marker, null, 2)}\n`);
  console.log(`Bundled uv ready at ${destUv}`);
  return destUv;
}

async function main() {
  const { target: targetArg } = parseArgs(process.argv.slice(2));
  const target = targetArg ?? detectTarget();
  const pythonConfig = PYTHON_TARGETS[target];
  if (!pythonConfig) {
    throw new Error(`Unknown target "${target}". Expected one of: ${Object.keys(PYTHON_TARGETS).join(", ")}`);
  }
  if (!fs.existsSync(requirementsPath)) {
    throw new Error(`Missing requirements.txt at ${requirementsPath}`);
  }

  const uvBin = await ensureUvBinary(target);

  const cacheDir = path.join(repoRoot, ".cache", "python-build-standalone");
  const archivePath = path.join(cacheDir, pythonConfig.archive);
  const extractDir = path.join(cacheDir, target, "extracted");
  const standalonePython = path.join(extractDir, pythonConfig.standalonePythonRel);
  const runtimePython = venvPythonPath(runtimeOutputDir);

  console.log(`Building bundled Python runtime for ${target}...`);
  fs.mkdirSync(cacheDir, { recursive: true });

  if (!fs.existsSync(archivePath)) {
    const archiveUrl = `${PYTHON_BASE_URL}/${pythonConfig.archive}`;
    console.log(`Downloading ${archiveUrl}`);
    await downloadFile(archiveUrl, archivePath);
  } else {
    console.log(`Using cached archive ${archivePath}`);
  }

  await verifySha256(archivePath, `${PYTHON_BASE_URL}/${pythonConfig.archive}.sha256`);

  if (fs.existsSync(runtimeOutputDir)) {
    fs.rmSync(runtimeOutputDir, { recursive: true, force: true });
  }
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  console.log("Extracting standalone Python...");
  extractTarGz(archivePath, extractDir);
  if (!fs.existsSync(standalonePython)) {
    throw new Error(`Expected standalone interpreter at ${standalonePython}`);
  }

  console.log("Creating virtual environment with uv...");
  run(uvBin, ["venv", "--python", standalonePython, runtimeOutputDir], { cwd: repoRoot });

  if (!fs.existsSync(runtimePython)) {
    throw new Error(`Expected venv interpreter at ${runtimePython}`);
  }

  console.log("Installing emulator dependencies with uv...");
  run(uvBin, ["pip", "install", "--python", runtimePython, "-r", requirementsPath], { cwd: repoRoot });

  console.log("Verifying bundled runtime...");
  run(
    runtimePython,
    ["-c", "import sys; import pydartsnut, pygame, PIL; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"],
    { cwd: repoRoot },
  );

  console.log("Verifying uv run launcher...");
  run(
    uvBin,
    [
      "run",
      "--no-project",
      "--python",
      runtimePython,
      "python",
      "-c",
      "import pydartsnut, pygame, PIL; print('uv-run-ok')",
    ],
    {
      cwd: repoRoot,
      env: (() => {
        const env = {
          ...process.env,
          UV_NO_PYTHON_DOWNLOADS: "never",
          UV_NO_MANAGED_PYTHON: "1",
          UV_NO_PROJECT: "1",
          UV_PYTHON: runtimePython,
          VIRTUAL_ENV: runtimeOutputDir,
        };
        delete env.UV_NO_SYNC;
        return env;
      })(),
    },
  );

  const marker = {
    target,
    pythonVersion: PYTHON_VERSION,
    pythonRelease: PYTHON_RELEASE,
    uvVersion: UV_VERSION,
    builtAt: new Date().toISOString(),
    host: `${os.platform()}/${os.arch()}`,
  };
  fs.writeFileSync(path.join(runtimeOutputDir, ".bundled-python.json"), `${JSON.stringify(marker, null, 2)}\n`);

  console.log(`Bundled Python runtime ready at ${runtimeOutputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
