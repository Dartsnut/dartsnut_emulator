import fs from "node:fs";
import path from "node:path";

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

export function bundledPythonRuntimeDir(resourcesPath: string): string {
  return path.join(resourcesPath, "python-runtime");
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

export function bundledUvBin(resourcesPath: string): string {
  const binName = process.platform === "win32" ? "uv.exe" : "uv";
  return path.join(resourcesPath, "uv", binName);
}

export function shouldUseUvRunner(isPackaged: boolean, resourcesPath: string): boolean {
  if (!isPackaged) {
    return false;
  }
  const uvBin = bundledUvBin(resourcesPath);
  return fs.existsSync(uvBin);
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
    UV_NO_PYTHON_DOWNLOADS: "never",
    UV_NO_MANAGED_PYTHON: "1",
    UV_NO_PROJECT: "1",
    UV_PYTHON: pythonPath,
  };
  if (uvBin) {
    env[DARTSNUT_UV_BIN_ENV] = uvBin;
  }
  const venvDir = venvDirForPython(pythonPath);
  if (venvDir) {
    env.VIRTUAL_ENV = venvDir;
    const binDir = path.dirname(pythonPath);
    env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
  }
  return sanitizeUvNoProjectEnv(env);
}

export function buildPythonScriptLaunch(options: {
  isPackaged: boolean;
  resourcesPath: string;
  pythonPath: string;
  scriptPath: string;
  scriptArgs?: string[];
  baseEnv?: NodeJS.ProcessEnv;
}): PythonScriptLaunch {
  const scriptArgs = options.scriptArgs ?? [];
  const useUv = shouldUseUvRunner(options.isPackaged, options.resourcesPath);
  if (useUv) {
    const uvBin = bundledUvBin(options.resourcesPath);
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
  const env: NodeJS.ProcessEnv = { ...options.baseEnv, PYTHONUNBUFFERED: "1" };
  const venvDir = venvDirForPython(options.pythonPath);
  if (venvDir) {
    env.VIRTUAL_ENV = venvDir;
    const binDir = path.dirname(options.pythonPath);
    env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
  }
  return {
    command: options.pythonPath,
    args: [options.scriptPath, ...scriptArgs],
    env,
    runtimeKey: options.pythonPath,
    label: options.pythonPath,
    pythonPath: options.pythonPath,
  };
}
