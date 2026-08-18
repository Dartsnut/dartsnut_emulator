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
    lastCapturePath: null,
    gifRecording: false,
    gifSaving: false,
    gifElapsedMs: 0
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
    lastCapturePath: null,
    gifRecording: true,
    gifSaving: false,
    gifElapsedMs: 1250
  };

  copyEmulatorStateSnapshot(target, nextState);

  assert.equal(target.audioMuted, true);
  assert.equal(target.status, "Audio muted");
  assert.equal(target.widgetPath, "/workspace/game");
  assert.equal(target.gifRecording, true);
  assert.equal(target.gifElapsedMs, 1250);
});
