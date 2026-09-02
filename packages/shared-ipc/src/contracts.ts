import type { ChatMediaAttachment } from "./chatMediaAttachments";
import type { AgentProfileId } from "./agentProfiles";

export const IPCChannels = {
  bootstrapState: "agent:bootstrap-state",
  /** Main -> renderer: active project/chat or workspace bootstrap changed. */
  bootstrapStateChanged: "agent:bootstrap-state-changed",
  pickWorkspace: "agent:pick-workspace",
  /** Completes a blocking machine selection/input question for MCP connection. */
  machineMcpSubmitQuestionAnswer: "agent:machine-mcp-submit-question-answer",
  /** Completes a blocking question asked by the active agent run. */
  agentQuestionSubmitAnswer: "agent:question-submit-answer",
  /** Main → renderer: clear chat/logs/session UI (bootstrap comes from invoke return values). */
  sessionReset: "agent:session-reset",
  sendPrompt: "agent:send-prompt",
  /** Aborts the in-flight `sendPrompt` agent run (provider fetch + between-tool steps). */
  cancelAgent: "agent:cancel-agent",
  subscribeEvents: "agent:subscribe-events",
  getWorkspaceSessionSummary: "agent:get-workspace-session-summary",
  resetWorkspaceSession: "agent:reset-workspace-session",
  projectsList: "agent:projects-list",
  projectCreate: "agent:project-create",
  projectRemove: "agent:project-remove",
  projectSelect: "agent:project-select",
  chatArchive: "agent:chat-archive",
  chatGenerateTitle: "agent:chat-generate-title",
  chatCreate: "agent:chat-create",
  chatSelect: "agent:chat-select",
  projectSwitchProgress: "agent:project-switch-progress",
  getProviderSettings: "agent:get-provider-settings",
  saveProviderSettings: "agent:save-provider-settings",
  getPythonRuntimeStatus: "agent:get-python-runtime-status",
  subscribePythonRuntimeStatus: "agent:subscribe-python-runtime-status",
  getPythonRuntimeProgress: "agent:get-python-runtime-progress",
  subscribePythonRuntimeProgress: "agent:subscribe-python-runtime-progress",
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
  /** Main → renderer: desktop app update lifecycle changed. */
  appUpdateStatusChanged: "app:update-status-changed",
  /** Renderer invokes for current desktop app update lifecycle state. */
  appUpdateStatus: "app:update-status",
  /** Renderer → main: install an already-downloaded desktop app update and relaunch. */
  appUpdateInstallNow: "app:update-install-now",
  /** Renderer invokes to read whether automatic update downloads are enabled. */
  appUpdateAutoDownload: "app:update-auto-download",
  /** Renderer invokes to persist automatic update download preference. */
  appUpdateSetAutoDownload: "app:update-set-auto-download",
  /** Renderer → main: download an available desktop app update on demand. */
  appUpdateDownload: "app:update-download",
  /** Renderer → main: manually check for a desktop app update. */
  appUpdateCheck: "app:update-check",
  deployGetEligibility: "deploy:get-eligibility",
  widgetConfigGet: "widget-config:get",
  widgetConfigChanged: "widget-config:changed",
  /** Main → renderer: workspace `conf.json` created/changed; payload is {@link DeployEligibility}. */
  deployEligibilityChanged: "deploy:eligibility-changed",
  deployConnect: "deploy:connect",
  deployConnectionChanged: "deploy:connection-changed",
  deployDisconnect: "deploy:disconnect",
  deployRun: "deploy:run",
  deployReload: "deploy:reload",
  deployApplyWidgetParams: "deploy:apply-widget-params",
  deployStop: "deploy:stop",
  deployOpenLocalNetworkSettings: "deploy:open-local-network-settings",
  /** Main → renderer: remote debug log line or status message. */
  deployLog: "deploy:log",
  /** Main → renderer: safe sideload display frame, or inactive state after stop/expiry. */
  deployFrame: "deploy:frame",
  communityGetSession: "community:get-session",
  communityLogin: "community:login",
  communitySetPassword: "community:set-password",
  communityCancelGoogleLogin: "community:cancel-google-login",
  communityLogout: "community:logout",
  communityGetLlmQuota: "community:get-llm-quota",
  communityListDeployDevices: "community:list-deploy-devices",
  communityListMyGames: "community:list-my-games",
  communityGetPublishOptions: "community:get-publish-options",
  communityListAppVersions: "community:list-app-versions",
  communityCreateApp: "community:create-app",
  communitySubmitAppVersion: "community:submit-app-version",
  communityUpdateWorkspaceVersion: "community:update-workspace-version",
  /** Main → renderer: current package/upload/review stage for the blocking submission overlay. */
  communitySubmitProgress: "community:submit-progress",
  communityWithdrawAppVersion: "community:withdraw-app-version",
  communityUploadNativeImage: "community:upload-native-image",
  /**
   * Main → renderer: mirror main-process terminal lines into DevTools.
   * Payload must stay free of raw LLM request/response bodies (metadata and safe summaries only).
   */
  mainProcessConsoleMirror: "agent:main-process-console-mirror",
  rendererReady: "agent:renderer-ready",
  reportRendererError: "agent:report-renderer-error",
  openStartupLogs: "agent:open-startup-logs",
  copyStartupDiagnostics: "agent:copy-startup-diagnostics",
  resetRendererState: "agent:reset-renderer-state",
  restartWithoutGpu: "agent:restart-without-gpu"
} as const;

