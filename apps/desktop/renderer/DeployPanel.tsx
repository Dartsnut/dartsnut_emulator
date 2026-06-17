import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  CommunityDeployDevice,
  CommunitySessionInfo,
  DeployConnectResponse
} from "@dartsnut/shared-ipc";
import { applyWidgetParamsAndReload, formatWidgetParamsJson } from "./widgetParams";
import { WidgetParamsEditor } from "./WidgetParamsEditor";

const toolbarBtn = "ui-toolbar-btn";
const MANUAL_DEVICE_VALUE = "__manual__";

export type DeployPanelProps = {
  showWidgetParams: boolean;
  widgetParamsText: string;
  setWidgetParamsText: Dispatch<SetStateAction<string>>;
  widgetParamsError: string | null;
  setWidgetParamsError: Dispatch<SetStateAction<string | null>>;
  communitySession: CommunitySessionInfo;
  communitySessionVersion: number;
  onCommunitySessionChange: () => Promise<void>;
};

function formatDeviceOptionLabel(device: CommunityDeployDevice): string {
  const parts = [device.name || device.deviceId];
  if (device.ssid) {
    parts.push(device.ssid);
  }
  if (device.ipAddress) {
    parts.push(device.ipAddress);
  } else {
    parts.push("no IP");
  }
  return parts.join(" · ");
}

