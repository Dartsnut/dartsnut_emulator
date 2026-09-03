import { useEffect, useState, type SVGProps } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

function MinimizeWin(props: SVGProps<SVGSVGElement>) {
  return <svg width="10" height="1" viewBox="0 0 10 1" fill="none" {...props}><path d="M.498 1.001A.498.498 0 0 1 0 .503.498.498 0 0 1 .498 0h9.004A.498.498 0 0 1 10 .503a.498.498 0 0 1-.498.498H.498Z" fill="currentColor" fillOpacity=".8956" /></svg>;
}

function MaximizeWin(props: SVGProps<SVGSVGElement>) {
  return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" {...props}><path d="M1.475 10.001A1.475 1.475 0 0 1 0 8.526v-7.05A1.475 1.475 0 0 1 1.475 0h7.05A1.475 1.475 0 0 1 10 1.476v7.05a1.475 1.475 0 0 1-1.475 1.475h-7.05ZM8.5 9A.499.499 0 0 0 9 8.502V1.5a.499.499 0 0 0-.5-.498H1.5a.499.499 0 0 0-.499.498v7.002A.499.499 0 0 0 1.5 9h7Z" fill="currentColor" fillOpacity=".8956" /></svg>;
}

function RestoreWin(props: SVGProps<SVGSVGElement>) {
  return <svg width="10" height="11" viewBox="0 0 10 11" fill="none" {...props}><path d="M9 2.981A1.963 1.963 0 0 0 6.997 1.018H2.085A1.5 1.5 0 0 1 3.501.017h3.496A3.002 3.002 0 0 1 10 3.015v3.501A1.5 1.5 0 0 1 9 7.932V2.981ZM1.475 10.017A1.475 1.475 0 0 1 0 8.542V3.494A1.475 1.475 0 0 1 1.475 2.02h5.048a1.475 1.475 0 0 1 1.475 1.475v5.048a1.475 1.475 0 0 1-1.475 1.475H1.475Zm5.024-1.001a.499.499 0 0 0 .503-.498v-5a.499.499 0 0 0-.503-.503h-5a.499.499 0 0 0-.498.503v5a.499.499 0 0 0 .498.498h5Z" fill="currentColor" fillOpacity=".8956" /></svg>;
}

function CloseWin(props: SVGProps<SVGSVGElement>) {
  return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" {...props}><path d="M5 5.709.854 9.854a.498.498 0 1 1-.708-.708L4.292 5 .146.855A.498.498 0 1 1 .854.147L5 4.293 9.146.147a.498.498 0 1 1 .708.708L5.708 5l4.146 4.146a.498.498 0 1 1-.708.708L5 5.71Z" fill="currentColor" fillOpacity=".8956" /></svg>;
}

function CloseMac() {
  return <svg width="6" height="6" viewBox="0 0 16 18" fill="none"><path d="m15.752 4.444-4.598 4.598 4.595 4.595a.89.89 0 0 1-.025 1.258l-1.833 1.833a.89.89 0 0 1-1.258.025l-4.595-4.595-4.594 4.593a.89.89 0 0 1-1.258-.026L.273 14.812a.89.89 0 0 1-.025-1.258L4.84 8.961.325 4.447A.89.89 0 0 1 .35 3.189l1.834-1.834a.89.89 0 0 1 1.258-.025l4.515 4.514 4.599-4.598a.89.89 0 0 1 1.257.026l1.914 1.914a.89.89 0 0 1 .025 1.258Z" fill="currentColor" /></svg>;
}

function MinimizeMac() {
  return <svg width="8" height="8" viewBox="0 0 17 6" fill="none"><path d="M1.472 1.18H15.42c.385 0 .698.326.698.728v1.824c0 .402-.313 1.068-.698 1.068H1.472c-.385 0-.698-.325-.698-.727V1.908c0-.402.312-.728.698-.728Z" fill="currentColor" /></svg>;
}

function FullscreenMac() {
  return <svg width="6" height="6" viewBox="0 0 15 15" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="m3.531.434 11.562 11.607s-.027-6.691-.027-8.023c0-2.697-.885-3.584-3.528-3.584H3.53Zm8.91 15.104L.877 3.931s.029 6.69.029 8.023c0 2.697.884 3.584 3.527 3.584h8.008Z" fill="currentColor" /></svg>;
}

function PlusMac() {
  return <svg width="8" height="8" viewBox="0 0 17 16" fill="none"><path d="M15.531 9.801H10.32v5.208c0 .386-.326.699-.727.699H7.516a.713.713 0 0 1-.728-.699V9.801H1.583a.713.713 0 0 1-.698-.727V6.906c0-.402.313-.727.698-.727h5.205V1.062c0-.386.325-.698.728-.698h2.077c.401 0 .727.312.727.698v5.117h5.211c.385 0 .698.325.698.727v2.168c0 .402-.313.727-.698.727Z" fill="currentColor" /></svg>;
}

/** Tauri window controls matching agmmnn/tauri-controls platform components. */
export function WindowControls({ className = "" }: { className?: string }): JSX.Element {
  const [maximized, setMaximized] = useState(false);
  const [altPressed, setAltPressed] = useState(false);
  const platform = typeof navigator !== "undefined" && /Macintosh|Mac OS X/i.test(navigator.userAgent)
    ? "macos"
    : typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
      ? "windows"
      : "gnome";

  useEffect(() => {
    const windowHandle = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = async () => {
      try {
        const value = await windowHandle.isMaximized();
        if (!disposed) setMaximized(value);
      } catch {
        // Best-effort during startup and test environments.
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

  useEffect(() => {
    if (platform !== "macos") return;
    const keyDown = (event: KeyboardEvent) => { if (event.key === "Alt") setAltPressed(true); };
    const keyUp = (event: KeyboardEvent) => { if (event.key === "Alt") setAltPressed(false); };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [platform]);

  const windowHandle = getCurrentWindow();
  const toggleFullscreen = async () => windowHandle.setFullscreen(!(await windowHandle.isFullscreen()));

  return (
    <div className={`window-controls window-controls--${platform} ${className}`} aria-label="Window controls">
      {platform === "macos" ? <>
        <button type="button" className="window-control window-control--close" onClick={() => void windowHandle.close()} aria-label="Close" title="Close"><span className="window-control__glyph"><CloseMac /></span></button>
        <button type="button" className="window-control window-control--minimize" onClick={() => void windowHandle.minimize()} aria-label="Minimize" title="Minimize"><span className="window-control__glyph"><MinimizeMac /></span></button>
        <button type="button" className="window-control window-control--maximize" onClick={() => void (altPressed ? windowHandle.toggleMaximize() : toggleFullscreen())} aria-label={altPressed ? "Maximize" : "Enter full screen"} title={altPressed ? "Maximize" : "Enter full screen"}><span className="window-control__glyph">{altPressed ? <PlusMac /> : <FullscreenMac />}</span></button>
      </> : <>
        <button type="button" className="window-control window-control--minimize" onClick={() => void windowHandle.minimize()} aria-label="Minimize" title="Minimize"><MinimizeWin /></button>
        <button type="button" className="window-control window-control--maximize" onClick={() => void windowHandle.toggleMaximize()} aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"}>{maximized ? <RestoreWin /> : <MaximizeWin />}</button>
        <button type="button" className="window-control window-control--close" onClick={() => void windowHandle.close()} aria-label="Close" title="Close"><CloseWin /></button>
      </>}
    </div>
  );
}