export type RendererErrorPayload = {
  message: string;
  stack?: string;
  source?: string;
};

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
export type ShellUiTheme = "system" | "dark" | "light";

export type AppUpdateStatusKind =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "not_available"
  | "error";

export interface AppUpdateStatus {
  kind: AppUpdateStatusKind;
  currentVersion: string;
  availableVersion: string | null;
  percent: number | null;
  message: string | null;
}

export type AppUpdateInstallResponse =
  | { ok: true }
  | { ok: false; reason: "not_ready" | "cancelled" };

export type AppUpdateDownloadResponse =
  | { ok: true }
  | { ok: false; reason: "not_available" | "already_downloading" | "failed"; message?: string };

export type AppUpdateCheckResponse =
  | { ok: true }
  | { ok: false; reason: "disabled" | "already_checking" | "already_ready" | "failed"; message?: string };

export type ProviderStatus = "ready" | "missing_config" | "invalid";

export interface PythonRuntimeProgress {
  running: boolean;
  stage: "check" | "probe" | "download" | "verify" | "extract" | "install" | "validate" | "complete" | "error" | null;
  percent: number;
  message: string | null;
  error?: string;
  artifact?: string;
}

export interface BootstrapState {
  workspaceRoot: string | null;
  activeProjectId: string | null;
  activeChatId: string | null;
  providerStatus: ProviderStatus;
  firstRunComplete: boolean;
}

export interface ProjectRecord { id: string; name: string; folderPath: string; createdAt: string; updatedAt: string; lastOpenedAt: string; migrationComplete?: boolean; }
export interface ChatRecord { id: string; projectId: string; title: string; createdAt: string; updatedAt: string; archivedAt?: string; }
export interface ProjectTree { projects: ProjectRecord[]; chats: ChatRecord[]; }
export interface ProjectCreateRequest {
  folderPath: string;
  name?: string;
  /** Creates and selects a persona-bound chat as part of project creation. */
  agentProfileId?: AgentProfileId;
}
export interface ProjectSelectRequest { projectId: string | null; chatId?: string; }
export interface ChatCreateRequest { projectId: string; agentProfileId: AgentProfileId; }
export interface ChatGenerateTitleRequest { chatId: string; firstUserMessage: string; }
export type ProjectSwitchProgress = { active: boolean; stage: "confirming" | "stopping-deployment" | "stopping-emulator" | "switching" | "reloading" | "ready" | "error"; message?: string };

export type AgentSessionIntent = "auto" | "resume" | "fresh";

