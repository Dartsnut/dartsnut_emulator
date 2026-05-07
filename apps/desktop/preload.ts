import { contextBridge, ipcRenderer } from "electron";
import {
  IPCChannels,
  type AgentEvent,
  type BootstrapState,
  type PickWorkspaceRequest,
  type PickWorkspaceResponse,
  type PromptRequest,
  type ProviderSettings,
  type SaveProviderSettingsRequest
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
  pickWorkspace: (request?: PickWorkspaceRequest) =>
    ipcRenderer.invoke(IPCChannels.pickWorkspace, request) as Promise<PickWorkspaceResponse>,
  sendPrompt: (request: PromptRequest) =>
    ipcRenderer.invoke(IPCChannels.sendPrompt, request) as Promise<{
      ok: boolean;
      events: AgentEvent[];
    }>,
  getProviderSettings: () =>
    ipcRenderer.invoke(IPCChannels.getProviderSettings) as Promise<ProviderSettings>,
  saveProviderSettings: (request: SaveProviderSettingsRequest) =>
    ipcRenderer.invoke(IPCChannels.saveProviderSettings, request) as Promise<ProviderSettings>,
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_: unknown, event: AgentEvent) => listener(event);
    ipcRenderer.on(IPCChannels.subscribeEvents, handler);
    return () => ipcRenderer.removeListener(IPCChannels.subscribeEvents, handler);
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
};

contextBridge.exposeInMainWorld("dartsnutApi", api);
