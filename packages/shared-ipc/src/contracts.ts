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
  projectType?: ProjectType;
  widgetSize?: WidgetSize;
  workspacePath?: string;
  templateMode?: "game-creator" | "widget-creator";
}

export type ProjectType = "game" | "widget";

export type WidgetSize = "128x160" | "128x128" | "128x64" | "64x32";

export interface PickWorkspaceRequest {
  requireEmpty?: boolean;
}

export interface PickWorkspaceResponse {
  state: BootstrapState;
  selectedPath: string | null;
  accepted: boolean;
  reason?: "cancelled" | "non_empty";
}

export type AgentEvent =
  | {
      type: "stream";
      delta: string;
      at: number;
    }
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