export interface PromptRequest {
  prompt: string;
  /** Media files dropped onto the chat composer. Main copies these into the workspace before the agent sees them. */
  chatMediaAttachments?: ChatMediaAttachment[];
  projectType?: ProjectType;
  widgetSize?: WidgetSize;
  workspacePath?: string;
  projectId?: string;
  chatId?: string;
  agentProfileId?: AgentProfileId;
  templateMode?: "game-creator" | "widget-creator" | "asset-applier";
  /**
   * Controls loading vs resetting on-disk workspace agent session (see `AgentSessionWorkspaceSummary`).
   * Omitted means **auto**: load `conversation.json` when present.
   */
  agentSession?: {
    intent: AgentSessionIntent;
  };
  /** Required when `templateMode === "asset-applier"`. */
  assetApply?: {
    slotIds: string[];
    projectType: ProjectType;
  };
}

export type DartsnutLlmFailureReason =
  | "auth_required"
  | "no_bound_machine"
  | "daily_quota_exceeded"
  | "run_already_active"
  | "run_expired"
  | "service_unavailable";

/** IPC return from `sendPrompt` — optional routing snapshot or typed Dartsnut LLM rejection. */
export interface SendPromptResponse {
  ok: boolean;
  failureReason?: DartsnutLlmFailureReason;
  message?: string;
  sessionRouting?: {
    templateMode: "game-creator" | "widget-creator";
    projectType: ProjectType;
    widgetSize?: WidgetSize;
  };
}

export type AgentSessionTranscriptLineKind = "user" | "assistant" | "tool_status" | "thinking";

export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AgentSessionTokenUsage extends AgentTokenUsage {
  lastRun?: AgentTokenUsage;
}

/** Workspace `transcript.jsonl` row shape (renderer preview). */
export interface AgentSessionTranscriptLine {
  kind: AgentSessionTranscriptLineKind;
  at: number;
  text: string;
  toolName?: string;
}

/** Snapshot for agent session banner + history hydrate. */
export interface AgentSessionWorkspaceSummary {
  chatId: string | null;
  hasPersistedSession: boolean;
  sessionId: string | null;
  updatedAt: string | null;
  templateMode: string | null;
  transcriptTail: AgentSessionTranscriptLine[];
  tokenUsage?: AgentSessionTokenUsage | null;
  agentProfileId: AgentProfileId | null;
}

export type ProjectType = "game" | "widget";

export type WidgetSize = "128x160" | "128x128" | "128x64" | "64x32";

/** Supported physical widget display sizes (WxH string tokens). */
export const WIDGET_DISPLAY_SIZES: readonly WidgetSize[] = ["128x160", "128x128", "128x64", "64x32"];

export type MachineMcpQuestionMachine = {
  deviceId: string;
  name: string;
  model: string;
  ipAddress: string;
  ssid: string;
  updatedAt: string | null;
};

export type MachineMcpSubmitQuestionAnswerRequest =
  | { kind: "machine"; deviceId: string; ipAddress: string }
  | { kind: "manual_ip"; value: string };

export type MachineMcpSubmitQuestionAnswerResponse =
  | { ok: true }
  | { ok: false; reason: "no_pending" | "invalid_value" };

export type AgentQuestionOption = {
  value: string;
  label: string;
};

export type AgentQuestionPrompt = {
  question: string;
  options?: AgentQuestionOption[];
  allowFreeText?: boolean;
  freeTextPlaceholder?: string;
};

export type AgentQuestionAnswerRequest = {
  questionId: string;
  value: string;
};

export type AgentQuestionAnswerResponse =
  | { ok: true }
  | { ok: false; reason: "no_pending" | "stale_question" | "invalid_value" };

const TRANSCRIPT_USER_REQUEST_SECTION = "\n\nUser request:\n";

