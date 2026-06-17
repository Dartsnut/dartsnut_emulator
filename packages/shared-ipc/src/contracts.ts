import { POST_INTAKE_BUILD_REQUEST_PREFIX } from "./postIntakeCreatorPrompt";

export const IPCChannels = {
  bootstrapState: "agent:bootstrap-state",
  /** Main → renderer: workspace/bootstrap changed (temp allocation, pick folder, new project). */
  bootstrapStateChanged: "agent:bootstrap-state-changed",
  pickWorkspace: "agent:pick-workspace",
  /** Completes a blocking `dartsnut_ask_question` call for project type or widget size (chip row). */
  intakeSubmitQuestionAnswer: "agent:intake-submit-question-answer",
  startNewProject: "agent:start-new-project",
  /** Copy/move the tracked temp workspace to a user-chosen folder and clear temp tracking. */
  saveTempWorkspace: "agent:save-temp-workspace",
  /** Main → renderer: clear chat/logs/session UI (bootstrap comes from invoke return values). */
  sessionReset: "agent:session-reset",
  sendPrompt: "agent:send-prompt",
  /** Aborts the in-flight `sendPrompt` agent run (provider fetch + between-tool steps). */
  cancelAgent: "agent:cancel-agent",
  subscribeEvents: "agent:subscribe-events",
  getWorkspaceSessionSummary: "agent:get-workspace-session-summary",
  resetWorkspaceSession: "agent:reset-workspace-session",
  getProviderSettings: "agent:get-provider-settings",
  saveProviderSettings: "agent:save-provider-settings",
  getPythonRuntimeStatus: "agent:get-python-runtime-status",
  subscribePythonRuntimeStatus: "agent:subscribe-python-runtime-status",
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
  deployOpenLocalNetworkSettings: "deploy:open-local-network-settings",
  /** Main → renderer: remote debug log line or status message. */
  deployLog: "deploy:log",
  communityGetSession: "community:get-session",
  communityLogin: "community:login",
  communityLogout: "community:logout",
  communityListDeployDevices: "community:list-deploy-devices",
  /**
   * Main → renderer: mirror main-process terminal lines into DevTools.
   * Payload must stay free of raw LLM request/response bodies (metadata and safe summaries only).
   */
  mainProcessConsoleMirror: "agent:main-process-console-mirror"
} as const;

/** Main → renderer mirror for DevTools; never include raw chat payloads. */
export type MainProcessConsoleMirrorPayload = {
  level: "log" | "info" | "debug" | "warn" | "error";
  /**
   * Optional first `console.*` argument. When empty, only `message` is logged (one string, matches
   * `console.log(fullLine)` in the main process).
   */
  prefix: string;
  /** Log body: either the second argument next to `prefix`, or the full line when `prefix` is empty. */
  message: string;
};

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
  /** True when `workspaceRoot` is the persisted unsaved temp project directory. */
  isTemporaryWorkspace: boolean;
  /** True when the active workspace has no `conf.json` yet (run creation intake before creator tools). */
  needsCreationIntake: boolean;
}

/** IPC return from `saveTempWorkspace`. */
export type SaveTempWorkspaceResponse =
  | { ok: true; state: BootstrapState }
  | {
    ok: false;
    reason:
    | "not_temporary"
    | "cancelled"
    | "non_empty_destination"
    | "copy_failed"
    | "missing_workspace";
    message?: string;
  };

export type AgentSessionIntent = "auto" | "resume" | "fresh";

