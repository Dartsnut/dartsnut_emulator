import type {
  AgentEvent,
  BootstrapState,
  PickWorkspaceRequest,
  PickWorkspaceResponse,
  PromptRequest,
  ProviderSettings,
  SaveProviderSettingsRequest
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
      pickWorkspace: (request?: PickWorkspaceRequest) => Promise<PickWorkspaceResponse>;
      sendPrompt: (request: PromptRequest) => Promise<{ ok: boolean; events: AgentEvent[] }>;
      getProviderSettings: () => Promise<ProviderSettings>;
      getPythonRuntimeStatus: () => Promise<string | null>;
      getSelectedPythonPath: () => Promise<string | null>;
      pickPythonPath: () => Promise<{ accepted: boolean; selectedPath: string | null; error?: string }>;
      saveProviderSettings: (request: SaveProviderSettingsRequest) => Promise<ProviderSettings>;
      onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
      onPythonRuntimeStatus: (listener: (status: string | null) => void) => () => void;
      sendEmulatorCommand: (command: EmulatorCommand) => Promise<{ ok: boolean }>;
      pickWidgetPath: () => Promise<{ path: string | null }>;
      getLastWidgetPath: () => Promise<{ path: string | null }>;
      getEmulatorBackground: () => Promise<{ url: string | null }>;
      onEmulatorState: (listener: (state: EmulatorStateSnapshot) => void) => () => void;
      onEmulatorFrame: (listener: (frame: EmulatorFrame) => void) => () => void;
      onEmulatorLog: (listener: (entry: EmulatorLogEntry) => void) => () => void;
    };
  }
}

export { };
