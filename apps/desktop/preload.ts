import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IPCChannels,
  type AgentEvent,
  type MainProcessConsoleMirrorPayload,
  type ApplyAssetsRequest,
  type ApplyAssetsResponse,
  type BindSlotRequest,
  type BindSlotResponse,
  type BootstrapState,
  type SaveTempWorkspaceResponse,
  type ManifestSnapshot,
  type PickWorkspaceRequest,
  type PickWorkspaceResponse,
  type IntakeSubmitQuestionAnswerRequest,
  type IntakeSubmitQuestionAnswerResponse,
  type PromptRequest,
  type ProviderSettings,
  type ReadPreviewRequest,
  type ReadPreviewResponse,
  type SaveProviderSettingsRequest,
  type SendPromptResponse,
  type UnbindSlotRequest,
  type UnbindSlotResponse,
  type DeployConnectRequest,
  type DeployConnectResponse,
  type DeployEligibility,
  type DeployActionResponse,
  type DeployLocalNetworkPermissionResponse,
  type DeployLaunchRequest,
  type CommunitySessionInfo,
  type CommunityLoginRequest,
  type CommunityLoginResponse,
  type CommunityLogoutResponse,
  type CommunityListDeployDevicesResponse,
  type WindowChromeInsets,
  type ShellUiTheme,
  type AgentSessionWorkspaceSummary
} from "@dartsnut/shared-ipc";
import {
  EMULATOR_IPC_CHANNELS,
  type EmulatorCommand,
  type EmulatorFrame,
  type EmulatorLogEntry,
  type EmulatorStateSnapshot,
} from "@dartsnut/emulator-protocol";