export interface PromptRequest {
  prompt: string;
  projectType?: ProjectType;
  widgetSize?: WidgetSize;
  workspacePath?: string;
  templateMode?: "game-creator" | "widget-creator" | "asset-applier";
  /**
   * Controls loading vs resetting on-disk workspace agent session (see `AgentSessionWorkspaceSummary`).
   * Omitted means **auto**: load `conversation.json` when present.
   */
  agentSession?: {
    intent: AgentSessionIntent;
  };
  /**
   * When true and no workspace is selected yet, main runs a short **creation intake** turn
   * (host tools `dartsnut_ask_question` + `dartsnut_project_intake`), then may chain into the normal
   * creator run once workspace + routing are resolved.
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

export type AgentSessionTranscriptLineKind = "user" | "assistant" | "tool_status" | "thinking";

/** Workspace `transcript.jsonl` row shape (renderer preview). */
export interface AgentSessionTranscriptLine {
  kind: AgentSessionTranscriptLineKind;
  at: number;
  text: string;
  toolName?: string;
}

/** Snapshot for agent session banner + history hydrate. */
export interface AgentSessionWorkspaceSummary {
  hasPersistedSession: boolean;
  sessionId: string | null;
  updatedAt: string | null;
  templateMode: string | null;
  transcriptTail: AgentSessionTranscriptLine[];
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

/** Payload from the renderer when the user picks a chip during `dartsnut_ask_question`. */
export type IntakeSubmitQuestionAnswerRequest =
  | { kind: "project_type"; value: ProjectType }
  | { kind: "widget_size"; value: WidgetSize };

export type IntakeSubmitQuestionAnswerResponse =
  | { ok: true }
  | { ok: false; reason: "no_pending" | "kind_mismatch" | "invalid_value" };

const TRANSCRIPT_USER_REQUEST_SECTION = "\n\nUser request:\n";

/** Prefix line inside the post-intake creator user prompt (see `buildPostIntakeCreatorUserPrompt`). */
const TRANSCRIPT_POST_INTAKE_ORIGINAL_PREFIX =
  "Original first message (use only if it already states what to build):";

/**
 * Routed agent turns send a long `user` message (creator template + JSON context + instructions).
 * The timeline should only show what the human typed (or nothing when the host supplied only
 * boilerplate after intake).
 */
export function transcriptUserBubbleText(fullUserPrompt: string): string | null {
  const trimmed = fullUserPrompt.trim();
  if (!trimmed) {
    return null;
  }
  const markerAt = trimmed.lastIndexOf(TRANSCRIPT_USER_REQUEST_SECTION);
  const body =
    markerAt >= 0 ? trimmed.slice(markerAt + TRANSCRIPT_USER_REQUEST_SECTION.length).trim() : trimmed;
  if (!body) {
    return null;
  }

  const buildAt = body.indexOf(POST_INTAKE_BUILD_REQUEST_PREFIX);
  if (buildAt >= 0) {
    const afterBuild = body.slice(buildAt + POST_INTAKE_BUILD_REQUEST_PREFIX.length).trim();
    if (
      afterBuild.length === 0 ||
      afterBuild === "(none recorded before intake)" ||
      afterBuild === "There was no substantive first message before intake."
    ) {
      return null;
    }
    return afterBuild;
  }

  const originalAt = body.indexOf(TRANSCRIPT_POST_INTAKE_ORIGINAL_PREFIX);
  if (originalAt >= 0) {
    const afterOriginal = body.slice(originalAt + TRANSCRIPT_POST_INTAKE_ORIGINAL_PREFIX.length).trim();
    return afterOriginal.length > 0 ? afterOriginal : null;
  }

  if (body === "There was no substantive first message before intake.") {
    return null;
  }
  if (body.includes("Creation **intake just finished**")) {
    return null;
  }

  return body;
}

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

export interface UserDefineProviderSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type ProviderId = "dartsnut-llm" | "custom";

export interface ProviderSettings {
  activeProvider: ProviderId;
  custom: UserDefineProviderSettings;
  /** @deprecated Legacy alias for `custom`; kept for older callers during migration. */
  userDefine?: UserDefineProviderSettings;
}

export type SaveProviderSettingsRequest = ProviderSettings;

export type AgentEvent =
  | {
    type: "stream";
    delta: string;
    at: number;
  }
  | {
    /** Incremental model reasoning (e.g. wire `reasoning_content`); timeline renders separately from assistant content. */
    type: "reasoning_stream";
    /** Correlates all reasoning chunks and completion for a single completion step. */
    reasoningId: string;
    delta: string;
    at: number;
  }
  | {
    /** End of one completion step’s reasoning stream; renderer finalizes the active Thought block. */
    type: "reasoning_done";
    /** Must match the corresponding `reasoning_stream.reasoningId`. */
    reasoningId: string;
    at: number;
  }
  | {
    type: "status";
    message: string;
    at: number;
  }
  | {
    /** Incremental tool-call argument streaming progress (used for large file writes). */
    type: "tool_call_delta";
    callId: string;
    toolName: string;
    /** Current accumulated argument JSON text from model streaming. */
    argumentsJson: string;
    /** Best-effort file path extracted from partial arguments, when available. */
    path?: string;
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
    /** When true, the renderer shows the size chip row (`sizes`) after the model calls `dartsnut_ask_question` with `question_id` `widget_display_size`. When false, hide it. */
    visible: boolean;
    /** Supported WxH tokens for chips; set when `visible` is true. */
    sizes?: WidgetSize[];
  }
  | {
    type: "intake_project_type_prompt";
    at: number;
    /** When true, the renderer shows the Game / Widget chip row (`options`) after the model calls `dartsnut_ask_question` with `question_id` `project_type`. When false, hide it. */
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
  | { ok: false; error: string; needsLocalNetworkPermission?: true; canRetry?: true };

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
export type CommunitySessionInfo = {
  loggedIn: boolean;
  account: string | null;
  hasSupabase: boolean;
  googleClientId: string;
};

export type CommunityLoginRequest =
  | { method: "password"; account: string; password: string }
  | { method: "google"; idToken: string };

export type CommunityLoginResponse =
  | { ok: true; account: string }
  | { ok: false; code: string; message: string };

export type CommunityLogoutResponse = { ok: true };

export type CommunityDeployDevice = {
  deviceId: string;
  name: string;
  model: string;
  ipAddress: string;
  ssid: string;
  updatedAt: string | null;
};

export type CommunityListDeployDevicesResponse =
  | { ok: true; devices: CommunityDeployDevice[]; supabaseConfigured: boolean }
  | { ok: false; code: string; message: string };

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
