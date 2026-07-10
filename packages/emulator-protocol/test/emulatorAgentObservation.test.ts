import { describe, expect, it } from "vitest";
import {
  MAX_EMULATOR_SCENARIO_OBSERVATIONS,
  MAX_EMULATOR_SCENARIO_STEPS,
  MAX_EMULATOR_SCENARIO_TOTAL_MS,
  buildEmulatorObservationFromFrame,
  summarizeEmulatorScenario,
} from "../src";

function rgb(width: number, height: number, colorAt: (x: number, y: number) => [number, number, number]): string {
  const bytes: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      bytes.push(...colorAt(x, y));
    }
  }
  return Buffer.from(bytes).toString("base64");
}

describe("agent emulator observation helpers", () => {
  it("summarizes a frame with hashes, dominant colors and non-black bounds", () => {
    const frame = {
      width: 4,
      height: 2,
      timestampMs: 1234,
      rgbBase64: rgb(4, 2, (x) => (x === 0 ? [0, 0, 0] : x === 1 ? [255, 0, 0] : [0, 0, 255])),
    };

    const observation = buildEmulatorObservationFromFrame({
      frame,
      state: { widgetPath: "/tmp/app", running: true, fps: 30, status: "", audioMuted: false, widgetType: "widget" },
      logs: [],
      previousSurfaceHash: null,
      includePngBase64: false,
    });

    expect(observation.ok).toBe(true);
    expect(observation.frame).toMatchObject({ width: 4, height: 2, timestampMs: 1234 });
    expect(observation.frame?.surfaceHash).toHaveLength(64);
    expect(observation.frame?.changedSincePrevious).toBe(true);
    expect(observation.display.panels[0]).toMatchObject({
      id: "surface",
      sourceRect: { x: 0, y: 0, width: 4, height: 2 },
    });
    expect(observation.display.panels[0].stats.nonBlackBounds).toEqual({ x: 1, y: 0, width: 3, height: 2 });
    expect(observation.display.panels[0].stats.nonBlackPixelRatio).toBe(0.75);
    expect(observation.display.panels[0].stats.dominantColors[0]).toEqual({ hex: "#0000ff", count: 4 });
  });

  it("caps scenario summaries for safe agent tool output", () => {
    const steps = Array.from({ length: 40 }, (_, index) => ({ type: "delay" as const, ms: index }));
    const capped = summarizeEmulatorScenario({ steps, requestedTimeoutMs: 60_000, requestedObservations: 9 });

    expect(capped.stepCount).toBe(MAX_EMULATOR_SCENARIO_STEPS);
    expect(capped.timeoutMs).toBe(MAX_EMULATOR_SCENARIO_TOTAL_MS);
    expect(capped.observationLimit).toBe(MAX_EMULATOR_SCENARIO_OBSERVATIONS);
    expect(capped.truncatedSteps).toBe(true);
  });

  it("reports 128x64 display mapping metadata with hardware placement", () => {
    const frame = {
      width: 128,
      height: 64,
      timestampMs: 1234,
      rgbBase64: rgb(128, 64, () => [255, 255, 255]),
    };

    const observation = buildEmulatorObservationFromFrame({
      frame,
      state: { widgetPath: "/tmp/app", running: true, fps: 30, status: "", audioMuted: false, widgetType: "widget" },
      logs: [],
      previousSurfaceHash: null,
      includePngBase64: true,
      surfacePngBase64: "surface",
      hardwarePngBase64: "hardware",
      panelPngBase64: {
        main: "main-panel",
        secondary: "bottom-panel",
      },
    });

    expect(observation.display.mapping).toBe("128x64");
    expect(observation.display.panels.map((panel) => panel.id)).toEqual(["surface", "main"]);
    expect(observation.display.panels[1]).toMatchObject({
      sourceRect: { x: 0, y: 0, width: 128, height: 64 },
      hardwareRect: { x: 38, y: 38, width: 512, height: 512 },
    });
    expect(observation.frame?.surfacePngBase64).toBe("surface");
    expect(observation.frame?.hardwarePngBase64).toBe("hardware");
    expect(observation.frame?.mainSurfacePngBase64).toBe("main-panel");
    expect(observation.frame?.bottomSurfacePngBase64).toBe("bottom-panel");
    expect(observation.display.panels[1].pngBase64).toBe("main-panel");
  });
});
