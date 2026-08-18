import { describe, expect, it } from "vitest";
import { shouldShowWidgetParams } from "./emulatorProjectUi";

describe("emulator project UI", () => {
  it("hides widget params for games despite a stale ready config", () => {
    expect(shouldShowWidgetParams("game", "ready")).toBe(false);
    expect(shouldShowWidgetParams("GAME", "ready")).toBe(false);
  });

  it("shows widget params for widgets", () => {
    expect(shouldShowWidgetParams("widget", "not_widget")).toBe(true);
  });

  it("uses config readiness only until project type resolves", () => {
    expect(shouldShowWidgetParams(null, "ready")).toBe(true);
    expect(shouldShowWidgetParams(null, "not_widget")).toBe(false);
  });
});
