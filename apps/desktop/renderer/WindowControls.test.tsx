import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowControls } from "./WindowControls";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    minimize: vi.fn(),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
    toggleMaximize: vi.fn()
  })
}));

afterEach(() => {
  Reflect.deleteProperty(globalThis, "navigator");
});

describe("WindowControls", () => {
  it("renders macOS traffic lights in native order", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }
    });

    const markup = renderToStaticMarkup(<WindowControls />);
    expect(markup).toContain("window-controls--macos");
    expect(markup.indexOf('aria-label="Close"')).toBeLessThan(markup.indexOf('aria-label="Minimize"'));
    expect(markup.indexOf('aria-label="Minimize"')).toBeLessThan(markup.indexOf('aria-label="Maximize"'));
  });
});
