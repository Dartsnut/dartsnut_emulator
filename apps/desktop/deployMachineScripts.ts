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

export type BuildDebugLaunchScriptOptions = BuildDebugLaunchInnerOptions & {
  logPath: string;
  pidPath: string;
  password: string;
  widgetRunnerPath: string;
  launchWrapperPath: string;
  eofMarker: string;
};

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildLaunchWrapper(command: string, logPath: string, pidPath: string): string {
  return [
    "#!/usr/bin/env bash",
    `LOG=${shellSingleQuote(logPath)}`,
    `PIDFILE=${shellSingleQuote(pidPath)}`,
    "set -eo pipefail",
    `setsid ${command} >> "$LOG" 2>&1 &`,
    "child=$!",
    'echo $! > "$PIDFILE"',
    'printf "%s\\n" "[deploy] launched pid $child" >> "$LOG"',
    'set +e',
    'wait "$child"',
    'code=$?',
    'set -e',
    'printf "%s\\n" "[deploy] python exited $code" >> "$LOG"',
    'exit "$code"',
  ].join("\n");
}

export function buildDebugLaunchScript({
  appDir,
  pythonBin,
  mainScript,
  projectType,
  paramsB64,
  logPath,
  pidPath,
  password,
  widgetRunnerPath,
  launchWrapperPath,
  eofMarker,
}: BuildDebugLaunchScriptOptions): string {
  const scriptHead = [
    "set -eo pipefail",
    "LOG=" + logPath,
    "PIDFILE=" + pidPath,
    "PASS=" + JSON.stringify(password),
    'echo "$PASS" | sudo -S truncate -s 0 "$LOG" 2>/dev/null || true',
    'echo "$PASS" | sudo -S chmod 666 "$LOG" 2>/dev/null || true',
    'printf "%s\\n" "[deploy] spawning python $(date -Is)" >> "$LOG"',
  ];
  const innerBody = buildDebugLaunchInner({
    appDir,
    pythonBin,
    mainScript,
    projectType,
    paramsB64,
  });
  const launchWrapper = buildLaunchWrapper(
    projectType === "widget"
      ? `bash ${JSON.stringify(widgetRunnerPath)}`
      : `bash -c ${JSON.stringify(innerBody)}`,
    logPath,
    pidPath,
  );
  const launchLines = [
    `echo "$PASS" | sudo -S tee ${JSON.stringify(launchWrapperPath)} > /dev/null <<'${eofMarker}_LAUNCH'`,
    launchWrapper,
    `${eofMarker}_LAUNCH`,
    `echo "$PASS" | sudo -S chmod 755 ${JSON.stringify(launchWrapperPath)} 2>/dev/null || true`,
    `echo "$PASS" | nohup sudo -S bash ${JSON.stringify(launchWrapperPath)} > /dev/null 2>&1 < /dev/null &`,
  ];
  if (projectType === "widget") {
    return [
      ...scriptHead,
      `echo "$PASS" | sudo -S tee ${JSON.stringify(widgetRunnerPath)} > /dev/null <<'${eofMarker}'`,
      innerBody,
      eofMarker,
      `echo "$PASS" | sudo -S chmod 755 ${JSON.stringify(widgetRunnerPath)} 2>/dev/null || true`,
      ...launchLines,
    ].join("\n");
  }
  return [
    ...scriptHead,
    ...launchLines,
  ].join("\n");
}

export type BuildKillDebugPythonScriptOptions = {
  password: string;
  pidPath: string;
};

export function buildKillDebugPythonScript({
  password,
  pidPath,
}: BuildKillDebugPythonScriptOptions): string {
  return [
    "set -eo pipefail",
    "PASS=" + JSON.stringify(password),
    "PIDFILE=" + pidPath,
    'if [ -f "$PIDFILE" ]; then',
    '  pid="$(echo "$PASS" | sudo -S cat "$PIDFILE" 2>/dev/null || true)"',
    '  if [ -n "$pid" ]; then',
    '    echo "$PASS" | sudo -S kill -- -"$pid" 2>/dev/null || true',
    '    echo "$PASS" | sudo -S kill "$pid" 2>/dev/null || true',
    "  fi",
    '  echo "$PASS" | sudo -S rm -f "$PIDFILE"',
    "fi",
  ].join("\n");
}

export type BuildKillAppMainPyProcessesScriptOptions = {
  appId?: string;
  password: string;
  pidPath: string;
};

export function buildKillAppMainPyProcessesScript({
  appId,
  password,
  pidPath,
}: BuildKillAppMainPyProcessesScriptOptions): string {
  const appPattern = appId == null
    ? "[^/]+"
    : appId.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  return [
    "set -eo pipefail",
    "PASS=" + JSON.stringify(password),
    "PIDFILE=" + pidPath,
    `APP_RE=${JSON.stringify(appPattern)}`,
    'legacy_pattern="dartsnut_rpi/apps/$APP_RE/main\\.py"',
    'uv_pattern="dartsnut_rpi/apps/$APP_RE/\\.venv/bin/python.*(^|[ ])main\\.py"',
    'echo "$PASS" | sudo -S pkill -f "$legacy_pattern" 2>/dev/null || true',
    'echo "$PASS" | sudo -S pkill -f "$uv_pattern" 2>/dev/null || true',
    'echo "$PASS" | sudo -S rm -f "$PIDFILE"',
  ].join("\n");
}

export function remoteLegacyPythonBin(root: string): string {
  return `${root}/venv0/bin/python`;
}

export function remoteAppPythonBin(root: string, appId: string): string {
  return `${root}/apps/${appId}/.venv/bin/python`;
}