export function DeployPanel({
  showWidgetParams,
  widgetParamsText,
  setWidgetParamsText,
  widgetParamsError,
  setWidgetParamsError,
  communitySession,
  communitySessionVersion,
  onCommunitySessionChange
}: DeployPanelProps) {
  const api = window.dartsnutApi;
  const [host, setHost] = useState("");
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement | null>(null);
  const [localNetworkRetryPrompt, setLocalNetworkRetryPrompt] = useState(false);
  const [settingsOpenError, setSettingsOpenError] = useState<string | null>(null);

  const [devices, setDevices] = useState<CommunityDeployDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [supabaseConfigured, setSupabaseConfigured] = useState(false);
  const [selectedDeviceKey, setSelectedDeviceKey] = useState("");
  const [signingOut, setSigningOut] = useState(false);

  const bridgeReady = Boolean(api?.sendEmulatorCommand);
  const loggedIn = communitySession.loggedIn;
  const manualIpMode =
    !loggedIn || selectedDeviceKey === MANUAL_DEVICE_VALUE || selectedDeviceKey === "";
  const selectedDevice =
    selectedDeviceKey && selectedDeviceKey !== MANUAL_DEVICE_VALUE
      ? devices.find((d) => d.deviceId === selectedDeviceKey) ?? null
      : null;
  const selectedMissingIp = Boolean(selectedDevice && !selectedDevice.ipAddress.trim());
  const hostInputDisabled =
    busyAction !== null || connected || (Boolean(selectedDevice?.ipAddress) && !manualIpMode);

  const loadDevices = useCallback(async () => {
    if (!api?.communityListDeployDevices || !loggedIn) {
      setDevices([]);
      setDevicesError(null);
      setSupabaseConfigured(false);
      return;
    }
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const res = await api.communityListDeployDevices();
      if (!res.ok) {
        setDevices([]);
        setDevicesError(res.message);
        if (res.code === "session_expired") {
          await onCommunitySessionChange();
        }
        return;
      }
      setDevices(res.devices);
      setSupabaseConfigured(res.supabaseConfigured);
      if (
        selectedDeviceKey &&
        selectedDeviceKey !== MANUAL_DEVICE_VALUE &&
        !res.devices.some((d) => d.deviceId === selectedDeviceKey)
      ) {
        setSelectedDeviceKey("");
        setHost("");
      }
    } catch (e) {
      setDevices([]);
      setDevicesError(e instanceof Error ? e.message : String(e));
    } finally {
      setDevicesLoading(false);
    }
  }, [api, loggedIn, onCommunitySessionChange, selectedDeviceKey]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices, communitySessionVersion]);

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

  useEffect(() => {
    if (manualIpMode || !selectedDevice) {
      return;
    }
    const ip = selectedDevice.ipAddress.trim();
    if (ip) {
      setHost(ip);
    }
  }, [manualIpMode, selectedDevice]);

  function handleDeviceSelectChange(value: string) {
    setSelectedDeviceKey(value);
    setLastError(null);
    setLocalNetworkRetryPrompt(false);
    setSettingsOpenError(null);
    if (value === MANUAL_DEVICE_VALUE || value === "") {
      return;
    }
    const device = devices.find((d) => d.deviceId === value);
    if (device?.ipAddress.trim()) {
      setHost(device.ipAddress.trim());
    } else {
      setHost("");
    }
  }

  async function handleSignOut() {
    if (!api?.communityLogout) {
      return;
    }
    setSigningOut(true);
    try {
      await api.communityLogout();
      setSelectedDeviceKey("");
      setDevices([]);
      await onCommunitySessionChange();
    } finally {
      setSigningOut(false);
    }
  }

  async function handleConnect() {
    if (!api?.deployConnect) {
      return;
    }
    setLastError(null);
    setSettingsOpenError(null);
    setBusyAction("connect");
    setDeviceName(null);
    setConnected(false);
    try {
      const result: DeployConnectResponse = await api.deployConnect({ host });
      if (!result.ok) {
        setLocalNetworkRetryPrompt(Boolean(result.needsLocalNetworkPermission));
        setLastError(result.error);
        return;
      }
      setLocalNetworkRetryPrompt(false);
      setConnected(true);
      setDeviceName(result.deviceName ?? null);
    } catch (e) {
      setLocalNetworkRetryPrompt(false);
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
      setWidgetParamsError
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

  async function handleOpenLocalNetworkSettings() {
    if (!api?.deployOpenLocalNetworkSettings) {
      return;
    }
    setSettingsOpenError(null);
    const result = await api.deployOpenLocalNetworkSettings();
    if (!result.ok) {
      setSettingsOpenError(result.error);
    }
  }

  if (!api?.deployConnect || !api?.deployDisconnect) {
    return (
      <div className="flex flex-col gap-2 p-4 text-sm text-[var(--color-text-subtle)]">
        Deploy bridge unavailable. Rebuild the desktop app.
      </div>
    );
  }

  const canConnect = connected || host.trim().length > 0;
  const showLocalNetworkBanner = localNetworkRetryPrompt;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <h2 className="ui-panel-title">Deploy</h2>

      {showLocalNetworkBanner ? (
        <div className="flex shrink-0 flex-col gap-2 rounded-lg border border-[rgba(245,158,11,0.42)] bg-[rgba(245,158,11,0.10)] px-3 py-2 text-[13px] text-[var(--color-text-primary)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[var(--color-warning-text)]">
              macOS may have shown a Local Network prompt. Allow Dartsnut Agent, then retry the connection.
            </span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={toolbarBtn}
                disabled={busyAction !== null || !canConnect}
                onClick={() => void handleConnect()}
              >
                Retry Connect
              </button>
              <button
                type="button"
                className={toolbarBtn}
                onClick={() => void handleOpenLocalNetworkSettings()}
              >
                Open System Settings
              </button>
            </div>
          </div>
          <span className="text-xs text-[var(--color-text-subtle)]">
            If it does not open directly, go to System Settings → Privacy &amp; Security → Local Network and enable Dartsnut Agent.
          </span>
          {settingsOpenError ? (
            <span className="text-xs text-[var(--color-error-text)]">{settingsOpenError}</span>
          ) : null}
        </div>
      ) : null}

      {loggedIn ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-edge bg-[var(--color-surface-elevated)] px-3 py-2 text-[13px]">
          <span className="text-[var(--color-text-subtle)]">
            Signed in as{" "}
            <span className="font-medium text-[var(--color-text-primary)]">
              {communitySession.account || "—"}
            </span>
          </span>
          <button
            type="button"
            className={toolbarBtn}
            disabled={signingOut || busyAction !== null || connected}
            onClick={() => void handleSignOut()}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}

      {loggedIn ? (
        <label className="flex shrink-0 flex-col gap-1.5 text-[13px]">
          <span className="text-[var(--color-text-subtle)]">Bound device</span>
          <select
            className="ui-input"
            value={selectedDeviceKey}
            disabled={busyAction !== null || connected || devicesLoading}
            onChange={(e) => handleDeviceSelectChange(e.target.value)}
          >
            <option value="">— Select a device —</option>
            {devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {formatDeviceOptionLabel(device)}
              </option>
            ))}
            <option value={MANUAL_DEVICE_VALUE}>Enter IP manually</option>
          </select>
          {devicesLoading ? (
            <span className="text-xs text-[var(--color-text-subtle)]">Loading devices…</span>
          ) : null}
          {devicesError ? (
            <span className="text-xs text-[var(--color-error-text)]">{devicesError}</span>
          ) : null}
          {!devicesLoading && !devices.length && !devicesError ? (
            <span className="text-xs text-[var(--color-text-subtle)]">
              No devices bound to this account yet.
            </span>
          ) : null}
          {loggedIn && !supabaseConfigured && devices.length > 0 ? (
            <span className="text-xs text-[var(--color-text-subtle)]">
              Supabase is not configured in .env (DARTSNUT_SUPABASE_ANON_KEY); device names only, no
              auto IP.
            </span>
          ) : null}
          {selectedMissingIp ? (
            <span className="text-xs text-[var(--color-error-text)]">
              This device has not reported an IP yet. Enter an IP below or wait for the device to sync.
            </span>
          ) : null}
        </label>
      ) : null}

      <label className="flex shrink-0 flex-col gap-1.5 text-[13px]">
        <span className="text-[var(--color-text-subtle)]">Device IP or hostname</span>
        <input
          type="text"
          className="ui-input font-mono"
          placeholder="192.168.x.x"
          value={host}
          disabled={hostInputDisabled}
          onChange={(e) => setHost(e.target.value)}
        />
      </label>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          className={toolbarBtn}
          disabled={busyAction !== null || (!connected && !canConnect)}
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
