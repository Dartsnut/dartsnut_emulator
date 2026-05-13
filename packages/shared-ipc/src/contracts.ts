export const IPCChannels = {
  bootstrapState: "agent:bootstrap-state",
  pickWorkspace: "agent:pick-workspace",
  startNewProject: "agent:start-new-project",
  /** Main → renderer: clear chat/logs/session UI (bootstrap comes from invoke return values). */
  sessionReset: "agent:session-reset",
  sendPrompt: "agent:send-prompt",
  /** Aborts the in-flight `sendPrompt` agent run (provider fetch + between-tool steps). */
  cancelAgent: "agent:cancel-agent",
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
  /** Renderer → main: align native title bar / system chrome with in-app light or dark theme. */
  shellUiTheme: "shell:ui-theme",
  deployGetEligibility: "deploy:get-eligibility",
  /** Main → renderer: workspace `conf.json` created/changed; payload is {@link DeployEligibility}. */
  deployEligibilityChanged: "deploy:eligibility-changed",
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

/** Matches renderer `ThemeId`; used to style Windows `titleBarOverlay` and `nativeTheme`. */
export type ShellUiTheme = "dark" | "light";

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
  /**
   * When true and no workspace is selected yet, main runs a short **creation intake** turn
   * (host tool `dartsnut_project_intake` only), then may chain into the normal creator run once
   * workspace + routing are resolved.
   */
  creationIntake?: boolean;
  /**
   * With `creationIntake`, records a size the user chose from the in-app widget size chip row.
   * Main tells the model via an `[UI] …` line so intake can call `set_widget_size` without re-asking.
   */
  intakeWidgetSizeChoice?: WidgetSize;
  /**
   * With `creationIntake`, records **game** vs **widget** from the in-app type chip row.
   * Main pre-seeds intake and adds an `[UI] …` line so the model calls `set_project_type` without re-asking.
   */
  intakeProjectTypeChoice?: ProjectType;
  /** Required when `templateMode === "asset-applier"`. */
  assetApply?: {
    slotIds: string[];
    projectType: ProjectType;
  };
}

/** IPC return from `sendPrompt` — optional routing snapshot for the renderer session chrome. */
export interface SendPromptResponse {
  ok: boolean;
  sessionRouting?: {
    templateMode: "game-creator" | "widget-creator";
    projectType: ProjectType;
    widgetSize?: WidgetSize;
  };
}

export type ProjectType = "game" | "widget";

export type WidgetSize = "128x160" | "128x128" | "128x64" | "64x32";

/** Supported physical widget display sizes (WxH string tokens). */
export const WIDGET_DISPLAY_SIZES: readonly WidgetSize[] = ["128x160", "128x128", "128x64", "64x32"];

/**
 * Creation-intake assistant text must include this exact substring when (and only when) asking the
 * user to choose **game** vs **widget**. The desktop app then shows the Game/Widget chip row.
 */
export const INTAKE_UI_SHOW_PROJECT_TYPE_MARKER = "@dartsnut-intake-ui:project-type";

/**
 * Creation-intake assistant text must include this exact substring when (and only when) asking
 * the user to pick a **widget display size**. The desktop app then shows the size chip row.
 */
export const INTAKE_UI_SHOW_WIDGET_SIZE_MARKER = "@dartsnut-intake-ui:widget-size";

/** Remove intake UI control tokens from text shown in the chat timeline. */
export function stripIntakeUiMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === INTAKE_UI_SHOW_PROJECT_TYPE_MARKER || trimmed === INTAKE_UI_SHOW_WIDGET_SIZE_MARKER) {
        return "";
      }
      return line
        .replaceAll(INTAKE_UI_SHOW_PROJECT_TYPE_MARKER, "")
        .replaceAll(INTAKE_UI_SHOW_WIDGET_SIZE_MARKER, "");
    })
    .join("\n");
}

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
  }
  | {
    type: "intake_widget_size_prompt";
    at: number;
    /** When true, the renderer may show the size chip row (`sizes`) after the model includes `@dartsnut-intake-ui:widget-size` in its reply. When false, hide it. */
    visible: boolean;
    /** Supported WxH tokens for chips; set when `visible` is true. */
    sizes?: WidgetSize[];
  }
  | {
    type: "intake_project_type_prompt";
    at: number;
    /** When true, the renderer may show the Game / Widget chip row (`options`) after the model includes `@dartsnut-intake-ui:project-type` in its reply. When false, hide it. */
    visible: boolean;
    options?: ProjectType[];
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
