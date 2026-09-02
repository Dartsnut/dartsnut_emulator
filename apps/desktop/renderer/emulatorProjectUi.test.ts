import { describe, expect, it } from "vitest";
import { canStartOrReloadEmulator, shouldShowWidgetParams } from "./emulatorProjectUi";

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

  it("enables start/reload when bridge and active workspace are available", () => {
    expect(canStartOrReloadEmulator(true, "/projects/demo")).toBe(true);
    expect(canStartOrReloadEmulator(true, "  ")).toBe(false);
    expect(canStartOrReloadEmulator(false, "/projects/demo")).toBe(false);
  });
});
