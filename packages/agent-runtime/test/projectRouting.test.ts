import { describe, expect, it } from "vitest";
import { resolveCreatorRouting } from "../src/projectRouting";

describe("resolveCreatorRouting", () => {
  it("prefers valid workspace classification over stale session routing", () => {
    expect(
      resolveCreatorRouting(
        {
          templateMode: "widget-creator",
          projectType: "widget",
          widgetSize: "128x128"
        },
        { templateMode: "game-creator", projectType: "game" }
      )
    ).toEqual({ templateMode: "game-creator", projectType: "game" });
  });

  it("uses requested routing while workspace classification is unavailable", () => {
    expect(
      resolveCreatorRouting(
        { templateMode: "widget-creator", widgetSize: "64x32" },
        null
      )
    ).toEqual({
      templateMode: "widget-creator",
      projectType: "widget",
      widgetSize: "64x32"
    });
  });
});
