import { afterEach, describe, expect, it } from "vitest";
import { applyTheme } from "./theme";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
});

describe("applyTheme", () => {
  it("keeps system as the shell preference while resolving renderer colors", () => {
    const stored = new Map<string, string>();
    let shellTheme: string | null = null;
    const dataset: Record<string, string> = {};
    const darkClasses = new Set<string>();

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => stored.get(key) ?? null,
          setItem: (key: string, value: string) => stored.set(key, value)
        },
        matchMedia: () => ({ matches: true }),
        dartsnutApi: {
          setShellUiTheme: async (theme: string) => {
            shellTheme = theme;
          }
        }
      }
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: {
          dataset,
          classList: {
            toggle: (name: string, enabled: boolean) => enabled ? darkClasses.add(name) : darkClasses.delete(name),
            contains: (name: string) => darkClasses.has(name)
          }
        }
      }
    });

    applyTheme("system");

    expect(dataset.theme).toBe("light");
    expect(darkClasses.has("dark")).toBe(false);
    expect(stored.get("dartsnut-theme")).toBe("system");
    expect(shellTheme).toBe("system");
  });
});
