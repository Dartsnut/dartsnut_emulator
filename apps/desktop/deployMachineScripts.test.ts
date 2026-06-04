const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDebugLaunchInner,
  buildEnsureAppVenvScript,
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
