import type { ProjectType } from "@dartsnut/shared-ipc";

export type BuildSyncWorkspaceScriptOptions = {
  appId: string;
  password: string;
  remoteUploadTgz: string;
};

export function buildSyncWorkspaceScript({
  appId,
  password,
  remoteUploadTgz,
}: BuildSyncWorkspaceScriptOptions): string {
  const escapedAppId = appId.replace(/'/g, "'\\''");
  return [
    "set -eo pipefail",
    "PASS=" + JSON.stringify(password),
    "TGZ=" + remoteUploadTgz,
    "APPID='" + escapedAppId + "'",
    'BASE="$HOME/dartsnut_rpi/apps"',
    'TARGET="$BASE/$APPID"',
    'STAGING="${TARGET}.new.${RANDOM}"',
    'echo "$PASS" | sudo -S rm -rf "$STAGING"',
    'echo "$PASS" | sudo -S mkdir -p "$BASE"',
    'echo "$PASS" | sudo -S mkdir -p "$STAGING"',
    'echo "$PASS" | sudo -S tar -xzf "$TGZ" -C "$STAGING"',
    'echo "$PASS" | sudo -S rm -rf "$TARGET"',
    'echo "$PASS" | sudo -S mv "$STAGING" "$TARGET"',
    'rm -f "$TGZ"',
  ].join("\n");
}

export type BuildEnsureAppVenvScriptOptions = {
  root: string;
  appId: string;
  password: string;
  uvRelPath?: string;
};

/** Remote bash: `cd` firmware root and run firmware `ensure_app_venv` via vendored uv. */
export function buildEnsureAppVenvScript({
  root,
  appId,
  password,
  uvRelPath = "./uv",
}: BuildEnsureAppVenvScriptOptions): string {
  const pySnippet = [
    "from core.app_env import ensure_app_venv",
    "import sys",
    `sys.exit(0 if ensure_app_venv(${JSON.stringify(appId)}) else 1)`,
  ].join("; ");
  return [
    "set -eo pipefail",
    "PASS=" + JSON.stringify(password),
    `cd ${JSON.stringify(root)}`,
    `echo "$PASS" | sudo -S ${uvRelPath} run python -c ${JSON.stringify(pySnippet)}`,
  ].join("\n");
}

export type BuildDebugLaunchInnerOptions = {
  appDir: string;
  pythonBin: string;
  mainScript: string;
  projectType: ProjectType;
  paramsB64?: string;
};

/**
 * Widget: multiline bash for heredoc runner. Game: one-liner for `sudo bash -c`.
 */
export function buildDebugLaunchInner({
  appDir,
  pythonBin,
  mainScript,
  projectType,
  paramsB64,
}: BuildDebugLaunchInnerOptions): string {
  const common = [
    `cd ${JSON.stringify(appDir)}`,
    "export PYTHONUNBUFFERED=1 DARTSNUT_LOG_LEVEL=INFO",
  ];
  if (projectType === "widget") {
    if (!paramsB64) {
      throw new Error("paramsB64 required for widget debug launch");
    }
    return [
      "#!/usr/bin/env bash",
      "set -eo pipefail",
      ...common,
      `PARAMS=$(printf '%s' '${paramsB64}' | base64 -d)`,
      `exec ${JSON.stringify(pythonBin)} -u ${JSON.stringify(mainScript)} --params "$PARAMS"`,
    ].join("\n");
  }
  return [
    ...common,
    `exec ${JSON.stringify(pythonBin)} -u ${JSON.stringify(mainScript)}`,
  ].join(" && ");
}

export function remoteLegacyPythonBin(root: string): string {
  return `${root}/venv0/bin/python`;
}

export function remoteAppPythonBin(root: string, appId: string): string {
  return `${root}/apps/${appId}/.venv/bin/python`;
}
