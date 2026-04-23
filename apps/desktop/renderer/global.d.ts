import type { AgentEvent, BootstrapState } from "@dartsnut/shared-ipc";
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
      pickWorkspace: () => Promise<BootstrapState>;
      sendPrompt: (prompt: string) => Promise<{ ok: boolean; events: AgentEvent[] }>;
      onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
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

export {};
