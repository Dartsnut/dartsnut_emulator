import { describe, expect, it } from "vitest";
import {
  formatCreatorBuildPlanMessage,
  shouldIncludeCreatorBuildPlan
} from "../src/creatorBuildPlan";

describe("formatCreatorBuildPlanMessage", () => {
  it("includes phased guidelines and Agent steps for game creator", () => {
    const msg = formatCreatorBuildPlanMessage({
      templateMode: "game-creator",
      projectType: "game"
    });
    expect(msg).toContain("## Build guidelines");
    expect(msg).toContain("guidelines");
    expect(msg).toContain("Agent steps");
    expect(msg).toContain("micro-steps");
    expect(msg).toContain("read_file");
    expect(msg).toContain("iteration loop");
    expect(msg).toContain("Phase 1");
    expect(msg).toContain("conf.json");
    expect(msg).toContain("reload_emulator");
    expect(msg).toContain("get_emulator_logs");
    expect(msg).toContain("Verify run");
    expect(msg).toContain("Phase 2");
    expect(msg).toContain("main.py");
  });

  it("includes widget display size when provided", () => {
    const msg = formatCreatorBuildPlanMessage({
      templateMode: "widget-creator",
      projectType: "widget",
      widgetSize: "128x128"
    });
    expect(msg).toContain("128x128");
    expect(msg).toContain("blank frame runs");
  });
});

describe("shouldIncludeCreatorBuildPlan", () => {
  it("is true for creator modes without conf.json", () => {
    expect(shouldIncludeCreatorBuildPlan("game-creator", false)).toBe(true);
    expect(shouldIncludeCreatorBuildPlan("widget-creator", false)).toBe(true);
  });

  it("is false when conf.json exists or mode is not creator", () => {
    expect(shouldIncludeCreatorBuildPlan("game-creator", true)).toBe(false);
    expect(shouldIncludeCreatorBuildPlan("asset-applier", false)).toBe(false);
    expect(shouldIncludeCreatorBuildPlan(undefined, false)).toBe(false);
  });
});
