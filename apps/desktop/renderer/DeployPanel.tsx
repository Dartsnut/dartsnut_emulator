import { useEffect, useRef, useState } from "react";
import type { DeployConnectResponse } from "@dartsnut/shared-ipc";
import { cn } from "./cn";

const toolbarBtn =
  "box-border inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-[var(--color-emulator-toolbar-border)] bg-[var(--color-emulator-toolbar-bg)] px-3 py-2 text-sm font-medium text-[var(--color-emulator-toolbar-label)] enabled:hover:bg-[var(--color-emulator-toolbar-bg-hover)] disabled:cursor-not-allowed disabled:opacity-45";

export function DeployPanel() {
  const api = window.dartsnutApi;
  const [host, setHost] = useState("");
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement | null>(null);

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

  async function run(action: "run" | "reload" | "stop") {
    if (!api) {
      return;
    }
    setLastError(null);
    setBusyAction(action);
    try {
      const result =
        action === "run"
          ? await api.deployRun()
          : action === "reload"
            ? await api.deployReload()
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

  if (!api?.deployConnect) {
    return (
      <div className="flex flex-col gap-2 p-4 text-sm text-[var(--color-text-subtle)]">
        Deploy bridge unavailable. Rebuild the desktop app.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="shrink-0">
        <p className="text-xs leading-snug text-[var(--color-text-subtle)]">
          Dev SSH user <code className="rounded bg-[var(--color-surface-muted)] px-1">rpi:rpi</code>, remote{" "}
          <code className="rounded bg-[var(--color-surface-muted)] px-1">~/dartsnut_rpi</code>. Widget subprocess CLI is documented in{" "}
          <code className="rounded bg-[var(--color-surface-muted)] px-1">apps/desktop/DEPLOY_TO_MACHINE.md</code>.
        </p>
      </div>

      <label className="flex shrink-0 flex-col gap-1 text-[13px]">
        <span className="text-[var(--color-text-subtle)]">Device IP or hostname</span>
        <input
          type="text"
          className="rounded-lg border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-2.5 py-2 font-mono text-[13px] text-[var(--color-input-text)] outline-none focus:border-[var(--color-input-focus-border)]"
          placeholder="192.168.x.x"
          value={host}
          disabled={busyAction !== null}
          onChange={(e) => setHost(e.target.value)}
        />
      </label>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button type="button" className={toolbarBtn} disabled={busyAction !== null || !host.trim()} onClick={() => void handleConnect()}>
          {busyAction === "connect" ? "Connecting…" : "Connect"}
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
          className={cn(toolbarBtn, "bg-[var(--color-btn-default-bg)] text-white")}
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
