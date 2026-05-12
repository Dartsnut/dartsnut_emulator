import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IPCChannels,
  type AgentEvent,
  type ApplyAssetsRequest,
  type ApplyAssetsResponse,
  type BindSlotRequest,
  type BindSlotResponse,
  type BootstrapState,
  type ManifestSnapshot,
  type PickWorkspaceRequest,
  type PickWorkspaceResponse,
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
  type DeployLaunchRequest,
  type WindowChromeInsets,
  type ShellUiTheme
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
  getWindowChromeInsets: () =>
    ipcRenderer.invoke(IPCChannels.windowChromeInsets) as Promise<WindowChromeInsets>,
  setShellUiTheme: (theme: ShellUiTheme) =>
    ipcRenderer.invoke(IPCChannels.shellUiTheme, theme) as Promise<void>,
  startNewProject: () => ipcRenderer.invoke(IPCChannels.startNewProject) as Promise<BootstrapState>,
  pickWorkspace: (request?: PickWorkspaceRequest) =>
    ipcRenderer.invoke(IPCChannels.pickWorkspace, request) as Promise<PickWorkspaceResponse>,
  sendPrompt: (request: PromptRequest) =>
    ipcRenderer.invoke(IPCChannels.sendPrompt, request) as Promise<SendPromptResponse>,
  cancelAgent: () => ipcRenderer.invoke(IPCChannels.cancelAgent) as Promise<{ ok: boolean }>,
  getProviderSettings: () =>
    ipcRenderer.invoke(IPCChannels.getProviderSettings) as Promise<ProviderSettings>,
  getPythonRuntimeStatus: () =>
    ipcRenderer.invoke(IPCChannels.getPythonRuntimeStatus) as Promise<string | null>,
  getSelectedPythonPath: () =>
    ipcRenderer.invoke(IPCChannels.getSelectedPythonPath) as Promise<string | null>,
  pickPythonPath: () =>
    ipcRenderer.invoke(IPCChannels.pickPythonPath) as Promise<{
      accepted: boolean;
      selectedPath: string | null;
      error?: string;
    }>,
  saveProviderSettings: (request: SaveProviderSettingsRequest) =>
    ipcRenderer.invoke(IPCChannels.saveProviderSettings, request) as Promise<ProviderSettings>,
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_: unknown, event: AgentEvent) => listener(event);
    ipcRenderer.on(IPCChannels.subscribeEvents, handler);
    return () => ipcRenderer.removeListener(IPCChannels.subscribeEvents, handler);
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
  onDeployLog: (listener: (line: string) => void) => {
    const handler = (_: unknown, line: string) => listener(line);
    ipcRenderer.on(IPCChannels.deployLog, handler);
    return () => ipcRenderer.removeListener(IPCChannels.deployLog, handler);
  },
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
