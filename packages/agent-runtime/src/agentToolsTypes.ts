import type { AgentQuestionPrompt, ChatMediaAttachment } from "@dartsnut/shared-ipc";
import type { WorkspacePolicy } from "./workspacePolicy";
import type { AgentSkillLibrary } from "./sessionEngine";
import type { AgentToolSchema } from "./toolSchemas";

export type HostReloadEmulatorHandler = (args?: {
  params?: Record<string, unknown>;
  clear_inputs?: boolean;
  wait_for_frame_ms?: number;
}) => Promise<string>;
export type HostGetEmulatorLogsHandler = (args: { max_lines?: number }) => Promise<string>;
export type HostCheckPythonHandler = (args: { paths?: string[] }) => Promise<string>;
export type HostMachineMcpHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostObserveEmulatorHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostControlEmulatorInputHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostRunEmulatorScenarioHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostAskUserQuestionHandler = (prompt: AgentQuestionPrompt) => Promise<string | null>;

export type AgentToolProfile = "asset-applier" | "full";

export type AgentToolsOptions = {
  workspacePolicy: WorkspacePolicy;
  skillLibrary?: AgentSkillLibrary;
  assetRoots?: {
    widgetFonts?: string;
    chatAttachments?: ChatMediaAttachment[];
  };
  profile?: AgentToolProfile;
  supportsHostedTools?: boolean;
  toolSchemas?: AgentToolSchema[];
  hostReloadEmulatorHandler?: HostReloadEmulatorHandler;
  hostGetEmulatorLogsHandler?: HostGetEmulatorLogsHandler;
  hostCheckPythonHandler?: HostCheckPythonHandler;
  hostMachineMcpHandler?: HostMachineMcpHandler;
  hostObserveEmulatorHandler?: HostObserveEmulatorHandler;
  hostControlEmulatorInputHandler?: HostControlEmulatorInputHandler;
  hostRunEmulatorScenarioHandler?: HostRunEmulatorScenarioHandler;
  askUserQuestionHandler?: HostAskUserQuestionHandler;
};
