import type { AgentEvent, BootstrapState } from "@dartsnut/shared-ipc";

declare global {
  interface Window {
    dartsnutApi: {
      getBootstrapState: () => Promise<BootstrapState>;
      pickWorkspace: () => Promise<BootstrapState>;
      sendPrompt: (prompt: string) => Promise<{ ok: boolean; events: AgentEvent[] }>;
      onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
    };
  }
}

export {};
