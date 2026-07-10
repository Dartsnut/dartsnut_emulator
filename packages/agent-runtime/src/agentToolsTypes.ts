import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";
import type { ChatMediaAttachment } from "@dartsnut/shared-ipc";
import type { WorkspacePolicy } from "./workspacePolicy";
import type { AgentSkillLibrary } from "./sessionEngine";
import type { DartsnutRunContext } from "./dartsnutRunContext";

export type HostIntakeToolHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostAskQuestionHandler = (args: Record<string, unknown>) => Promise<string>;
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

export type AgentToolProfile = "asset-applier" | "full";

export type AgentToolsOptions = {
  workspacePolicy: WorkspacePolicy;
  skillLibrary?: AgentSkillLibrary;
  assetRoots?: {
    widgetFonts?: string;
    chatAttachments?: ChatMediaAttachment[];
  };
  profile?: AgentToolProfile;
  completionTools?: ChatCompletionTool[];
  /** Live run-context accessor — gates file mutations until intake is recorded. */
  getRunContext?: () => DartsnutRunContext;
  hostIntakeToolHandler?: HostIntakeToolHandler;
  hostAskQuestionHandler?: HostAskQuestionHandler;
  hostReloadEmulatorHandler?: HostReloadEmulatorHandler;
  hostGetEmulatorLogsHandler?: HostGetEmulatorLogsHandler;
  hostCheckPythonHandler?: HostCheckPythonHandler;
  hostMachineMcpHandler?: HostMachineMcpHandler;
  hostObserveEmulatorHandler?: HostObserveEmulatorHandler;
  hostControlEmulatorInputHandler?: HostControlEmulatorInputHandler;
  hostRunEmulatorScenarioHandler?: HostRunEmulatorScenarioHandler;
};
