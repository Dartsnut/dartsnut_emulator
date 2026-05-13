const assert = require("node:assert/strict");
const test = require("node:test");

const { buildSyncWorkspaceScript } = require("./deployMachineScripts.ts");

test("buildSyncWorkspaceScript uses sudo for remote apps tree mutations", () => {
  const script = buildSyncWorkspaceScript({
    appId: "gshock-clock",
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
