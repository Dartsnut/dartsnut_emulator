import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentEvent,
  AgentSessionWorkspaceSummary,
  AppUpdateInstallResponse,
  AppUpdateDownloadResponse,
  AppUpdateCheckResponse,
  AppUpdateStatus,
  MainProcessConsoleMirrorPayload,
  ApplyAssetsRequest,
  ApplyAssetsResponse,
  BindSlotRequest,
  BindSlotResponse,
  BootstrapState,
  ProjectTree,
  ProjectCreateRequest,
  ProjectSelectRequest,
  ChatCreateRequest,
  ProjectSwitchProgress,
  ManifestSnapshot,
  PickWorkspaceRequest,
  PickWorkspaceResponse,
  MachineMcpSubmitQuestionAnswerRequest,
  MachineMcpSubmitQuestionAnswerResponse,
  AgentQuestionAnswerRequest,
  PromptRequest,
  ProviderSettings,
  PythonRuntimeProgress,
  ReadPreviewRequest,
  ReadPreviewResponse,
  SaveProviderSettingsRequest,
  SendPromptResponse,
  UnbindSlotRequest,
  UnbindSlotResponse,
  DeployConnectRequest,
  DeployConnectResponse,
  DeployConnectionState,
  DeployEligibility,
  DeployActionResponse,
  DeployFrameEvent,
  DeployLaunchRequest,
  CommunitySessionInfo,
  CommunityCancelGoogleLoginResponse,
  CommunityLoginRequest,
  CommunityLoginResponse,
  CommunitySetPasswordRequest,
  CommunitySetPasswordResponse,
  CommunityLogoutResponse,
  CommunityGetLlmQuotaResponse,
  CommunityListDeployDevicesResponse,
  CommunityListMyGamesResponse,
  CommunityGetPublishOptionsResponse,
  CommunityListAppVersionsRequest,
  CommunityListAppVersionsResponse,
  CommunityCreateAppRequest,
  CommunityCreateAppResponse,
  CommunityUploadNativeImageRequest,
  CommunityUploadNativeImageResponse,
  CommunitySubmitAppVersionRequest,
  CommunitySubmitAppVersionResponse,
  CommunityUpdateWorkspaceVersionRequest,
  CommunityUpdateWorkspaceVersionResponse,
  CommunitySubmitProgress,
  CommunityWithdrawAppVersionRequest,
  CommunityWithdrawAppVersionResponse,
  WindowChromeInsets,
  ShellUiTheme,
  AgentQuestionAnswerResponse as QuestionAnswerResponse,
  WidgetConfigScope,
  WidgetConfigSnapshot,
  RendererErrorPayload
} from "@dartsnut/shared-ipc";
import type {
  EmulatorCommand,
  EmulatorFrame,
  EmulatorLogEntry,
  EmulatorStateSnapshot
} from "@dartsnut/emulator-protocol";

type Listener<T> = (value: T) => void;

// WebView File objects do not expose native paths in Tauri. Keep a short-lived
// filename-to-path map populated by Tauri's native drag/drop event so existing
// renderer upload flows retain Electron parity without leaking paths to events.
const nativeDroppedPaths = new Map<string, string>();
let nativeDropListenerStarted = false;

function startNativeDropListener(): void {
  if (nativeDropListenerStarted || typeof window === "undefined") return;
  nativeDropListenerStarted = true;
  void tauriListen<{ paths?: string[] }>("tauri://drag-drop", (event) => {
    nativeDroppedPaths.clear();
    for (const filePath of event.payload?.paths ?? []) {
      const normalized = filePath.replaceAll("\\", "/");
      const name = normalized.slice(normalized.lastIndexOf("/") + 1);
      if (name) nativeDroppedPaths.set(name, filePath);
    }
    if (nativeDroppedPaths.size > 64) {
      const keep = [...nativeDroppedPaths.entries()].slice(-64);
      nativeDroppedPaths.clear();
      for (const [name, filePath] of keep) nativeDroppedPaths.set(name, filePath);
    }
  });
}

export const TAURI_COMMANDS = {
  health: "health",
  bridgeReady: "bridge_ready",
  emitBridgeEvent: "emit_bridge_event",
} as const;

export const TAURI_EVENTS = {
  bridgeReady: "dartsnut:bridge-ready",
  bridgeEvent: "dartsnut:bridge-event",
} as const;

