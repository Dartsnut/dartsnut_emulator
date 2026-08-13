import type {
  AgentEvent,
  AgentSessionWorkspaceSummary,
  AppUpdateInstallResponse,
  AppUpdateDownloadResponse,
  AppUpdateCheckResponse,
  AppUpdateStatus,
  ApplyAssetsRequest,
  ApplyAssetsResponse,
  BindSlotRequest,
  BindSlotResponse,
  BootstrapState,
  ProjectTree,
  ProjectCreateRequest,
  ProjectSelectRequest,
  ProjectSwitchProgress,
  ManifestSnapshot,
  PickWorkspaceRequest,
  PickWorkspaceResponse,
  MachineMcpSubmitQuestionAnswerRequest,
  MachineMcpSubmitQuestionAnswerResponse,
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
  DeployEligibility,
  DeployActionResponse,
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
  type ShellUiTheme,
  type MainProcessConsoleMirrorPayload,
  type WidgetConfigScope,
  type WidgetConfigSnapshot
} from "@dartsnut/shared-ipc";
import type {
  EmulatorCommand,
  EmulatorFrame,
  EmulatorLogEntry,
  EmulatorStateSnapshot,
} from "@dartsnut/emulator-protocol";

declare global {
  interface Window {
    dartsnutApi: {
      getBootstrapState: () => Promise<BootstrapState>;
      getWorkspaceSessionSummary: () => Promise<AgentSessionWorkspaceSummary>;
      listProjects: () => Promise<ProjectTree>;
      createProject: (request: ProjectCreateRequest) => Promise<{ state: BootstrapState; tree: ProjectTree }>;
      selectProject: (request: ProjectSelectRequest) => Promise<{ state: BootstrapState; tree: ProjectTree; accepted: boolean }>;
      archiveChat: (chatId: string) => Promise<{ state: BootstrapState; tree: ProjectTree }>;
      generateChatTitle: (request: { chatId: string; firstUserMessage: string }) => Promise<{ tree: ProjectTree; updated: boolean }>;
      selectChat: (chatId: string) => Promise<{ state: BootstrapState; tree: ProjectTree }>;
      onProjectSwitchProgress: (listener: (progress: ProjectSwitchProgress) => void) => () => void;
      resetWorkspaceSession: () => Promise<
        { ok: true } | { ok: false; reason: "no_workspace" | "persistence_disabled" }
      >;
      getWindowChromeInsets: () => Promise<WindowChromeInsets>;
      getAppUpdateStatus: () => Promise<AppUpdateStatus>;
      installAppUpdateNow: () => Promise<AppUpdateInstallResponse>;
      getAppUpdateAutoDownload: () => Promise<boolean>;
      setAppUpdateAutoDownload: (enabled: boolean) => Promise<boolean>;
      downloadAppUpdate: () => Promise<AppUpdateDownloadResponse>;
      checkAppUpdate: () => Promise<AppUpdateCheckResponse>;
      setShellUiTheme: (theme: ShellUiTheme) => Promise<void>;
      pickWorkspace: (request?: PickWorkspaceRequest) => Promise<PickWorkspaceResponse>;
      machineMcpSubmitQuestionAnswer: (
        body: MachineMcpSubmitQuestionAnswerRequest
      ) => Promise<MachineMcpSubmitQuestionAnswerResponse>;
      sendPrompt: (request: PromptRequest) => Promise<SendPromptResponse>;
      cancelAgent: () => Promise<{ ok: boolean }>;
      getProviderSettings: () => Promise<ProviderSettings>;
      getPythonRuntimeStatus: () => Promise<string | null>;
      getPythonRuntimeProgress: () => Promise<PythonRuntimeProgress>;
      saveProviderSettings: (request: SaveProviderSettingsRequest) => Promise<ProviderSettings>;
      onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
      onMainProcessConsoleMirror: (listener: (payload: MainProcessConsoleMirrorPayload) => void) => () => void;
      onWindowChromeInsets: (listener: (insets: WindowChromeInsets) => void) => () => void;
      onAppUpdateStatus: (listener: (status: AppUpdateStatus) => void) => () => void;
      onSessionReset: (listener: () => void) => () => void;
      onBootstrapStateChanged: (listener: (state: BootstrapState) => void) => () => void;
      onPythonRuntimeStatus: (listener: (status: string | null) => void) => () => void;
      onPythonRuntimeProgress: (listener: (progress: PythonRuntimeProgress) => void) => () => void;
      sendEmulatorCommand: (command: EmulatorCommand) => Promise<{ ok: boolean }>;
      pickWidgetPath: () => Promise<{ path: string | null }>;
      getLastWidgetPath: () => Promise<{ path: string | null }>;
      getEmulatorBackground: () => Promise<{ url: string | null }>;
      openCaptureFolder: (folderPath: string) => Promise<void>;
      onEmulatorState: (listener: (state: EmulatorStateSnapshot) => void) => () => void;
      onEmulatorFrame: (listener: (frame: EmulatorFrame) => void) => () => void;
      onEmulatorLog: (listener: (entry: EmulatorLogEntry) => void) => () => void;
      onEmulatorLogsClear: (listener: () => void) => () => void;
      getWidgetConfig: (scope: WidgetConfigScope) => Promise<WidgetConfigSnapshot>;
      onWidgetConfig: (listener: (snapshot: WidgetConfigSnapshot) => void) => () => void;
      deployGetEligibility: () => Promise<DeployEligibility>;
      onDeployEligibility: (listener: (eligibility: DeployEligibility) => void) => () => void;
      deployConnect: (request: DeployConnectRequest) => Promise<DeployConnectResponse>;
      deployDisconnect: () => Promise<DeployActionResponse>;
      deployRun: (request?: DeployLaunchRequest) => Promise<DeployActionResponse>;
      deployReload: (request?: DeployLaunchRequest) => Promise<DeployActionResponse>;
      deployStop: () => Promise<DeployActionResponse>;
      deployOpenLocalNetworkSettings: () => Promise<DeployActionResponse>;
      onDeployLog: (listener: (line: string) => void) => () => void;
      communityGetSession: () => Promise<CommunitySessionInfo>;
      communityLogin: (request: CommunityLoginRequest) => Promise<CommunityLoginResponse>;
      communitySetPassword: (request: CommunitySetPasswordRequest) => Promise<CommunitySetPasswordResponse>;
      communityCancelGoogleLogin: () => Promise<CommunityCancelGoogleLoginResponse>;
      communityLogout: () => Promise<CommunityLogoutResponse>;
      communityGetLlmQuota: () => Promise<CommunityGetLlmQuotaResponse>;
      communityListDeployDevices: () => Promise<CommunityListDeployDevicesResponse>;
      communityListMyGames: () => Promise<CommunityListMyGamesResponse>;
      communityGetPublishOptions: () => Promise<CommunityGetPublishOptionsResponse>;
      communityListAppVersions: (
        request: CommunityListAppVersionsRequest
      ) => Promise<CommunityListAppVersionsResponse>;
      communityCreateApp: (request: CommunityCreateAppRequest) => Promise<CommunityCreateAppResponse>;
      communityUploadNativeImage: (
        request: CommunityUploadNativeImageRequest
      ) => Promise<CommunityUploadNativeImageResponse>;
      communitySubmitAppVersion: (
        request: CommunitySubmitAppVersionRequest
      ) => Promise<CommunitySubmitAppVersionResponse>;
      communityUpdateWorkspaceVersion: (
        request: CommunityUpdateWorkspaceVersionRequest
      ) => Promise<CommunityUpdateWorkspaceVersionResponse>;
      onCommunitySubmitProgress: (listener: (progress: CommunitySubmitProgress) => void) => () => void;
      communityWithdrawAppVersion: (
        request: CommunityWithdrawAppVersionRequest
      ) => Promise<CommunityWithdrawAppVersionResponse>;
      assets: {
        getManifest: (workspacePath: string) => Promise<ManifestSnapshot>;
        onManifest: (listener: (snapshot: ManifestSnapshot) => void) => () => void;
        bindSlot: (request: BindSlotRequest) => Promise<BindSlotResponse>;
        unbindSlot: (request: UnbindSlotRequest) => Promise<UnbindSlotResponse>;
        applyAssets: (request: ApplyAssetsRequest) => Promise<ApplyAssetsResponse>;
        readPreview: (request: ReadPreviewRequest) => Promise<ReadPreviewResponse>;
        getPathForFile: (file: File) => string;
      };
    };
  }
}

export { };
