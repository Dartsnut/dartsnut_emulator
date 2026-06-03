import { describe, expect, it } from "vitest";
import {
  formatCreatorBuildPlanMessage,
  shouldIncludeCreatorBuildPlan
} from "../src/creatorBuildPlan";

describe("formatCreatorBuildPlanMessage", () => {
  it("includes workspace metadata for game creator", () => {
    const msg = formatCreatorBuildPlanMessage({
      templateMode: "game-creator",
      projectType: "game"
    });
    expect(msg).toContain("## Workspace metadata");
    expect(msg).toContain("Project type: **game**");
    expect(msg).toContain("Creation context");
    expect(msg).toContain("user request");
    expect(msg).not.toContain("Success criteria");
    expect(msg).not.toContain("Behavior matches the user request");
    expect(msg).not.toContain("karpathy-guidelines");
  });

  it("includes widget display size when provided", () => {
    const msg = formatCreatorBuildPlanMessage({
      templateMode: "widget-creator",
      projectType: "widget",
      widgetSize: "128x128"
    });
    expect(msg).toContain("128x128");
    expect(msg).toContain("Widget display size");
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
