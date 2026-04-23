export const IPCChannels = {
  bootstrapState: "agent:bootstrap-state",
  pickWorkspace: "agent:pick-workspace",
  sendPrompt: "agent:send-prompt",
  subscribeEvents: "agent:subscribe-events"
} as const;

export type ProviderStatus = "ready" | "missing_config" | "invalid";

export interface BootstrapState {
  workspaceRoot: string | null;
  providerStatus: ProviderStatus;
  firstRunComplete: boolean;
}

export interface PromptRequest {
  prompt: string;
}

export type AgentEvent =
  | {
      type: "status";
      message: string;
      at: number;
    }
  | {
      type: "error";
      message: string;
      at: number;
    }
  | {
      type: "final";
      content: string;
      at: number;
    };
