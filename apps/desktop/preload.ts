import { contextBridge, ipcRenderer } from "electron";
import { IPCChannels, type AgentEvent, type BootstrapState } from "@dartsnut/shared-ipc";

const api = {
  getBootstrapState: () => ipcRenderer.invoke(IPCChannels.bootstrapState) as Promise<BootstrapState>,
  pickWorkspace: () => ipcRenderer.invoke(IPCChannels.pickWorkspace) as Promise<BootstrapState>,
  sendPrompt: (prompt: string) =>
    ipcRenderer.invoke(IPCChannels.sendPrompt, { prompt }) as Promise<{
      ok: boolean;
      events: AgentEvent[];
    }>,
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_: unknown, event: AgentEvent) => listener(event);
    ipcRenderer.on(IPCChannels.subscribeEvents, handler);
    return () => ipcRenderer.removeListener(IPCChannels.subscribeEvents, handler);
  }
};

contextBridge.exposeInMainWorld("dartsnutApi", api);