/**
 * Routed agent turns may append creation context before the human request.
 * The timeline only shows what the human typed.
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

  return body;
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

export interface CustomProviderSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type ProviderId = "dartsnut-llm" | "custom";

export interface ProviderSettings {
  activeProvider: ProviderId;
  custom: CustomProviderSettings;
}

export type SaveProviderSettingsRequest = ProviderSettings;

export type AgentSdkStreamEvent =
  | {
    type: "raw_model_stream_event";
    source?: string;
    data: unknown;
  }
  | {
    type: "run_item_stream_event";
    name: string;
    item: unknown;
  }
  | {
    type: "agent_updated_stream_event";
    agent: unknown;
  };

export type AgentEvent =
  | AgentSdkStreamEvent
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
    type: "token_usage";
    at: number;
    runUsage: AgentTokenUsage;
    sessionUsage: AgentSessionTokenUsage;
  }
  | {
    type: "machine_mcp_prompt";
    at: number;
    /** When true, renderer asks the user which machine/IP to use for MCP. */
    visible: boolean;
    machines?: MachineMcpQuestionMachine[];
    manualOnly?: boolean;
  }
  | ({
    type: "agent_question";
    questionId: string;
    visible: boolean;
  } & AgentQuestionPrompt);

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

/** Result of classifying the workspace project files for deploy-to-machine eligibility. */
export type DeployEligibility =
  | { ok: true; appId: string; version: string; projectType: ProjectType }
  | { ok: false; reason: string };

export interface DeployConnectRequest {
  host: string;
}

export type DeployConnectResponse =
  | { ok: true; deviceName: string | null; deployMode: "safe_sideload" | "legacy_unsafe" }
  | { ok: false; error: string; needsLocalNetworkPermission?: true; canRetry?: true };

export type DeployConnectionState = {
  connected: boolean;
  deviceName: string | null;
  deployMode: "safe_sideload" | "legacy_unsafe" | null;
};

export type DeployActionResponse = { ok: true } | { ok: false; error: string };

export type DeployFrameEvent =
  | { active: false }
  | { active: true; frame: { width: number; height: number; rgbBase64: string; timestampMs: number } };

/** Optional payload for `deploy:run` / `deploy:reload` when the workspace is a widget. */
export interface DeployLaunchRequest {
  /** JSON object text; passed to the device as `main.py --params <json>`. */
  widgetParamsJson?: string;
}

export type CommunitySessionInfo = {
  loggedIn: boolean;
  account: string | null;
  analyticsUserId: string | null;
  authMethod: "password" | "google" | null;
  hasSupabase: boolean;
  googleClientId: string;
  googleDesktopClientId: string;
  googleSignInAvailable: boolean;
};

export type CommunityLoginRequest =
  | { method: "password"; account: string; password: string }
  | { method: "google"; idToken: string }
  | { method: "googleOAuth" };

export type CommunityLoginResponse =
  | { ok: true; account: string; needsPasswordSetup: boolean }
  | { ok: false; code: string; message: string };

export type CommunitySetPasswordRequest = { password: string };

export type CommunitySetPasswordResponse =
  | { ok: true; account: string }
  | { ok: false; code: string; message: string };

export type CommunityCancelGoogleLoginResponse = { ok: true };

export type CommunityLogoutResponse = { ok: true };

export type CommunityLlmQuotaStatus = {
  accountId: number;
  usageDate: string;
  inputTokens: number;
  outputTokens: number;
  usedTokens: number;
  customLimitTokens: number | null;
  limitTokens: number;
  defaultLimitTokens: number;
  remainingTokens: number;
  quotaExceeded: boolean;
  accountingHealth: string;
};

export type CommunityGetLlmQuotaResponse =
  | { ok: true; quota: CommunityLlmQuotaStatus }
  | { ok: false; code: string; message: string; serverMessage?: string; authRequired?: boolean };

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
  | { ok: false; code: string; message: string; serverMessage?: string; authRequired?: boolean };

export type CommunityGameSummary = {
  id: number | string;
  gameId: string;
  gameName: string;
  mainCover: string;
  description: string;
  status: string;
  createdAt: string | null;
};

