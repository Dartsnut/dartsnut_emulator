const assert = require("node:assert/strict");
const test = require("node:test");

const { copyEmulatorStateSnapshot } = require("./emulatorState.ts");

test("copyEmulatorStateSnapshot copies audio muted state", () => {
  const target = {
    widgetPath: null,
    running: false,
    fps: 0,
    status: "Idle",
    audioMuted: false,
    lastCapturePath: null
  };
  const nextState = {
    widgetPath: "/workspace/game",
    widgetId: "game",
    widgetType: "game",
    running: true,
    fps: 60,
    status: "Audio muted",
    audioMuted: true,
    lastError: undefined,
    lastCapturePath: null
  };

  copyEmulatorStateSnapshot(target, nextState);

  assert.equal(target.audioMuted, true);
  assert.equal(target.status, "Audio muted");
  assert.equal(target.widgetPath, "/workspace/game");
});
