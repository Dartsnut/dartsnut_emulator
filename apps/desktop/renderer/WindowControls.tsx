import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Small Tauri-native window control bridge. Keeps renderer independent of OS plugins. */
export function WindowControls({ className = "" }: { className?: string }): JSX.Element {
  const [maximized, setMaximized] = useState(false);
  const platform = typeof navigator !== "undefined" && /Macintosh|Mac OS X/i.test(navigator.userAgent)
    ? "macos"
    : typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
      ? "windows"
      : "linux";

  useEffect(() => {
    const windowHandle = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = async () => {
      try {
        const value = await windowHandle.isMaximized();
        if (!disposed) setMaximized(value);
      } catch {
        // Window state is best-effort during startup and test environments.
      }
    };
    void sync();
    void windowHandle.onResized(() => { void sync(); }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const windowHandle = getCurrentWindow();
  return (
    <div className={`window-controls window-controls--${platform} ${className}`} aria-label="Window controls">
      {platform === "macos" ? <>
        <button type="button" className="window-control window-control--close" onClick={() => void windowHandle.close()} aria-label="Close" title="Close" />
        <button type="button" className="window-control window-control--minimize" onClick={() => void windowHandle.minimize()} aria-label="Minimize" title="Minimize" />
        <button type="button" className="window-control window-control--maximize" onClick={() => void windowHandle.toggleMaximize()} aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"} />
      </> : <>
        <button type="button" className="window-control window-control--minimize" onClick={() => void windowHandle.minimize()} aria-label="Minimize" title="Minimize" />
        <button type="button" className="window-control window-control--maximize" onClick={() => void windowHandle.toggleMaximize()} aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"} />
        <button type="button" className="window-control window-control--close" onClick={() => void windowHandle.close()} aria-label="Close" title="Close" />
      </>}
    </div>
  );
}
