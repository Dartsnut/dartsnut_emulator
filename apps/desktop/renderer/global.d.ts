import type {
  AgentEvent,
  ApplyAssetsRequest,
  ApplyAssetsResponse,
  BindSlotRequest,
  BindSlotResponse,
  BootstrapState,
  ManifestSnapshot,
  PickWorkspaceRequest,
  PickWorkspaceResponse,
  PromptRequest,
  ProviderSettings,
  ReadPreviewRequest,
  ReadPreviewResponse,
  SaveProviderSettingsRequest,
  UnbindSlotRequest,
  UnbindSlotResponse,
  WindowChromeInsets
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
      getWindowChromeInsets: () => Promise<WindowChromeInsets>;
      startNewProject: () => Promise<BootstrapState>;
      pickWorkspace: (request?: PickWorkspaceRequest) => Promise<PickWorkspaceResponse>;
      sendPrompt: (request: PromptRequest) => Promise<{ ok: boolean }>;
      getProviderSettings: () => Promise<ProviderSettings>;
      getPythonRuntimeStatus: () => Promise<string | null>;
      getSelectedPythonPath: () => Promise<string | null>;
      pickPythonPath: () => Promise<{ accepted: boolean; selectedPath: string | null; error?: string }>;
      saveProviderSettings: (request: SaveProviderSettingsRequest) => Promise<ProviderSettings>;
      onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
      onWindowChromeInsets: (listener: (insets: WindowChromeInsets) => void) => () => void;
      onSessionReset: (listener: () => void) => () => void;
      onPythonRuntimeStatus: (listener: (status: string | null) => void) => () => void;
      sendEmulatorCommand: (command: EmulatorCommand) => Promise<{ ok: boolean }>;
      pickWidgetPath: () => Promise<{ path: string | null }>;
      getLastWidgetPath: () => Promise<{ path: string | null }>;
      getEmulatorBackground: () => Promise<{ url: string | null }>;
      onEmulatorState: (listener: (state: EmulatorStateSnapshot) => void) => () => void;
      onEmulatorFrame: (listener: (frame: EmulatorFrame) => void) => () => void;
      onEmulatorLog: (listener: (entry: EmulatorLogEntry) => void) => () => void;
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
