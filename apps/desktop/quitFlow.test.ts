const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decideBeforeQuitBridgeAction,
  shouldAllocateTempWorkspaceAfterDiscard
} = require("./quitFlow.ts");

test("decideBeforeQuitBridgeAction proceeds when teardown already done", () => {
  const action = decideBeforeQuitBridgeAction({
    teardownDone: true,
    hasBridgeProcess: true,
    teardownInFlight: true
  });
  assert.equal(action, "proceed");
});

test("decideBeforeQuitBridgeAction marks teardown done without bridge process", () => {
  const action = decideBeforeQuitBridgeAction({
    teardownDone: false,
    hasBridgeProcess: false,
    teardownInFlight: false
  });
  assert.equal(action, "mark_teardown_done");
});

test("decideBeforeQuitBridgeAction waits if teardown already in flight", () => {
  const action = decideBeforeQuitBridgeAction({
    teardownDone: false,
    hasBridgeProcess: true,
    teardownInFlight: true
  });
  assert.equal(action, "wait_for_inflight_teardown");
});

test("decideBeforeQuitBridgeAction starts teardown when bridge is active", () => {
  const action = decideBeforeQuitBridgeAction({
    teardownDone: false,
    hasBridgeProcess: true,
    teardownInFlight: false
  });
  assert.equal(action, "start_teardown");
});

test("shouldAllocateTempWorkspaceAfterDiscard does not recreate on quit", () => {
  assert.equal(shouldAllocateTempWorkspaceAfterDiscard("quit"), false);
  assert.equal(shouldAllocateTempWorkspaceAfterDiscard("new_project"), true);
  assert.equal(shouldAllocateTempWorkspaceAfterDiscard("open_workspace"), true);
  assert.equal(shouldAllocateTempWorkspaceAfterDiscard(undefined), true);
});