export type CommunityListMyGamesResponse =
  | { ok: true; games: CommunityGameSummary[]; total: number }
  | { ok: false; code: string; message: string; serverMessage?: string; authRequired?: boolean };

export type CommunityAppSummary = {
  id: number | string;
  appId: string;
  appName: string;
  projectType: ProjectType;
  mainCover: string;
  description: string;
  status: string;
  createdAt: string | null;
};

export type CommunityCategoryOption = {
  id: number | string;
  name: string;
};

export type CommunityControlOption = {
  value: string;
  label: string;
};

export type CommunitySizeOption = {
  value: string;
  label: string;
};

export type CommunityVersionSummary = {
  id: number | string;
  appSystemId: number | string;
  projectType: ProjectType;
  version: string;
  description: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  reviewAction: string;
  reviewComment: string;
  reviewedAt: string | null;
  preview: string[];
};

export type CommunityWorkspaceDefaults = {
  eligible: boolean;
  appId: string;
  projectType: ProjectType | null;
  appName: string;
  version: string;
  description: string;
  widgetSize: string;
};

export type CommunityGetPublishOptionsResponse =
  | {
      ok: true;
      games: CommunityAppSummary[];
      widgets: CommunityAppSummary[];
      gameCategories: CommunityCategoryOption[];
      widgetCategories: CommunityCategoryOption[];
      gameControls: CommunityControlOption[];
      widgetControls: CommunityControlOption[];
      widgetSizes: CommunitySizeOption[];
      workspace: CommunityWorkspaceDefaults;
    }
  | { ok: false; code: string; message: string; serverMessage?: string; authRequired?: boolean };

export type CommunityListAppVersionsRequest = {
  projectType: ProjectType;
  appSystemId: number | string;
};

export type CommunityListAppVersionsResponse =
  | { ok: true; versions: CommunityVersionSummary[]; total: number }
  | { ok: false; code: string; message: string; serverMessage?: string; authRequired?: boolean };

export type CommunityCreateAppRequest = {
  projectType: ProjectType;
  mainCover: string;
  appName: string;
  appId: string;
  categoryId: number | string;
  minPersonal?: number | null;
  maxPersonal?: number | null;
  control: string[];
  widgetSize?: string;
};

export type CommunityCreateAppResponse =
  | { ok: true; app: CommunityAppSummary }
  | { ok: false; code: string; message: string; serverMessage?: string; authRequired?: boolean };

export type CommunityUploadNativeImageRequest = {
  filePath: string;
};

export type CommunityUploadNativeImageResponse =
  | { ok: true; url: string }
  | { ok: false; code: string; message: string; serverMessage?: string; authRequired?: boolean };

export type CommunitySubmitAppVersionRequest = {
  projectType: ProjectType;
  appSystemId: number | string;
  version: string;
  description: string;
  fields?: string;
  preview: string[];
};

export type CommunitySubmitProgressStage =
  | "creating"
  | "packaging"
  | "uploading"
  | "submitting"
  | "cleaning";

export type CommunitySubmitProgress = {
  stage: CommunitySubmitProgressStage;
  message: string;
};

export type CommunitySubmitAppVersionResponse =
  | {
      ok: true;
      versionId: number | string | null;
      status: string;
      downloadUrl: string;
      downloadMd5: string;
    }
  | { ok: false; code: string; message: string; serverMessage?: string; authRequired?: boolean };

export type CommunityUpdateWorkspaceVersionRequest = {
  version: string;
};

export type CommunityUpdateWorkspaceVersionResponse =
  | { ok: true; workspace: CommunityWorkspaceDefaults }
  | {
      ok: false;
      code: "no_workspace" | "invalid_version" | "invalid_workspace" | "write_failed";
      message: string;
    };

export type CommunityWithdrawAppVersionRequest = {
  projectType: ProjectType;
  versionId: number | string;
};

export type CommunityWithdrawAppVersionResponse =
  | { ok: true; status: string }
  | { ok: false; code: string; message: string; serverMessage?: string; authRequired?: boolean };