const api = {
  getBootstrapState: () => ipcRenderer.invoke(IPCChannels.bootstrapState) as Promise<BootstrapState>,
  getWorkspaceSessionSummary: () =>
    ipcRenderer.invoke(IPCChannels.getWorkspaceSessionSummary) as Promise<AgentSessionWorkspaceSummary>,
  resetWorkspaceSession: () =>
    ipcRenderer.invoke(IPCChannels.resetWorkspaceSession) as Promise<
      { ok: true } | { ok: false; reason: "no_workspace" | "persistence_disabled" }
    >,
  getWindowChromeInsets: () =>
    ipcRenderer.invoke(IPCChannels.windowChromeInsets) as Promise<WindowChromeInsets>,
  setShellUiTheme: (theme: ShellUiTheme) =>
    ipcRenderer.invoke(IPCChannels.shellUiTheme, theme) as Promise<void>,
  startNewProject: () => ipcRenderer.invoke(IPCChannels.startNewProject) as Promise<BootstrapState>,
  saveTempWorkspace: () =>
    ipcRenderer.invoke(IPCChannels.saveTempWorkspace) as Promise<SaveTempWorkspaceResponse>,
  pickWorkspace: (request?: PickWorkspaceRequest) =>
    ipcRenderer.invoke(IPCChannels.pickWorkspace, request) as Promise<PickWorkspaceResponse>,
  intakeSubmitQuestionAnswer: (body: IntakeSubmitQuestionAnswerRequest) =>
    ipcRenderer.invoke(IPCChannels.intakeSubmitQuestionAnswer, body) as Promise<IntakeSubmitQuestionAnswerResponse>,
  sendPrompt: (request: PromptRequest) =>
    ipcRenderer.invoke(IPCChannels.sendPrompt, request) as Promise<SendPromptResponse>,
  cancelAgent: () => ipcRenderer.invoke(IPCChannels.cancelAgent) as Promise<{ ok: boolean }>,
  getProviderSettings: () =>
    ipcRenderer.invoke(IPCChannels.getProviderSettings) as Promise<ProviderSettings>,
  getPythonRuntimeStatus: () =>
    ipcRenderer.invoke(IPCChannels.getPythonRuntimeStatus) as Promise<string | null>,
  saveProviderSettings: (request: SaveProviderSettingsRequest) =>
    ipcRenderer.invoke(IPCChannels.saveProviderSettings, request) as Promise<ProviderSettings>,
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_: unknown, event: AgentEvent) => listener(event);
    ipcRenderer.on(IPCChannels.subscribeEvents, handler);
    return () => ipcRenderer.removeListener(IPCChannels.subscribeEvents, handler);
  },
  onMainProcessConsoleMirror: (listener: (payload: MainProcessConsoleMirrorPayload) => void) => {
    const handler = (_: unknown, payload: MainProcessConsoleMirrorPayload) => listener(payload);
    ipcRenderer.on(IPCChannels.mainProcessConsoleMirror, handler);
    return () => ipcRenderer.removeListener(IPCChannels.mainProcessConsoleMirror, handler);
  },
  onWindowChromeInsets: (listener: (insets: WindowChromeInsets) => void) => {
    const handler = (_: unknown, insets: WindowChromeInsets) => listener(insets);
    ipcRenderer.on(IPCChannels.windowChromeInsetsChanged, handler);
    return () => ipcRenderer.removeListener(IPCChannels.windowChromeInsetsChanged, handler);
  },
  onSessionReset: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(IPCChannels.sessionReset, handler);
    return () => ipcRenderer.removeListener(IPCChannels.sessionReset, handler);
  },
  onBootstrapStateChanged: (listener: (state: BootstrapState) => void) => {
    const handler = (_: unknown, state: BootstrapState) => listener(state);
    ipcRenderer.on(IPCChannels.bootstrapStateChanged, handler);
    return () => ipcRenderer.removeListener(IPCChannels.bootstrapStateChanged, handler);
  },
  onPythonRuntimeStatus: (listener: (status: string | null) => void) => {
    const handler = (_: unknown, status: string | null) => listener(status);
    ipcRenderer.on(IPCChannels.subscribePythonRuntimeStatus, handler);
    return () => ipcRenderer.removeListener(IPCChannels.subscribePythonRuntimeStatus, handler);
  },
  sendEmulatorCommand: (command: EmulatorCommand) =>
    ipcRenderer.invoke(EMULATOR_IPC_CHANNELS.emulatorCommand, command) as Promise<{ ok: boolean }>,
  pickWidgetPath: () =>
    ipcRenderer.invoke(EMULATOR_IPC_CHANNELS.emulatorPickPath) as Promise<{ path: string | null }>,
  getLastWidgetPath: () =>
    ipcRenderer.invoke(EMULATOR_IPC_CHANNELS.emulatorGetLastPath) as Promise<{ path: string | null }>,
  getEmulatorBackground: () =>
    ipcRenderer.invoke(EMULATOR_IPC_CHANNELS.emulatorGetBackground) as Promise<{ url: string | null }>,
  onEmulatorState: (listener: (state: EmulatorStateSnapshot) => void) => {
    const handler = (_: unknown, payload: EmulatorStateSnapshot) => listener(payload);
    ipcRenderer.on(EMULATOR_IPC_CHANNELS.emulatorState, handler);
    return () => ipcRenderer.removeListener(EMULATOR_IPC_CHANNELS.emulatorState, handler);
  },
  onEmulatorFrame: (listener: (frame: EmulatorFrame) => void) => {
    const handler = (_: unknown, payload: EmulatorFrame) => listener(payload);
    ipcRenderer.on(EMULATOR_IPC_CHANNELS.emulatorFrame, handler);
    return () => ipcRenderer.removeListener(EMULATOR_IPC_CHANNELS.emulatorFrame, handler);
  },
  onEmulatorLog: (listener: (entry: EmulatorLogEntry) => void) => {
    const handler = (_: unknown, payload: EmulatorLogEntry) => listener(payload);
    ipcRenderer.on(EMULATOR_IPC_CHANNELS.emulatorLog, handler);
    return () => ipcRenderer.removeListener(EMULATOR_IPC_CHANNELS.emulatorLog, handler);
  },
  onEmulatorLogsClear: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(EMULATOR_IPC_CHANNELS.emulatorLogsClear, handler);
    return () => ipcRenderer.removeListener(EMULATOR_IPC_CHANNELS.emulatorLogsClear, handler);
  },
  deployGetEligibility: () =>
    ipcRenderer.invoke(IPCChannels.deployGetEligibility) as Promise<DeployEligibility>,
  onDeployEligibility: (listener: (eligibility: DeployEligibility) => void) => {
    const handler = (_: unknown, eligibility: DeployEligibility) => listener(eligibility);
    ipcRenderer.on(IPCChannels.deployEligibilityChanged, handler);
    return () => ipcRenderer.removeListener(IPCChannels.deployEligibilityChanged, handler);
  },
  deployConnect: (request: DeployConnectRequest) =>
    ipcRenderer.invoke(IPCChannels.deployConnect, request) as Promise<DeployConnectResponse>,
  deployDisconnect: () =>
    ipcRenderer.invoke(IPCChannels.deployDisconnect) as Promise<DeployActionResponse>,
  deployRun: (request?: DeployLaunchRequest) =>
    ipcRenderer.invoke(IPCChannels.deployRun, request) as Promise<DeployActionResponse>,
  deployReload: (request?: DeployLaunchRequest) =>
    ipcRenderer.invoke(IPCChannels.deployReload, request) as Promise<DeployActionResponse>,
  deployStop: () => ipcRenderer.invoke(IPCChannels.deployStop) as Promise<DeployActionResponse>,
  deployCheckLocalNetworkPermission: () =>
    ipcRenderer.invoke(IPCChannels.deployCheckLocalNetworkPermission) as Promise<DeployLocalNetworkPermissionResponse>,
  deployOpenLocalNetworkSettings: () =>
    ipcRenderer.invoke(IPCChannels.deployOpenLocalNetworkSettings) as Promise<DeployActionResponse>,
  onDeployLog: (listener: (line: string) => void) => {
    const handler = (_: unknown, line: string) => listener(line);
    ipcRenderer.on(IPCChannels.deployLog, handler);
    return () => ipcRenderer.removeListener(IPCChannels.deployLog, handler);
  },
  communityGetSession: () =>
    ipcRenderer.invoke(IPCChannels.communityGetSession) as Promise<CommunitySessionInfo>,
  communityLogin: (request: CommunityLoginRequest) =>
    ipcRenderer.invoke(IPCChannels.communityLogin, request) as Promise<CommunityLoginResponse>,
  communityLogout: () =>
    ipcRenderer.invoke(IPCChannels.communityLogout) as Promise<CommunityLogoutResponse>,
  communityListDeployDevices: () =>
    ipcRenderer.invoke(IPCChannels.communityListDeployDevices) as Promise<CommunityListDeployDevicesResponse>,
  assets: {
    getManifest: (workspacePath: string) =>
      ipcRenderer.invoke(IPCChannels.assetsGetManifest, workspacePath) as Promise<ManifestSnapshot>,
    onManifest: (listener: (snapshot: ManifestSnapshot) => void) => {
      const handler = (_: unknown, snapshot: ManifestSnapshot) => listener(snapshot);
      ipcRenderer.on(IPCChannels.assetsSubscribeManifest, handler);
      return () => ipcRenderer.removeListener(IPCChannels.assetsSubscribeManifest, handler);
    },
    bindSlot: (request: BindSlotRequest) =>
      ipcRenderer.invoke(IPCChannels.assetsBindSlot, request) as Promise<BindSlotResponse>,
    unbindSlot: (request: UnbindSlotRequest) =>
      ipcRenderer.invoke(IPCChannels.assetsUnbindSlot, request) as Promise<UnbindSlotResponse>,
    applyAssets: (request: ApplyAssetsRequest) =>
      ipcRenderer.invoke(IPCChannels.assetsApplyAssets, request) as Promise<ApplyAssetsResponse>,
    readPreview: (request: ReadPreviewRequest) =>
      ipcRenderer.invoke(IPCChannels.assetsReadPreview, request) as Promise<ReadPreviewResponse>,
    /**
     * Resolve a renderer-side `File` (from a file input or drop event) to its
     * absolute filesystem path. `File.path` was removed in Electron 32+, so we
     * route through `webUtils.getPathForFile` exposed via the bridge.
     */
    getPathForFile: (file: File) => webUtils.getPathForFile(file)
  }
};

contextBridge.exposeInMainWorld("dartsnutApi", api);
