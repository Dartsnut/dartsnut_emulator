import { describe, expect, it } from "vitest";
import {
  formatCreatorBuildPlanMessage,
  shouldIncludeCreatorBuildPlan
} from "../src/creatorBuildPlan";

describe("formatCreatorBuildPlanMessage", () => {
  it("includes success criteria for game creator", () => {
    const msg = formatCreatorBuildPlanMessage({
      templateMode: "game-creator",
      projectType: "game"
    });
    expect(msg).toContain("## Success criteria");
    expect(msg).toContain("karpathy-guidelines");
    expect(msg).toContain("creator-incremental");
    expect(msg).toContain("does **not** prescribe step order");
    expect(msg).toContain("conf.json");
    expect(msg).toContain("main.py");
    expect(msg).toContain("reload_emulator");
    expect(msg).toContain("get_emulator_logs");
    expect(msg).not.toContain("Agent steps");
    expect(msg).not.toContain("Phase 1");
  });

  it("includes widget display size when provided", () => {
    const msg = formatCreatorBuildPlanMessage({
      templateMode: "widget-creator",
      projectType: "widget",
      widgetSize: "128x128"
    });
    expect(msg).toContain("128x128");
    expect(msg).toContain("Success criteria");
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
