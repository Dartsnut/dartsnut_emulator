import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DeployConnectResponse } from "@dartsnut/shared-ipc";
import { cn } from "./cn";
import { applyWidgetParamsAndReload, formatWidgetParamsJson } from "./widgetParams";
import { WidgetParamsEditor } from "./WidgetParamsEditor";

const toolbarBtn = "ui-toolbar-btn";

export type DeployPanelProps = {
  showWidgetParams: boolean;
  widgetParamsText: string;
  setWidgetParamsText: Dispatch<SetStateAction<string>>;
  widgetParamsError: string | null;
  setWidgetParamsError: Dispatch<SetStateAction<string | null>>;
};

export function DeployPanel({
  showWidgetParams,
  widgetParamsText,
  setWidgetParamsText,
  widgetParamsError,
  setWidgetParamsError,
}: DeployPanelProps) {
  const api = window.dartsnutApi;
  const [host, setHost] = useState("");
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement | null>(null);

  const bridgeReady = Boolean(api?.sendEmulatorCommand);

  useEffect(() => {
    if (!api?.onDeployLog) {
      return;
    }
    return api.onDeployLog((line: string) => {
      setLogLines((prev) => [...prev.slice(-499), line]);
    });
  }, [api]);

  useEffect(() => {
    const el = logRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [logLines]);

  async function handleConnect() {
    if (!api?.deployConnect) {
      return;
    }
    setLastError(null);
    setBusyAction("connect");
    setDeviceName(null);
    setConnected(false);
    try {
      const result: DeployConnectResponse = await api.deployConnect({ host });
      if (!result.ok) {
        setLastError(result.error);
        return;
      }
      setConnected(true);
      setDeviceName(result.deviceName ?? null);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDisconnect() {
    if (!api?.deployDisconnect) {
      return;
    }
    setLastError(null);
    setBusyAction("disconnect");
    try {
      const result = await api.deployDisconnect();
      if (!result.ok) {
        setLastError(result.error);
        return;
      }
      setConnected(false);
      setDeviceName(null);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function run(action: "run" | "reload" | "stop") {
    if (!api) {
      return;
    }
    setLastError(null);
    setBusyAction(action);
    try {
      const launch = showWidgetParams ? { widgetParamsJson: widgetParamsText } : undefined;
      const result =
        action === "run"
          ? await api.deployRun(launch)
          : action === "reload"
            ? await api.deployReload(launch)
            : await api.deployStop();
      if (!result.ok) {
        setLastError(result.error);
      }
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  }

  function handleFormatWidgetParams() {
    formatWidgetParamsJson(widgetParamsText, setWidgetParamsText, setWidgetParamsError);
  }

  async function handleApplyWidgetParams() {
    const normalized = await applyWidgetParamsAndReload({
      widgetParamsText,
      setWidgetParamsText,
      setWidgetParamsError,
    });
    if (normalized === undefined) {
      return;
    }
    if (!connected || !showWidgetParams) {
      return;
    }
    setLastError(null);
    setBusyAction("reload");
    try {
      const result = await api.deployReload({ widgetParamsJson: normalized });
      if (!result.ok) {
        setLastError(result.error);
      }
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  }

  if (!api?.deployConnect || !api?.deployDisconnect) {
    return (
      <div className="flex flex-col gap-2 p-4 text-sm text-[var(--color-text-subtle)]">
        Deploy bridge unavailable. Rebuild the desktop app.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <h2 className="ui-panel-title">Deploy</h2>
      <label className="flex shrink-0 flex-col gap-1.5 text-[13px]">
        <span className="text-[var(--color-text-subtle)]">Device IP or hostname</span>
        <input
          type="text"
          className="ui-input font-mono"
          placeholder="192.168.x.x"
          value={host}
          disabled={busyAction !== null || connected}
          onChange={(e) => setHost(e.target.value)}
        />
      </label>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          className={toolbarBtn}
          disabled={busyAction !== null || (!connected && !host.trim())}
          onClick={() => {
            if (connected) {
              void handleDisconnect();
            } else {
              void handleConnect();
            }
          }}
        >
          {busyAction === "connect"
            ? "Connecting…"
            : busyAction === "disconnect"
              ? "Disconnecting…"
              : connected
                ? "Disconnect"
                : "Connect"}
        </button>
        <span className="text-xs text-[var(--color-text-subtle)]">
          {connected ? (
            <>
              Connected
              {deviceName ? (
                <>
                  {" "}
                  · <span className="font-medium text-[var(--color-text-primary)]">{deviceName}</span>
                </>
              ) : null}
            </>
          ) : (
            "Not connected"
          )}
        </span>
      </div>

      <div className="flex shrink-0 flex-wrap gap-2">
        <button
          type="button"
          className="ui-btn-primary"
          disabled={busyAction !== null || !connected}
          onClick={() => void run("run")}
        >
          {busyAction === "run" ? "Running…" : "Run"}
        </button>
        <button type="button" className={toolbarBtn} disabled={busyAction !== null || !connected} onClick={() => void run("reload")}>
          {busyAction === "reload" ? "Reloading…" : "Reload"}
        </button>
        <button type="button" className={toolbarBtn} disabled={busyAction !== null || !connected} onClick={() => void run("stop")}>
          {busyAction === "stop" ? "Stopping…" : "Stop"}
        </button>
      </div>

      {lastError ? (
        <div className="shrink-0 rounded-lg border border-[var(--color-error-border)] bg-[var(--color-error-bg)] px-3 py-2 text-[13px] text-[var(--color-error-text)]">
          {lastError}
        </div>
      ) : null}

      {showWidgetParams ? (
        <WidgetParamsEditor
          bridgeReady={bridgeReady}
          widgetParamsText={widgetParamsText}
          setWidgetParamsText={setWidgetParamsText}
          widgetParamsError={widgetParamsError}
          setWidgetParamsError={setWidgetParamsError}
          onFormat={handleFormatWidgetParams}
          onApplyReload={handleApplyWidgetParams}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-subtle)]">Remote log</span>
        <pre
          ref={logRef}
          className="min-h-[160px] flex-1 overflow-auto rounded-lg border border-edge bg-[var(--color-surface-elevated)] p-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-primary)]"
        >
          {logLines.join("\n")}
        </pre>
      </div>
    </div>
  );
}
