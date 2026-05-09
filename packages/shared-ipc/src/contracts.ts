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
  assetsReadPreview: "assets:read-preview"
} as const;

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