export type TauriBridgeEventName = `dartsnut:${string}`;

export interface TauriHealthStatus {
  status: "ok";
  appId: "com.dartsnut.agent";
  scaffold: boolean;
}

export interface TauriBridgeApi {
  health: () => Promise<TauriHealthStatus>;
  bridgeReady: () => Promise<TauriHealthStatus>;
  emitBridgeEvent: <TPayload>(event: TauriBridgeEventName, payload: TPayload) => Promise<void>;
  onBridgeReady: (listener: Listener<TauriHealthStatus>) => () => void;
  onBridgeEvent: <TPayload>(event: TauriBridgeEventName, listener: Listener<TPayload>) => () => void;
}

const invoke = <T>(command: string, args?: unknown): Promise<T> =>
  tauriInvoke<T>(command, args === undefined ? undefined : { payload: args });

function subscribe<T>(event: string, listener: Listener<T>): () => void {
  let unlisten: UnlistenFn | undefined;
  let disposed = false;
  void tauriListen<T>(event, (message) => listener(message.payload)).then((stop) => {
    if (disposed) {
      stop();
    } else {
      unlisten = stop;
    }
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

function subscribeNoPayload(event: string, listener: () => void): () => void {
  return subscribe(event, () => listener());
}

export function createTauriApi(): NonNullable<Window["dartsnutApi"]> & TauriBridgeApi {
  startNativeDropListener();
  const api = {
    health: () => tauriInvoke<TauriHealthStatus>(TAURI_COMMANDS.health),
    bridgeReady: () => tauriInvoke<TauriHealthStatus>(TAURI_COMMANDS.bridgeReady),
    emitBridgeEvent: <TPayload>(event: TauriBridgeEventName, payload: TPayload) => {
      if (!event.startsWith("dartsnut:")) {
        return Promise.reject(new Error("bridge event must use dartsnut: namespace"));
      }
      return tauriInvoke<void>(TAURI_COMMANDS.emitBridgeEvent, { event, payload });
    },
    onBridgeReady: (listener: Listener<TauriHealthStatus>) =>
      subscribe(TAURI_EVENTS.bridgeReady, listener),
    onBridgeEvent: <TPayload>(event: TauriBridgeEventName, listener: Listener<TPayload>) => {
      if (!event.startsWith("dartsnut:")) {
        throw new Error("bridge event must use dartsnut: namespace");
      }
      return subscribe(event, listener);
    },
    rendererReady: () => invoke<void>("renderer_ready"),
    reportRendererError: (payload: RendererErrorPayload) => invoke<void>("report_renderer_error", payload),
    openStartupLogs: () => invoke<void>("open_startup_logs"),
    copyStartupDiagnostics: () => invoke<void>("copy_startup_diagnostics"),
    resetRendererState: () => invoke<void>("reset_renderer_state"),
    restartWithoutGpu: () => invoke<void>("restart_without_gpu"),
    getBootstrapState: () => invoke<BootstrapState>("get_bootstrap_state"),
    getWorkspaceSessionSummary: (chatId?: string) => invoke<AgentSessionWorkspaceSummary>("get_workspace_session_summary", chatId),
    resetWorkspaceSession: () => invoke("reset_workspace_session"),
    listProjects: () => invoke<ProjectTree>("list_projects"),
    createProject: (request: ProjectCreateRequest) => invoke("create_project", request),
    removeProject: (projectId: string) => invoke("remove_project", projectId),
    selectProject: (request: ProjectSelectRequest) => invoke("select_project", request),
    createChat: (request: ChatCreateRequest) => invoke("create_chat", request),
    archiveChat: (chatId: string) => invoke("archive_chat", chatId),
    generateChatTitle: (request: { chatId: string; firstUserMessage: string; fallbackOnly?: boolean }) => invoke("generate_chat_title", request),
    selectChat: (chatId: string) => invoke("select_chat", chatId),
    onProjectSwitchProgress: (listener: Listener<ProjectSwitchProgress>) => subscribe("agent:project-switch-progress", listener),
    getWindowChromeInsets: () => invoke<WindowChromeInsets>("get_window_chrome_insets"),
    getAppUpdateStatus: () => invoke<AppUpdateStatus>("get_app_update_status"),
    installAppUpdateNow: () => invoke<AppUpdateInstallResponse>("install_app_update_now"),
    getAppUpdateAutoDownload: () => invoke<boolean>("get_app_update_auto_download"),
    setAppUpdateAutoDownload: (enabled: boolean) => invoke<boolean>("set_app_update_auto_download", enabled),
    downloadAppUpdate: () => invoke<AppUpdateDownloadResponse>("download_app_update"),
    checkAppUpdate: () => invoke<AppUpdateCheckResponse>("check_app_update"),
    setShellUiTheme: (theme: ShellUiTheme) => invoke<void>("set_shell_ui_theme", theme),
    pickWorkspace: (request?: PickWorkspaceRequest) => invoke<PickWorkspaceResponse>("pick_workspace", request),
    machineMcpSubmitQuestionAnswer: (body: MachineMcpSubmitQuestionAnswerRequest) => invoke<MachineMcpSubmitQuestionAnswerResponse>("machine_mcp_submit_question_answer", body),
    agentQuestionSubmitAnswer: (body: AgentQuestionAnswerRequest) => invoke<QuestionAnswerResponse>("agent_question_submit_answer", body),
    sendPrompt: (request: PromptRequest) => invoke<SendPromptResponse>("send_prompt", request),
    cancelAgent: () => invoke<{ ok: boolean }>("cancel_agent"),
    getProviderSettings: () => invoke<ProviderSettings>("get_provider_settings"),
    getPythonRuntimeStatus: () => invoke<string | null>("get_python_runtime_status"),
    getPythonRuntimeProgress: () => invoke<PythonRuntimeProgress>("get_python_runtime_progress"),
    saveProviderSettings: (request: SaveProviderSettingsRequest) => invoke<ProviderSettings>("save_provider_settings", request),
    onAgentEvent: (listener: Listener<AgentEvent>) => subscribe("agent:events", listener),
    onMainProcessConsoleMirror: (listener: Listener<MainProcessConsoleMirrorPayload>) => subscribe("agent:main-process-console-mirror", listener),
    onWindowChromeInsets: (listener: Listener<WindowChromeInsets>) => subscribe("shell:window-chrome-insets-changed", listener),
    onAppUpdateStatus: (listener: Listener<AppUpdateStatus>) => subscribe("app:update-status-changed", listener),
    onSessionReset: (listener: () => void) => subscribeNoPayload("agent:session-reset", listener),
    onBootstrapStateChanged: (listener: Listener<BootstrapState>) => subscribe("agent:bootstrap-state-changed", listener),
    onPythonRuntimeStatus: (listener: Listener<string | null>) => subscribe("agent:python-runtime-status", listener),
    onPythonRuntimeProgress: (listener: Listener<PythonRuntimeProgress>) => subscribe("agent:python-runtime-progress", listener),
    sendEmulatorCommand: (command: EmulatorCommand) => invoke<{ ok: boolean }>("emulator_command", command),
    pickWidgetPath: () => invoke<{ path: string | null }>("emulator_pick_path"),
    getLastWidgetPath: () => invoke<{ path: string | null }>("emulator_get_last_path"),
    getEmulatorBackground: () => invoke<{ url: string | null }>("emulator_get_background"),
    openCaptureFolder: (folderPath: string) => invoke<void>("emulator_open_capture_folder", folderPath),
    onEmulatorState: (listener: Listener<EmulatorStateSnapshot>) => subscribe("emulator:state", listener),
    onEmulatorFrame: (listener: Listener<EmulatorFrame>) => subscribe("emulator:frame", listener),
    onEmulatorLog: (listener: Listener<EmulatorLogEntry>) => subscribe("emulator:log", listener),
    onEmulatorLogsClear: (listener: () => void) => subscribeNoPayload("emulator:logs-clear", listener),
    getWidgetConfig: (scope: WidgetConfigScope) => invoke<WidgetConfigSnapshot>("get_widget_config", scope),
    onWidgetConfig: (listener: Listener<WidgetConfigSnapshot>) => subscribe("widget-config:changed", listener),
    deployGetEligibility: () => invoke<DeployEligibility>("deploy_get_eligibility"),
    onDeployEligibility: (listener: Listener<DeployEligibility>) => subscribe("deploy:eligibility-changed", listener),
    deployConnect: (request: DeployConnectRequest) => invoke<DeployConnectResponse>("deploy_connect", request),
    onDeployConnectionChanged: (listener: Listener<DeployConnectionState>) => subscribe("deploy:connection-changed", listener),
    deployDisconnect: () => invoke<DeployActionResponse>("deploy_disconnect"),
    deployRun: (request?: DeployLaunchRequest) => invoke<DeployActionResponse>("deploy_run", request),
    deployReload: (request?: DeployLaunchRequest) => invoke<DeployActionResponse>("deploy_reload", request),
    deployApplyWidgetParams: (request: DeployLaunchRequest) => invoke<DeployActionResponse>("deploy_apply_widget_params", request),
    deployStop: () => invoke<DeployActionResponse>("deploy_stop"),
    deployOpenLocalNetworkSettings: () => invoke<DeployActionResponse>("deploy_open_local_network_settings"),
    onDeployLog: (listener: Listener<string>) => subscribe("deploy:log", listener),
    onDeployFrame: (listener: Listener<DeployFrameEvent>) => subscribe("deploy:frame", listener),
    communityGetSession: () => invoke<CommunitySessionInfo>("community_get_session"),
    communityLogin: (request: CommunityLoginRequest) => invoke<CommunityLoginResponse>("community_login", request),
    communitySetPassword: (request: CommunitySetPasswordRequest) => invoke<CommunitySetPasswordResponse>("community_set_password", request),
    communityCancelGoogleLogin: () => invoke<CommunityCancelGoogleLoginResponse>("community_cancel_google_login"),
    communityLogout: () => invoke<CommunityLogoutResponse>("community_logout"),
    communityGetLlmQuota: () => invoke<CommunityGetLlmQuotaResponse>("community_get_llm_quota"),
    communityListDeployDevices: () => invoke<CommunityListDeployDevicesResponse>("community_list_deploy_devices"),
    communityListMyGames: () => invoke<CommunityListMyGamesResponse>("community_list_my_games"),
    communityGetPublishOptions: () => invoke<CommunityGetPublishOptionsResponse>("community_get_publish_options"),
    communityListAppVersions: (request: CommunityListAppVersionsRequest) => invoke<CommunityListAppVersionsResponse>("community_list_app_versions", request),
    communityCreateApp: (request: CommunityCreateAppRequest) => invoke<CommunityCreateAppResponse>("community_create_app", request),
    communityUploadNativeImage: (request: CommunityUploadNativeImageRequest) => invoke<CommunityUploadNativeImageResponse>("community_upload_native_image", request),
    communitySubmitAppVersion: (request: CommunitySubmitAppVersionRequest) => invoke<CommunitySubmitAppVersionResponse>("community_submit_app_version", request),
    communityUpdateWorkspaceVersion: (request: CommunityUpdateWorkspaceVersionRequest) => invoke<CommunityUpdateWorkspaceVersionResponse>("community_update_workspace_version", request),
    onCommunitySubmitProgress: (listener: Listener<CommunitySubmitProgress>) => subscribe("community:submit-progress", listener),
    communityWithdrawAppVersion: (request: CommunityWithdrawAppVersionRequest) => invoke<CommunityWithdrawAppVersionResponse>("community_withdraw_app_version", request),
    assets: {
      getManifest: (workspacePath: string) => invoke<ManifestSnapshot>("assets_get_manifest", workspacePath),
      onManifest: (listener: Listener<ManifestSnapshot>) => subscribe("assets:manifest", listener),
      bindSlot: (request: BindSlotRequest) => invoke<BindSlotResponse>("assets_bind_slot", request),
      unbindSlot: (request: UnbindSlotRequest) => invoke<UnbindSlotResponse>("assets_unbind_slot", request),
      applyAssets: (request: ApplyAssetsRequest) => invoke<ApplyAssetsResponse>("assets_apply_assets", request),
      readPreview: (request: ReadPreviewRequest) => invoke<ReadPreviewResponse>("assets_read_preview", request),
      pickSourceFile: () => invoke<{ ok: true; path: string } | { ok: false; reason: "cancelled" }>("assets_pick_source_file"),
      getPathForFile: (file: File) => {
        const nativePath = (file as File & { path?: string }).path;
        if (nativePath) return nativePath;
        return nativeDroppedPaths.get(file.name) ?? "";
      }
    }
  } satisfies NonNullable<Window["dartsnutApi"]> & TauriBridgeApi;
  return api;
}

export function installTauriApi(): void {
  if (typeof window === "undefined" || window.dartsnutApi) return;
  window.dartsnutApi = createTauriApi();
}
