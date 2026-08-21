import { useLayoutEffect } from "react";
import type { WindowChromeInsets } from "@dartsnut/shared-ipc";

function applyWindowChromeInsetsCssVars(insets: WindowChromeInsets): void {
  const root = document.documentElement;
  root.style.setProperty("--window-control-inset-top", `${insets.top}px`);
  root.style.setProperty("--window-control-inset-left", `${insets.left}px`);
  root.style.setProperty("--window-control-inset-right", `${insets.right}px`);
  root.style.setProperty("--window-control-inset-bottom", `${insets.bottom}px`);
}

/** Syncs main-process window chrome safe-area into `:root` CSS variables for `.app-shell` padding. */
export function useWindowChromeInsets(): void {
  useLayoutEffect(() => {
    const bridge = window.dartsnutApi;
    if (!bridge) {
      applyWindowChromeInsetsCssVars({ top: 0, left: 0, right: 0, bottom: 0 });
      return;
    }
    void bridge.getWindowChromeInsets()
      .then(applyWindowChromeInsetsCssVars)
      .catch(() => applyWindowChromeInsetsCssVars({ top: 0, left: 0, right: 0, bottom: 0 }));
    try {
      return bridge.onWindowChromeInsets(applyWindowChromeInsetsCssVars);
    } catch {
      return undefined;
    }
  }, []);
}
