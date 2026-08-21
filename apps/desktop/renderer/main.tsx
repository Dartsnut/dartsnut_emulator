import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeAnalytics, installAnalyticsClickTracking } from "./analytics";
import "./themes.css";
import "./tailwind.css";
import "./styles.css";

function reportRendererError(error: unknown, source: string): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  window.dartsnutApi?.reportRendererError({
    message: normalized.message.slice(0, 500),
    ...(normalized.stack ? { stack: normalized.stack.slice(0, 4000) } : {}),
    source
  });
}

function resetRendererState(): void {
  for (const key of [
    "dartsnut-theme",
    "dartsnut-analytics-enabled",
    "dartsnut-chat-pane-width",
    "dartsnut-chat-pane-ratio",
    "dartsnut-workspace-menu-width",
    "dartsnut-workspace-menu-collapsed"
  ]) {
    try { window.localStorage.removeItem(key); } catch { /* optional storage */ }
  }
  try { window.sessionStorage.clear(); } catch { /* optional storage */ }
  window.location.reload();
}

export function StartupRecovery({ error }: { error: Error }): ReactNode {
  const errorId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const errorMessage = error.message || "Renderer startup error";
  return (
    <main style={{ minHeight: "100vh", maxHeight: "100vh", overflowY: "auto", overflowX: "hidden", boxSizing: "border-box", padding: "24px", color: "#e7e1dc", background: "#211b18", fontFamily: "system-ui, sans-serif" }}>
      <section style={{ maxWidth: 560, margin: "8vh auto", padding: 32, border: "1px solid #66483d", borderRadius: 12, overflowWrap: "anywhere" }} role="alert">
        <h1 style={{ margin: "0 0 12px", fontSize: 22 }}>Dartsnut Agent could not start</h1>
        <p style={{ lineHeight: 1.5 }}>The app hit an error while loading. Reload first. If it repeats, restart without GPU acceleration or send diagnostics to support.</p>
        <p style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, opacity: 0.75 }}>Error {errorId}: {errorMessage.slice(0, 500)}</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
          <button type="button" onClick={resetRendererState}>Reset interface settings</button>
          <button type="button" onClick={() => window.dartsnutApi?.restartWithoutGpu()}>Restart without GPU</button>
          <button type="button" onClick={() => void window.dartsnutApi?.openStartupLogs()}>Open logs</button>
          <button type="button" onClick={() => void window.dartsnutApi?.copyStartupDiagnostics()}>Copy diagnostics</button>
        </div>
      </section>
    </main>
  );
}

class StartupErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportRendererError(new Error(`${error.message}\n${info.componentStack}`), "react-boundary");
  }
  render(): ReactNode { return this.state.error ? <StartupRecovery error={this.state.error} /> : this.props.children; }
}

function StartupReadySignal({ children }: { children: ReactNode }): ReactNode {
  React.useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => window.dartsnutApi?.rendererReady()));
  }, []);
  return children;
}

const WEB_FONTS_STYLESHEET =
  "https://fonts.googleapis.com/css2?family=Figtree:ital,wght@0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@500;600;700;800&display=swap";

// Remote fonts are visual enhancement only. Loading them after the initial document load
// prevents an unreachable font host from keeping Electron's first window blank.
window.addEventListener("load", () => {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = WEB_FONTS_STYLESHEET;
  document.head.appendChild(stylesheet);
}, { once: true });

void initializeAnalytics();
installAnalyticsClickTracking();

window.addEventListener("error", (event) => {
  if (event.error || event.message) reportRendererError(event.error || event.message, "window-error");
  else if (event.target && (event.target as HTMLScriptElement).tagName === "SCRIPT") {
    const script = event.target as HTMLScriptElement;
    const src = script.src || script.getAttribute("src") || "";
    if (/\/renderer\/main\.tsx(?:$|[?#])/.test(src) || /\/assets\/index-[^/]+\.js(?:$|[?#])/.test(src)) {
      reportRendererError(new Error(`Could not load renderer bundle: ${src || "unknown script"}`), "script-load");
    }
  }
}, true);
window.addEventListener("unhandledrejection", (event) => {
  if (event.reason) reportRendererError(event.reason, "unhandled-rejection");
}, true);

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <StartupErrorBoundary>
        <StartupReadySignal><App /></StartupReadySignal>
      </StartupErrorBoundary>
    </React.StrictMode>
  );
} else {
  reportRendererError(new Error("Startup root element is missing."), "missing-root");
}
