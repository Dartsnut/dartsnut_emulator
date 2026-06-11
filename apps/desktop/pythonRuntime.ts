import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { PYTHON_VERSION, UV_VERSION } from "./pythonRuntimeDownloader";

export interface PythonScriptLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Stable id for detecting when the launch configuration changed */
  runtimeKey: string;
  /** Human-readable label for logs */
  label: string;
  pythonPath: string;
}

export function venvPythonPath(venvDir: string): string {
  if (process.platform === "win32") {
    return path.join(venvDir, "Scripts", "python.exe");
  }
  return path.join(venvDir, "bin", "python");
}

export function runtimeDir(): string {
  return path.join(app.getPath("userData"), "runtime");
}

export function pythonRuntimeDir(): string {
  return path.join(runtimeDir(), `python-${PYTHON_VERSION}`);
}

export function uvBinaryPath(): string {
  const binName = process.platform === "win32" ? "uv.exe" : "uv";
  return path.join(runtimeDir(), `uv-${UV_VERSION}`, binName);
}

export function getPreferredPypiIndexUrl(): string | undefined {
  try {
    const metadataPath = path.join(runtimeDir(), ".metadata.json");
    if (!fs.existsSync(metadataPath)) {
      return undefined;
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    return metadata.pypiIndexUrl;
  } catch {
    return undefined;
  }
}

export const DARTSNUT_UV_BIN_ENV = "DARTSNUT_UV_BIN";

/** uv warns when this is set alongside `--no-project` (our packaged launch mode). */
const UV_ENV_STRIP_WITH_NO_PROJECT = ["UV_NO_SYNC"] as const;

export function sanitizeUvNoProjectEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of UV_ENV_STRIP_WITH_NO_PROJECT) {
    delete sanitized[key];
  }
  return sanitized;
}

function venvDirForPython(pythonPath: string): string | null {
  const normalized = path.resolve(pythonPath);
  const binDir = path.dirname(normalized);
  const baseName = path.basename(normalized).toLowerCase();
  if (process.platform === "win32") {
    if (baseName === "python.exe" && path.basename(binDir).toLowerCase() === "scripts") {
      return path.dirname(binDir);
    }
    return null;
  }
  if ((baseName === "python" || baseName.startsWith("python3")) && path.basename(binDir) === "bin") {
    return path.dirname(binDir);
  }
  return null;
}

export function buildUvOfflineEnv(
  pythonPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  uvBin?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PYTHONUNBUFFERED: "1",
    // Prevent Python from writing .pyc files into the signed .app bundle, which
    // would modify sealed resources and break codesign --verify.
    PYTHONDONTWRITEBYTECODE: "1",
    UV_NO_PYTHON_DOWNLOADS: "never",
    UV_NO_MANAGED_PYTHON: "1",
    UV_NO_PROJECT: "1",
    UV_PYTHON: pythonPath,
  };
  if (uvBin) {
    env[DARTSNUT_UV_BIN_ENV] = uvBin;
  }

  // Add preferred PyPI index URL if we have one
  const pypiIndexUrl = getPreferredPypiIndexUrl();
  if (pypiIndexUrl) {
    env.DARTSNUT_PYPI_INDEX_URL = pypiIndexUrl;
  }

  const venvDir = venvDirForPython(pythonPath);
  if (venvDir) {
    env.VIRTUAL_ENV = venvDir;
    // python-build-standalone binaries have /install hardcoded as sys.base_prefix.
    // Setting PYTHONHOME to the venv dir makes Python find its stdlib at
    // <venvDir>/lib/python3.x instead of the nonexistent /install/lib/python3.x.
    env.PYTHONHOME = venvDir;
    const binDir = path.dirname(pythonPath);
    env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
  }
  return sanitizeUvNoProjectEnv(env);
}

/**
 * Build a minimal env for probing a Python executable directly (without uv).
 * Sets PYTHONHOME so that python-build-standalone binaries find their stdlib
 * inside the venv dir rather than the hardcoded /install prefix.
 */
export function buildPythonProbeEnv(
  pythonPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const venvDir = venvDirForPython(pythonPath);
  if (venvDir) {
    env.VIRTUAL_ENV = venvDir;
    env.PYTHONHOME = venvDir;
    const binDir = path.dirname(pythonPath);
    env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
  }
  return env;
}

export function buildPythonScriptLaunch(options: {
  pythonPath: string;
  scriptPath: string;
  scriptArgs?: string[];
  baseEnv?: NodeJS.ProcessEnv;
}): PythonScriptLaunch {
  const scriptArgs = options.scriptArgs ?? [];
  const uvBin = uvBinaryPath();
  const env = buildUvOfflineEnv(options.pythonPath, options.baseEnv, uvBin);
  return {
    command: uvBin,
    args: ["run", "--no-project", "--python", options.pythonPath, options.scriptPath, ...scriptArgs],
    env,
    runtimeKey: `uv:${uvBin}:${options.pythonPath}`,
    label: `uv run (${options.pythonPath})`,
    pythonPath: options.pythonPath,
  };
}
