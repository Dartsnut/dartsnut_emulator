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
    void bridge.getWindowChromeInsets().then(applyWindowChromeInsetsCssVars);
    return bridge.onWindowChromeInsets(applyWindowChromeInsetsCssVars);
  }, []);
}
