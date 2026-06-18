import type {
  AgentEvent,
  AgentSessionWorkspaceSummary,
  ApplyAssetsRequest,
  ApplyAssetsResponse,
  BindSlotRequest,
  BindSlotResponse,
  BootstrapState,
  ManifestSnapshot,
  PickWorkspaceRequest,
  PickWorkspaceResponse,
  IntakeSubmitQuestionAnswerRequest,
  IntakeSubmitQuestionAnswerResponse,
  PromptRequest,
  ProviderSettings,
  PythonRuntimeProgress,
  ReadPreviewRequest,
  ReadPreviewResponse,
  SaveProviderSettingsRequest,
  SendPromptResponse,
  SaveTempWorkspaceResponse,
  UnbindSlotRequest,
  UnbindSlotResponse,
  DeployConnectRequest,
  DeployConnectResponse,
  DeployEligibility,
  DeployActionResponse,
  DeployLaunchRequest,
  CommunitySessionInfo,
  CommunityLoginRequest,
  CommunityLoginResponse,
  CommunityLogoutResponse,
  CommunityListDeployDevicesResponse,
  WindowChromeInsets,
  type ShellUiTheme,
  type MainProcessConsoleMirrorPayload
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
      resetWorkspaceSession: () => Promise<
        { ok: true } | { ok: false; reason: "no_workspace" | "persistence_disabled" }
      >;
      getWindowChromeInsets: () => Promise<WindowChromeInsets>;
      setShellUiTheme: (theme: ShellUiTheme) => Promise<void>;
      startNewProject: () => Promise<BootstrapState>;
      saveTempWorkspace: () => Promise<SaveTempWorkspaceResponse>;
      pickWorkspace: (request?: PickWorkspaceRequest) => Promise<PickWorkspaceResponse>;
      intakeSubmitQuestionAnswer: (
        body: IntakeSubmitQuestionAnswerRequest
      ) => Promise<IntakeSubmitQuestionAnswerResponse>;
      sendPrompt: (request: PromptRequest) => Promise<SendPromptResponse>;
      cancelAgent: () => Promise<{ ok: boolean }>;
      getProviderSettings: () => Promise<ProviderSettings>;
      getPythonRuntimeStatus: () => Promise<string | null>;
      getPythonRuntimeProgress: () => Promise<PythonRuntimeProgress>;
      saveProviderSettings: (request: SaveProviderSettingsRequest) => Promise<ProviderSettings>;
      onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
      onMainProcessConsoleMirror: (listener: (payload: MainProcessConsoleMirrorPayload) => void) => () => void;
      onWindowChromeInsets: (listener: (insets: WindowChromeInsets) => void) => () => void;
      onSessionReset: (listener: () => void) => () => void;
      onBootstrapStateChanged: (listener: (state: BootstrapState) => void) => () => void;
      onPythonRuntimeStatus: (listener: (status: string | null) => void) => () => void;
      onPythonRuntimeProgress: (listener: (progress: PythonRuntimeProgress) => void) => () => void;
      sendEmulatorCommand: (command: EmulatorCommand) => Promise<{ ok: boolean }>;
      pickWidgetPath: () => Promise<{ path: string | null }>;
      getLastWidgetPath: () => Promise<{ path: string | null }>;
      getEmulatorBackground: () => Promise<{ url: string | null }>;
      onEmulatorState: (listener: (state: EmulatorStateSnapshot) => void) => () => void;
      onEmulatorFrame: (listener: (frame: EmulatorFrame) => void) => () => void;
      onEmulatorLog: (listener: (entry: EmulatorLogEntry) => void) => () => void;
      onEmulatorLogsClear: (listener: () => void) => () => void;
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
      communityLogout: () => Promise<CommunityLogoutResponse>;
      communityListDeployDevices: () => Promise<CommunityListDeployDevicesResponse>;
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
