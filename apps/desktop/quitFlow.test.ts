const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createShutdownCleanupRunner,
  runShutdownCleanup
} = require("./quitFlow.ts");

test("runShutdownCleanup starts all tasks before waiting", async () => {
  const started = [];
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const cleanup = runShutdownCleanup([
    { name: "first", run: () => { started.push("first"); return first; } },
    { name: "second", run: () => { started.push("second"); } },
  ], () => {});
  assert.deepEqual(started, ["first", "second"]);
  releaseFirst();
  await cleanup;
});

test("runShutdownCleanup reports rejection after every task settles", async () => {
  const failures = [];
  let releaseSlow;
  let slowSettled = false;
  const slow = new Promise((resolve) => { releaseSlow = () => { slowSettled = true; resolve(); }; });
  const cleanup = runShutdownCleanup([
    { name: "failed", run: () => Promise.reject(new Error("boom")) },
    { name: "slow", run: () => slow },
  ], (failure) => failures.push(failure));
  await Promise.resolve();
  assert.equal(failures.length, 0);
  releaseSlow();
  await cleanup;
  assert.equal(slowSettled, true);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, "failed");
});

test("createShutdownCleanupRunner reuses one in-flight cleanup", async () => {
  let runs = 0;
  let release;
  const runner = createShutdownCleanupRunner(
    () => [{ name: "only", run: () => { runs += 1; return new Promise((resolve) => { release = resolve; }); } }],
    () => {},
  );
  const first = runner();
  const second = runner();
  assert.equal(first, second);
  assert.equal(runs, 1);
  release();
  await first;
});
