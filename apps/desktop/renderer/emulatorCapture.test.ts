import { describe, expect, it } from "vitest";
import { captureOutputSizes, formatRecordingElapsed } from "./emulatorCapture";

describe("emulator capture output sizes", () => {
  it("splits 128x160 GIFs into main and bottom panels", () => {
    expect(captureOutputSizes("gif", 128, 160, 4)).toEqual([
      { label: "Main GIF", width: 512, height: 512 },
      { label: "Bottom GIF", width: 256, height: 128 },
    ]);
  });

  it.each([
    [128, 128, 2, 256, 256],
    [128, 64, 1, 128, 64],
    [64, 32, 4, 256, 128],
  ] as const)("keeps %ix%i GIF as one surface", (width, height, zoom, outWidth, outHeight) => {
    expect(captureOutputSizes("gif", width, height, zoom)).toEqual([
      { label: "GIF", width: outWidth, height: outHeight },
    ]);
  });

  it("keeps hardware screenshot fixed while scaling surface", () => {
    expect(captureOutputSizes("screenshot", 128, 64, 4)).toEqual([
      { label: "Hardware", width: 588, height: 800 },
      { label: "Surface", width: 512, height: 256 },
    ]);
  });

  it("formats and caps recording elapsed time", () => {
    expect(formatRecordingElapsed(0)).toBe("00:00");
    expect(formatRecordingElapsed(12_999)).toBe("00:12");
    expect(formatRecordingElapsed(45_000)).toBe("00:30");
  });
});
