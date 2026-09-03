import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stripInheritedPythonHome } from "./pythonEnvSanitize";

// Historical Electron-only implementation. Tauri runtime targets are authoritative in
// src-tauri/src/runtime.rs; do not copy or update release targets from this file.
export const PYTHON_VERSION = "3.12.7";
export const PYTHON_RELEASE = "20241016";
export const UV_VERSION = "0.11.19";

const PYTHON_BASE_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}`;
const UV_BASE_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

type Platform = "darwin-arm64" | "win-x64";

interface PythonTarget {
  archive: string;
  standalonePythonRel: string;
}

interface UvTarget {
  archive: string;
  archiveKind: "tar.gz" | "zip";
  uvRel: string;
}

const PYTHON_TARGETS: Record<Platform, PythonTarget> = {
  "darwin-arm64": {
    archive: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz`,
    standalonePythonRel: "python/bin/python3",
  },
  "win-x64": {
    archive: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-x86_64-pc-windows-msvc-shared-install_only_stripped.tar.gz`,
    standalonePythonRel: "python/python.exe",
  },
};

const UV_TARGETS: Record<Platform, UvTarget> = {
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

export interface RuntimeMetadata {
  pythonVersion: string;
  uvVersion: string;
  installedAt: string;
  platform: Platform;
  /** Legacy fields retained for reading older metadata only. */
  pypiIndexUrl?: string;
  depsInstalledAt?: string;
}

export interface DownloadProgress {
  stage: "check" | "download_python" | "extract_python" | "download_uv" | "extract_uv" | "install_deps" | "complete";
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: DownloadProgress) => void;
type FetchLike = typeof fetch;

function detectPlatform(): Platform {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      return "darwin-arm64";
    }
    throw new Error(`Unsupported macOS arch: ${process.arch}`);
  }
  if (process.platform === "win32") {
    if (process.arch === "x64") {
      return "win-x64";
    }
    throw new Error(`Unsupported Windows arch: ${process.arch}`);
  }
  throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
}

function venvPythonPath(venvDir: string): string {
  if (process.platform === "win32") {
    return path.join(venvDir, "Scripts", "python.exe");
  }
  return path.join(venvDir, "bin", "python");
}

// An inherited PYTHONHOME/PYTHONPATH from the user's machine breaks the bundled
// python-build-standalone interpreter during `uv venv` ("No module named
// 'encodings'"). Strip it on Windows; off-Windows the venv stdlib is configured
// explicitly by callers, so leave the env untouched.
function runtimeBaseEnv(): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return process.env;
  }
  return stripInheritedPythonHome({ ...process.env });
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    env: options.env ?? runtimeBaseEnv(),
    cwd: options.cwd,
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || "";
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr}`);
  }
}

async function downloadFile(
  url: string,
  destination: string,
  fetchImpl: FetchLike,
  onProgress?: (downloaded: number, total: number) => void
): Promise<Buffer> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  const totalBytes = parseInt(response.headers.get("content-length") || "0", 10);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const chunks: Uint8Array[] = [];
  let downloaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;
    if (onProgress && totalBytes > 0) {
      onProgress(downloaded, totalBytes);
    }
  }

  const buffer = Buffer.concat(chunks);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer);
  return buffer;
}

