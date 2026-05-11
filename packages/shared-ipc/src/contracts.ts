export const IPCChannels = {
  bootstrapState: "agent:bootstrap-state",
  pickWorkspace: "agent:pick-workspace",
  startNewProject: "agent:start-new-project",
  /** Main → renderer: clear chat/logs/session UI (bootstrap comes from invoke return values). */
  sessionReset: "agent:session-reset",
  sendPrompt: "agent:send-prompt",
  subscribeEvents: "agent:subscribe-events",
  getProviderSettings: "agent:get-provider-settings",
  saveProviderSettings: "agent:save-provider-settings",
  getPythonRuntimeStatus: "agent:get-python-runtime-status",
  subscribePythonRuntimeStatus: "agent:subscribe-python-runtime-status",
  getSelectedPythonPath: "agent:get-selected-python-path",
  pickPythonPath: "agent:pick-python-path",
  assetsGetManifest: "assets:get-manifest",
  assetsSubscribeManifest: "assets:subscribe-manifest",
  assetsBindSlot: "assets:bind-slot",
  assetsUnbindSlot: "assets:unbind-slot",
  assetsApplyAssets: "assets:apply-assets",
  assetsReadPreview: "assets:read-preview",
  /** Renderer invokes for initial sync; main may push updates via `windowChromeInsetsChanged`. */
  windowChromeInsets: "shell:window-chrome-insets",
  /** Main → renderer: safe-area around OS window controls (logical px). */
  windowChromeInsetsChanged: "shell:window-chrome-insets-changed",
  deployGetEligibility: "deploy:get-eligibility",
  deployConnect: "deploy:connect",
  deployDisconnect: "deploy:disconnect",
  deployRun: "deploy:run",
  deployReload: "deploy:reload",
  deployStop: "deploy:stop",
  /** Main → renderer: remote debug log line or status message. */
  deployLog: "deploy:log"
} as const;

