const assert = require("node:assert/strict");
const test = require("node:test");

const { AgentRunCoordinator } = require("./agentRunCoordinator.ts");

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("cancel waits until the active run finishes cleanup", async () => {
  const coordinator = new AgentRunCoordinator();
  const run = await coordinator.begin();
  let cancelFinished = false;

  const cancelPromise = coordinator.cancelAndWait().then((cancelled) => {
    assert.equal(cancelled, true);
    cancelFinished = true;
  });

  await nextTurn();
  assert.equal(run.abortController.signal.aborted, true);
  assert.equal(cancelFinished, false);

  run.settle();
  await cancelPromise;
  assert.equal(cancelFinished, true);
});

test("replacement run waits for the previous run to settle", async () => {
  const coordinator = new AgentRunCoordinator();
  const first = await coordinator.begin();
  let second;

  const secondPromise = coordinator.begin().then((run) => {
    second = run;
  });

  await nextTurn();
  assert.equal(first.abortController.signal.aborted, true);
  assert.equal(second, undefined);

  first.settle();
  await secondPromise;
  assert.ok(second);
  assert.equal(second.abortController.signal.aborted, false);
  second.settle();
});

test("cancel is a no-op after the run has settled", async () => {
  const coordinator = new AgentRunCoordinator();
  const run = await coordinator.begin();
  run.settle();

  assert.equal(await coordinator.cancelAndWait(), false);
});