async function verifySha256(archivePath: string, checksumUrl: string, fetchImpl: FetchLike): Promise<void> {
  try {
    const response = await fetchImpl(checksumUrl);
    if (!response.ok) {
      console.warn(`Skipping SHA256 verification (missing ${checksumUrl})`);
      return;
    }
    const expected = (await response.text()).trim().split(/\s+/)[0];
    const actual = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
    if (expected !== actual) {
      throw new Error(`SHA256 mismatch for ${path.basename(archivePath)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("SHA256 mismatch")) {
      throw error;
    }
    console.warn(`SHA256 verification failed: ${error}`);
  }
}

function extractTarGz(archivePath: string, extractDir: string): void {
  fs.mkdirSync(extractDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", extractDir]);
}

function extractZip(archivePath: string, extractDir: string): void {
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

function isRuntimeValid(runtimeDir: string, platform: Platform): boolean {
  const metadataPath = path.join(runtimeDir, ".metadata.json");
  if (!fs.existsSync(metadataPath)) {
    return false;
  }

  try {
    const metadata: RuntimeMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    return (
      metadata.pythonVersion === PYTHON_VERSION &&
      metadata.uvVersion === UV_VERSION &&
      metadata.platform === platform
    );
  } catch {
    return false;
  }
}

async function ensureUvBinary(
  runtimeDir: string,
  platform: Platform,
  onProgress: ProgressCallback,
  fetchImpl: FetchLike
): Promise<string> {
  const uvConfig = UV_TARGETS[platform];
  const cacheDir = path.join(runtimeDir, ".cache", "uv", UV_VERSION);
  const archivePath = path.join(cacheDir, uvConfig.archive);
  const extractDir = path.join(cacheDir, "extracted");
  const uvOutputDir = path.join(runtimeDir, `uv-${UV_VERSION}`);

  if (!fs.existsSync(archivePath)) {
    const archiveUrl = `${UV_BASE_URL}/${uvConfig.archive}`;
    onProgress({ stage: "download_uv", percent: 0, message: "Downloading uv..." });

    await downloadFile(archiveUrl, archivePath, fetchImpl, (downloaded, total) => {
      const percent = Math.floor((downloaded / total) * 100);
      onProgress({ stage: "download_uv", percent, message: `Downloading uv... ${percent}%` });
    });
  }

  await verifySha256(archivePath, `${UV_BASE_URL}/${uvConfig.archive}.sha256`, fetchImpl);

  if (fs.existsSync(uvOutputDir)) {
    fs.rmSync(uvOutputDir, { recursive: true, force: true });
  }
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  onProgress({ stage: "extract_uv", percent: 0, message: "Extracting uv..." });

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

  onProgress({ stage: "extract_uv", percent: 100, message: "uv ready" });
  return destUv;
}

export async function ensureRuntime(
  runtimeDir: string,
  onProgress: ProgressCallback,
  options: { fetchImpl?: FetchLike } = {}
): Promise<{ pythonPath: string; uvPath: string }> {
  // Startup intentionally bootstraps only Python, uv, and an empty venv. The
  // workspace/tool dependencies are installed by their owning lazy workflow.
  const fetchImpl = options.fetchImpl ?? fetch;
  const platform = detectPlatform();

  onProgress({ stage: "check", percent: 0, message: "Checking runtime..." });

  // Check if valid runtime already exists
  // If metadata matches our locked versions, consider it fully configured - skip all network calls
  if (isRuntimeValid(runtimeDir, platform)) {
    const pythonRuntimeDir = path.join(runtimeDir, `python-${PYTHON_VERSION}`);
    const uvBinName = process.platform === "win32" ? "uv.exe" : "uv";
    const uvPath = path.join(runtimeDir, `uv-${UV_VERSION}`, uvBinName);
    const pythonPath = venvPythonPath(pythonRuntimeDir);

    if (fs.existsSync(pythonPath) && fs.existsSync(uvPath)) {
      // Metadata matches locked versions - runtime is valid, skip all network operations
      onProgress({ stage: "complete", percent: 100, message: "Runtime ready" });
      return { pythonPath, uvPath };
    }
  }

  // Clean up old/invalid runtime
  if (fs.existsSync(runtimeDir)) {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
  fs.mkdirSync(runtimeDir, { recursive: true });

  const pythonConfig = PYTHON_TARGETS[platform];
  const cacheDir = path.join(runtimeDir, ".cache", "python-build-standalone");
  const archivePath = path.join(cacheDir, pythonConfig.archive);
  const extractDir = path.join(cacheDir, "extracted");
  const standalonePython = path.join(extractDir, pythonConfig.standalonePythonRel);
  const pythonRuntimeDir = path.join(runtimeDir, `python-${PYTHON_VERSION}`);
  const runtimePython = venvPythonPath(pythonRuntimeDir);

  fs.mkdirSync(cacheDir, { recursive: true });

  // Download Python if not cached
  if (!fs.existsSync(archivePath)) {
    const archiveUrl = `${PYTHON_BASE_URL}/${pythonConfig.archive}`;
    onProgress({ stage: "download_python", percent: 0, message: "Downloading Python..." });

    await downloadFile(archiveUrl, archivePath, fetchImpl, (downloaded, total) => {
      const percent = Math.floor((downloaded / total) * 100);
      onProgress({ stage: "download_python", percent, message: `Downloading Python... ${percent}%` });
    });
  }

  await verifySha256(archivePath, `${PYTHON_BASE_URL}/${pythonConfig.archive}.sha256`, fetchImpl);

  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  onProgress({ stage: "extract_python", percent: 0, message: "Extracting Python..." });
  extractTarGz(archivePath, extractDir);

  if (!fs.existsSync(standalonePython)) {
    throw new Error(`Expected standalone interpreter at ${standalonePython}`);
  }

  onProgress({ stage: "extract_python", percent: 50, message: "Creating virtual environment..." });

  // Ensure uv is available
  const uvBin = await ensureUvBinary(runtimeDir, platform, onProgress, fetchImpl);

  // Create venv
  run(uvBin, ["venv", "--python", standalonePython, pythonRuntimeDir]);

  if (!fs.existsSync(runtimePython)) {
    throw new Error(`Expected venv interpreter at ${runtimePython}`);
  }

  // Fix symlinks and copy stdlib on macOS
  if (process.platform !== "win32") {
    onProgress({ stage: "extract_python", percent: 70, message: "Configuring Python runtime..." });

    const binDir = path.join(pythonRuntimeDir, "bin");
    const realPythonSrc = fs.realpathSync(standalonePython);
    const versionedName = `python${PYTHON_VERSION.split(".").slice(0, 2).join(".")}`;
    const versionedDest = path.join(binDir, versionedName);

    try { fs.unlinkSync(versionedDest); } catch { /* may not exist */ }
    fs.copyFileSync(realPythonSrc, versionedDest);
    fs.chmodSync(versionedDest, 0o755);

    // Copy dylib
    const standaloneLibDir = path.join(path.dirname(path.dirname(realPythonSrc)), "lib");
    const dylibName = `libpython${PYTHON_VERSION.split(".").slice(0, 2).join(".")}.dylib`;
    const dylibSrc = path.join(standaloneLibDir, dylibName);

    if (fs.existsSync(dylibSrc)) {
      const venvLibDir = path.join(pythonRuntimeDir, "lib");
      fs.mkdirSync(venvLibDir, { recursive: true });
      const dylibDest = path.join(venvLibDir, dylibName);
      fs.copyFileSync(dylibSrc, dylibDest);
      fs.chmodSync(dylibDest, 0o755);
      run("install_name_tool", ["-id", `@executable_path/../lib/${dylibName}`, dylibDest]);
      run("install_name_tool", [
        "-change", `/install/lib/${dylibName}`,
        `@executable_path/../lib/${dylibName}`,
        versionedDest,
      ]);
    }

    // Fix symlinks
    for (const alias of ["python", "python3"]) {
      const linkPath = path.join(binDir, alias);
      try { fs.unlinkSync(linkPath); } catch { /* may not exist */ }
      fs.symlinkSync(versionedName, linkPath);
    }

    // Copy stdlib
    const pyMinor = PYTHON_VERSION.split(".").slice(0, 2).join(".");
    const stdlibSrc = path.join(standaloneLibDir, `python${pyMinor}`);
    if (fs.existsSync(stdlibSrc)) {
      const venvLibDir = path.join(pythonRuntimeDir, "lib");
      const stdlibDest = path.join(venvLibDir, `python${pyMinor}`);
      if (fs.existsSync(stdlibDest)) {
        fs.rmSync(stdlibDest, { recursive: true, force: true });
      }
      run("cp", ["-a", stdlibSrc, stdlibDest]);
      run("find", [stdlibDest, "-type", "d", "-name", "__pycache__", "-exec", "rm", "-rf", "{}", "+"]);
    }

    // Fix pyvenv.cfg
    const pyvenvCfg = path.join(pythonRuntimeDir, "pyvenv.cfg");
    if (fs.existsSync(pyvenvCfg)) {
      let cfg = fs.readFileSync(pyvenvCfg, "utf8");
      cfg = cfg.replace(/^home\s*=\s*.+$/m, `home = ${binDir}`);
      fs.writeFileSync(pyvenvCfg, cfg);
    }
  }

  // Persist bootstrap metadata as soon as Python and uv are usable. Dependency
  // installation is intentionally handled by lazy workspace/tool workflows.
  const metadataPath = path.join(runtimeDir, ".metadata.json");
  const metadata: RuntimeMetadata = {
    pythonVersion: PYTHON_VERSION,
    uvVersion: UV_VERSION,
    installedAt: new Date().toISOString(),
    platform,
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  onProgress({ stage: "complete", percent: 100, message: "Runtime ready" });

  return { pythonPath: runtimePython, uvPath: uvBin };
}

export const PILLOW_VERSION = "12.1.1";

function runtimePythonEnv(pythonRuntimeDir: string): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return stripInheritedPythonHome({ ...process.env });
  }
  return { ...process.env, PYTHONHOME: pythonRuntimeDir };
}

/** Install Pillow only when an image asset workflow needs it. */
export function ensurePillow(
  runtimeDir: string,
  onProgress?: ProgressCallback,
): { pythonPath: string; uvPath: string } {
  detectPlatform();
  const pythonRuntimeDir = path.join(runtimeDir, `python-${PYTHON_VERSION}`);
  const uvBinName = process.platform === "win32" ? "uv.exe" : "uv";
  const uvPath = path.join(runtimeDir, `uv-${UV_VERSION}`, uvBinName);
  const pythonPath = venvPythonPath(pythonRuntimeDir);
  if (!fs.existsSync(pythonPath) || !fs.existsSync(uvPath)) {
    throw new Error("Managed Python runtime is unavailable; bootstrap it before installing Pillow");
  }

  const toolDir = path.join(runtimeDir, "asset-tools");
  const toolPython = venvPythonPath(toolDir);
  const env = runtimePythonEnv(pythonRuntimeDir);
  if (!fs.existsSync(toolPython)) {
    run(uvPath, ["venv", "--python", pythonPath, toolDir], { env });
  }
  const toolEnv = runtimePythonEnv(toolDir);
  const probe = spawnSync(toolPython, ["-c", "import PIL"], { stdio: "pipe", env: toolEnv });
  if (probe.status !== 0) {
    onProgress?.({ stage: "install_deps", percent: 0, message: "Installing image tooling (Pillow)..." });
    run(uvPath, ["pip", "install", "--python", toolPython, `Pillow==${PILLOW_VERSION}`], { env: toolEnv });
  }

  const verified = spawnSync(toolPython, ["-c", "import PIL"], { stdio: "pipe", env: toolEnv });
  if (verified.status !== 0) {
    const stderr = verified.stderr?.toString().trim();
    throw new Error(`Pillow installation did not make PIL importable${stderr ? `: ${stderr}` : ""}`);
  }
  onProgress?.({ stage: "install_deps", percent: 100, message: "Image tooling ready" });
  return { pythonPath: toolPython, uvPath };
}