/** Padding (logical px) that MUST stay clear of traffic lights / caption overlay. */
export interface WindowChromeInsets {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export type ProviderStatus = "ready" | "missing_config" | "invalid";

export interface BootstrapState {
  workspaceRoot: string | null;
  providerStatus: ProviderStatus;
  firstRunComplete: boolean;
}

export interface PromptRequest {
  prompt: string;
  projectType?: ProjectType;
  widgetSize?: WidgetSize;
  workspacePath?: string;
  templateMode?: "game-creator" | "widget-creator" | "asset-applier";
  /** Required when `templateMode === "asset-applier"`. */
  assetApply?: {
    slotIds: string[];
    projectType: ProjectType;
  };
}

export type ProjectType = "game" | "widget";

export type WidgetSize = "128x160" | "128x128" | "128x64" | "64x32";

export interface PickWorkspaceRequest {
  requireEmpty?: boolean;
}

export interface PickWorkspaceResponse {
  state: BootstrapState;
  selectedPath: string | null;
  accepted: boolean;
  reason?: "cancelled" | "non_empty";
}

export interface ProviderSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SaveProviderSettingsRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type AgentEvent =
  | {
    type: "stream";
    delta: string;
    at: number;
  }
  | {
    type: "status";
    message: string;
    at: number;
  }
  | {
    type: "error";
    message: string;
    at: number;
  }
  | {
    type: "final";
    content: string;
    at: number;
  };

export type AssetKind = "static" | "gif" | "spritesheet";

export interface AssetBinding {
  /** Workspace-relative source path under `assets/_sources/<id>.<ext>`. */
  source: string;
  /** Workspace-relative paths to preprocessed per-frame PNGs, in playback order. */
  frames: string[];
  /** Workspace-relative path to per-slot meta.json. */
  meta: string;
}

export interface AssetSlot {
  id: string;
  description: string;
  kind: AssetKind;
  /** [width, height] of a single frame in pixels. */
  size: [number, number];
  /** Frame count: 1 for `static`, n for `gif` / `spritesheet`. */
  frames: number;
  placeholder: {
    color: [number, number, number];
  };
  binding: AssetBinding | null;
}

export interface AssetManifest {
  /** Schema version reserved for future migrations; v1 is `1`. */
  version: 1;
  slots: AssetSlot[];
}

export interface AssetMeta {
  frames: number;
  /** Per-frame durations in ms; required for `gif`, optional for other kinds. */
  durations_ms?: number[];
}

export type AssetBindErrorCode =
  | "manifest_missing"
  | "slot_not_found"
  | "unreadable_image"
  | "dimension_mismatch"
  | "frame_count_mismatch"
  | "pillow_unavailable"
  | "io_error"
  | "preprocessor_crashed";

export interface AssetBindError {
  code: AssetBindErrorCode;
  message: string;
  slotId: string;
}

export interface BindSlotRequest {
  workspacePath: string;
  slotId: string;
  /** Absolute filesystem path to the user-supplied source file. */
  sourcePath: string;
}

export type BindSlotResponse =
  | { ok: true; slotId: string; binding: AssetBinding }
  | { ok: false; error: AssetBindError };

export interface UnbindSlotRequest {
  workspacePath: string;
  slotId: string;
  /** When true, removes preprocessed `assets/<id>/` outputs from disk; defaults to false. */
  removeOutputs?: boolean;
}

export type UnbindSlotResponse =
  | { ok: true; slotId: string }
  | { ok: false; error: AssetBindError };

export interface ManifestSnapshot {
  workspacePath: string;
  manifest: AssetManifest | null;
  /** Slot ids whose binding has changed since the last successful Apply Assets run. */
  pendingChangeSlotIds: string[];
}

export interface ApplyAssetsRequest {
  workspacePath: string;
  /** Slot ids to apply; defaults to all currently-pending slots when omitted. */
  slotIds?: string[];
}

export type ApplyAssetsResponse =
  | { ok: true; appliedSlotIds: string[] }
  | { ok: false; reason: "no_pending_changes" | "missing_workspace" | "missing_conf" | "unknown"; message?: string };

export interface ReadPreviewRequest {
  workspacePath: string;
  /** Workspace-relative path to a preprocessed frame PNG (e.g. `assets/<id>/frame_000.png`). */
  framePath: string;
}

export type ReadPreviewResponse =
  | { ok: true; dataUrl: string }
  | { ok: false; message: string };

/** Result of parsing workspace root `conf.json` for deploy-to-machine eligibility. */
export type DeployEligibility =
  | { ok: true; appId: string; projectType: ProjectType }
  | { ok: false; reason: string };

export interface DeployConnectRequest {
  host: string;
}

export type DeployConnectResponse =
  | { ok: true; deviceName: string | null }
  | { ok: false; error: string };

export type DeployActionResponse = { ok: true } | { ok: false; error: string };

/** Optional payload for `deploy:run` / `deploy:reload` when the workspace is a widget. */
export interface DeployLaunchRequest {
  /** JSON object text; passed to the device as `main.py --params <json>`. */
  widgetParamsJson?: string;
}

/**
 * Validates workspace `conf.json` content for the debug deploy module.
 * Requires parseable JSON object with non-empty `id` and `type` of widget or game.
 */
export function validateDeployWorkspaceConf(raw: unknown): DeployEligibility {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "invalid_conf" };
  }
  const c = raw as Record<string, unknown>;
  const id = c.id;
  const type = c.type;
  if (typeof id !== "string" || !id.trim()) {
    return { ok: false, reason: "missing_id" };
  }
  const trimmedId = id.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmedId)) {
    return { ok: false, reason: "invalid_id" };
  }
  if (type !== "widget" && type !== "game") {
    return { ok: false, reason: "invalid_type" };
  }
  return { ok: true, appId: trimmedId, projectType: type };
}
