const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDebugLaunchInner,
  buildDebugLaunchScript,
  buildEnsureAppVenvScript,
  buildKillAppMainPyProcessesScript,
  buildKillDebugPythonScript,
  buildSyncWorkspaceScript,
  remoteAppPythonBin,
  remoteLegacyPythonBin,
} = require("./deployMachineScripts.ts");

const ROOT = "/home/rpi/dartsnut_rpi";
const APP_ID = "gshock-clock";
const APP_DIR = `${ROOT}/apps/${APP_ID}`;

test("buildSyncWorkspaceScript uses sudo for remote apps tree mutations", () => {
  const script = buildSyncWorkspaceScript({
    appId: APP_ID,
    password: "rpi",
    remoteUploadTgz: "/tmp/dartsnut_deploy_upload.tgz",
  });

  assert.match(script, /echo "\$PASS" \| sudo -S mkdir -p "\$BASE"/);
  assert.match(script, /echo "\$PASS" \| sudo -S mkdir -p "\$STAGING"/);
  assert.match(script, /echo "\$PASS" \| sudo -S tar -xzf "\$TGZ" -C "\$STAGING"/);
  assert.match(script, /echo "\$PASS" \| sudo -S mv "\$STAGING" "\$TARGET"/);
  assert.doesNotMatch(script, /\nmkdir -p "\$BASE"/);
  assert.doesNotMatch(script, /\nmkdir -p "\$STAGING"/);
  assert.doesNotMatch(script, /\ntar -xzf "\$TGZ" -C "\$STAGING"/);
  assert.doesNotMatch(script, /\nmv "\$STAGING" "\$TARGET"/);
});

test("buildEnsureAppVenvScript runs ensure_app_venv from firmware root via uv", () => {
  const script = buildEnsureAppVenvScript({
    root: ROOT,
    appId: APP_ID,
    password: "rpi",
  });

  assert.match(script, new RegExp(`cd ${JSON.stringify(ROOT)}`));
  assert.match(script, /\.\/uv run python -c/);
  assert.match(script, /ensure_app_venv/);
  assert.match(script, /echo "\$PASS" \| sudo -S/);
  assert.match(script, /ensure_app_venv\([^)]*gshock-clock/);
});

test("buildDebugLaunchInner uv widget uses app .venv and main.py", () => {
  const pythonBin = remoteAppPythonBin(ROOT, APP_ID);
  const inner = buildDebugLaunchInner({
    appDir: APP_DIR,
    pythonBin,
    mainScript: "main.py",
    projectType: "widget",
    paramsB64: "e30=",
  });

  assert.match(inner, new RegExp(JSON.stringify(pythonBin)));
  assert.match(inner, /"main\.py"/);
  assert.doesNotMatch(inner, /venv0/);
  assert.match(inner, /--params "\$PARAMS"/);
});

test("buildDebugLaunchInner legacy game uses venv0 and absolute main.py", () => {
  const pythonBin = remoteLegacyPythonBin(ROOT);
  const mainScript = `${APP_DIR}/main.py`;
  const inner = buildDebugLaunchInner({
    appDir: APP_DIR,
    pythonBin,
    mainScript,
    projectType: "game",
  });

  assert.match(inner, /venv0\/bin\/python/);
  assert.match(inner, new RegExp(JSON.stringify(mainScript)));
  assert.doesNotMatch(inner, /\.venv\/bin\/python/);
});

test("buildDebugLaunchScript game starts under setsid and records launched process pid", () => {
  const pythonBin = remoteLegacyPythonBin(ROOT);
  const script = buildDebugLaunchScript({
    appDir: APP_DIR,
    pythonBin,
    mainScript: `${APP_DIR}/main.py`,
    projectType: "game",
    logPath: "/tmp/dartsnut_deploy.log",
    pidPath: "/tmp/dartsnut_dbg.pid",
    password: "rpi",
    widgetRunnerPath: "/tmp/dartsnut_deploy_inner.sh",
    launchWrapperPath: "/tmp/dartsnut_deploy_launch.sh",
    eofMarker: "EOF_MARKER",
  });

  assert.match(script, /tee "\/tmp\/dartsnut_deploy_launch\.sh" > \/dev\/null <<'EOF_MARKER_LAUNCH'/);
  assert.match(script, /nohup sudo -S bash "\/tmp\/dartsnut_deploy_launch\.sh" > \/dev\/null 2>&1 < \/dev\/null &/);
  assert.match(script, /setsid bash -c/);
  assert.match(script, /echo \$! > "\$PIDFILE"/);
  assert.match(script, /launched pid/);
  assert.match(script, /python exited/);
  assert.match(script, /wait "\$child"/);
  assert.match(script, /venv0\/bin\/python/);
  assert.match(script, /apps\/gshock-clock\/main\.py/);
});

test("buildDebugLaunchScript widget keeps heredoc runner and records launched process pid", () => {
  const pythonBin = remoteAppPythonBin(ROOT, APP_ID);
  const script = buildDebugLaunchScript({
    appDir: APP_DIR,
    pythonBin,
    mainScript: "main.py",
    projectType: "widget",
    paramsB64: "e30=",
    logPath: "/tmp/dartsnut_deploy.log",
    pidPath: "/tmp/dartsnut_dbg.pid",
    password: "rpi",
    widgetRunnerPath: "/tmp/dartsnut_deploy_inner.sh",
    launchWrapperPath: "/tmp/dartsnut_deploy_launch.sh",
    eofMarker: "EOF_MARKER",
  });

  assert.match(script, /tee "\/tmp\/dartsnut_deploy_inner\.sh" > \/dev\/null <<'EOF_MARKER'/);
  assert.match(script, /tee "\/tmp\/dartsnut_deploy_launch\.sh" > \/dev\/null <<'EOF_MARKER_LAUNCH'/);
  assert.match(script, /nohup sudo -S bash "\/tmp\/dartsnut_deploy_launch\.sh" > \/dev\/null 2>&1 < \/dev\/null &/);
  assert.match(script, /--params "\$PARAMS"/);
  assert.match(script, /setsid bash "\/tmp\/dartsnut_deploy_inner\.sh"/);
  assert.match(script, /echo \$! > "\$PIDFILE"/);
  assert.match(script, /launched pid/);
  assert.match(script, /python exited/);
  assert.match(script, /wait "\$child"/);
});

test("buildKillDebugPythonScript kills saved process group and removes pid file", () => {
  const script = buildKillDebugPythonScript({
    password: "rpi",
    pidPath: "/tmp/dartsnut_dbg.pid",
  });

  assert.match(script, /sudo -S cat "\$PIDFILE"/);
  assert.match(script, /kill -- -"\$pid"/);
  assert.match(script, /kill "\$pid"/);
  assert.match(script, /sudo -S rm -f "\$PIDFILE"/);
});

test("buildKillAppMainPyProcessesScript matches app-specific legacy and uv main.py runs", () => {
  const script = buildKillAppMainPyProcessesScript({
    appId: APP_ID,
    password: "rpi",
    pidPath: "/tmp/dartsnut_dbg.pid",
  });

  assert.match(script, /APP_RE=.*gshock-clock/);
  assert.match(script, /dartsnut_rpi\/apps\/\$APP_RE\/main\\\.py/);
  assert.match(script, /dartsnut_rpi\/apps\/\$APP_RE\/\.venv\/bin\/python.*\(\^|\[ \]\)main\\\.py/);
  assert.match(script, /pkill -f "\$legacy_pattern"/);
  assert.match(script, /pkill -f "\$uv_pattern"/);
  assert.match(script, /sudo -S rm -f "\$PIDFILE"/);
});
