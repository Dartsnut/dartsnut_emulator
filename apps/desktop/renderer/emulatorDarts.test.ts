import { describe, expect, it } from "vitest";
import { DART_LEGEND_INDEXES, resolveDartShortcut } from "./emulatorDarts";

describe("emulator dart controls", () => {
  it("maps F1 through F12 to color-sorted dart indexes for games", () => {
    expect(resolveDartShortcut("F1", "game")).toBe(0);
    expect(resolveDartShortcut("F2", "GAME")).toBe(4);
    expect(resolveDartShortcut("F12", "GAME")).toBe(11);
  });

  it("ignores invalid shortcuts and non-game workspaces", () => {
    expect(resolveDartShortcut("F13", "game")).toBeNull();
    expect(resolveDartShortcut("1", "game")).toBeNull();
    expect(resolveDartShortcut("F1", "widget")).toBeNull();
    expect(resolveDartShortcut("F1", null)).toBeNull();
  });

  it("groups legend indexes by blue, red, green, then yellow", () => {
    expect(DART_LEGEND_INDEXES).toEqual([0, 4, 8, 1, 5, 9, 2, 6, 10, 3, 7, 11]);
  });
});
