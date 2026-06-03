import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";
import type { WorkspacePolicy } from "./workspacePolicy";
import type { AgentSkillLibrary } from "./sessionEngine";

export type HostIntakeToolHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostAskQuestionHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostReloadEmulatorHandler = () => Promise<string>;
export type HostGetEmulatorLogsHandler = (args: { max_lines?: number }) => Promise<string>;

export type AgentToolsOptions = {
  workspacePolicy: WorkspacePolicy;
  skillLibrary?: AgentSkillLibrary;
  assetRoots?: {
    widgetFonts?: string;
  };
  completionTools?: ChatCompletionTool[];
  hostIntakeToolHandler?: HostIntakeToolHandler;
  hostAskQuestionHandler?: HostAskQuestionHandler;
  hostReloadEmulatorHandler?: HostReloadEmulatorHandler;
  hostGetEmulatorLogsHandler?: HostGetEmulatorLogsHandler;
};
