const assert = require("node:assert/strict");
const test = require("node:test");

const {
  encodeHardwareMockupPngBase64,
  encodeRgbRectPngBase64,
  encodeRgbPngBase64,
  normalizeEmulatorInputAction,
  summarizeScenarioRequest,
} = require("./emulatorAgentTools.ts");

test("encodeRgbPngBase64 returns a PNG data payload", () => {
  const base64 = encodeRgbPngBase64({
    width: 1,
    height: 1,
    rgbBase64: Buffer.from([255, 0, 0]).toString("base64"),
    timestampMs: 1,
  });

  const png = Buffer.from(base64, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("encodeRgbRectPngBase64 returns a cropped panel PNG", () => {
  const pixels = Buffer.alloc(128 * 160 * 3);
  const bottomOffset = (128 * 128 + 63) * 3;
  pixels[bottomOffset] = 12;
  pixels[bottomOffset + 1] = 34;
  pixels[bottomOffset + 2] = 56;

  const base64 = encodeRgbRectPngBase64(
    {
      width: 128,
      height: 160,
      rgbBase64: pixels.toString("base64"),
      timestampMs: 1,
    },
    { x: 0, y: 128, width: 64, height: 32 },
  );

  const png = Buffer.from(base64, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 32);
});

test("encodeHardwareMockupPngBase64 returns a 588x800 PNG", () => {
  const pixels = Buffer.alloc(128 * 160 * 3);
  pixels[0] = 255;
  const base64 = encodeHardwareMockupPngBase64({
    width: 128,
    height: 160,
    rgbBase64: pixels.toString("base64"),
    timestampMs: 1,
  });

  const png = Buffer.from(base64, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 588);
  assert.equal(png.readUInt32BE(20), 800);
});

test("normalizeEmulatorInputAction validates and expands tap/next dart actions", () => {
  const tap = normalizeEmulatorInputAction({ type: "tap_button", button: "A", duration_ms: 25 }, [[-1, -1]]);
  assert.deepEqual(tap.commands, [
    { type: "set_button", button: "A", pressed: true },
    { type: "delay", ms: 25 },
    { type: "set_button", button: "A", pressed: false },
  ]);

  const dart = normalizeEmulatorInputAction({ type: "throw_dart", index: "next", x: 10, y: 20 }, [[-1, -1], [1, 1]]);
  assert.deepEqual(dart.commands, [{ type: "throw_dart", index: 0, x: 10, y: 20 }]);

  assert.throws(
    () => normalizeEmulatorInputAction({ type: "set_button", button: "START", pressed: true }, []),
    /Unknown button/,
  );
  assert.throws(
    () => normalizeEmulatorInputAction({ type: "sequence", actions: [] }, []),
    /1 to 30 actions/,
  );
});

test("summarizeScenarioRequest caps long scenarios", () => {
  const summary = summarizeScenarioRequest({
    steps: Array.from({ length: 40 }, () => ({ type: "observe" })),
    timeout_ms: 60_000,
  });

  assert.equal(summary.stepCount, 30);
  assert.equal(summary.timeoutMs, 30_000);
  assert.equal(summary.truncatedSteps, true);
});
