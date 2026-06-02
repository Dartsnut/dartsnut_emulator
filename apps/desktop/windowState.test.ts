const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  normalizeWindowBounds
} = require("./windowState.ts");

const singleDisplay = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];

test("normalizeWindowBounds accepts and clamps valid persisted bounds", () => {
  const restored = normalizeWindowBounds(
    { x: 20, y: 30, width: 800, height: 600 },
    singleDisplay
  );
  assert.deepEqual(restored, {
    x: 20,
    y: 30,
    width: MIN_WINDOW_WIDTH,
    height: MIN_WINDOW_HEIGHT
  });
});

test("normalizeWindowBounds rejects bounds that are fully off-screen", () => {
  const restored = normalizeWindowBounds(
    { x: 5000, y: 5000, width: 1600, height: 1000 },
    singleDisplay
  );
  assert.equal(restored, null);
});

test("normalizeWindowBounds rejects malformed persisted data", () => {
  assert.equal(normalizeWindowBounds({ x: 0, y: 0, width: "wide", height: 900 }, singleDisplay), null);
  assert.equal(normalizeWindowBounds(null, singleDisplay), null);
});

