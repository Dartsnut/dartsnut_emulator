import "./agentsBootstrap";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { run, type StreamedRunResult } from "@openai/agents";
import {
  type AgentEvent,
  type AgentTokenUsage,
  type UserLocale
} from "@dartsnut/shared-ipc";
import type { ChatMessage } from "./providerClient";
import type { DeferredSkillId } from "./skillBundle";
import type { AgentSessionPersistence } from "./agentSessionPersistence";
import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";
import type { AgentModelConfig } from "./agentProviderConfig";
import { AGENT_TOOL_SCHEMAS } from "./toolSchemas";
import { WorkspacePolicy } from "./workspacePolicy";
import { AGENT_STOPPED_MESSAGE } from "./providerClient";
import { configureAgentsSdk } from "./agentsBootstrap";
import { buildDartsnutAgent } from "./agents/buildDartsnutAgents";
import {
  refreshDartsnutRunContext,
  seedDartsnutRunContext,
  type DartsnutRunContext,
  type DartsnutTemplateMode,
  type SeedDartsnutRunContextInput
} from "./dartsnutRunContext";
import type { IntakeToolState } from "./creationIntakeHost";
import { DartsnutAgentsSession } from "./dartsnutAgentsSession";
import { mapAgentsStreamToAgentEvents } from "./agentsEventBridge";
import { fixReasoningContentEcho } from "./reasoningContentFilter";
import { addRunTokenUsage } from "./tokenUsage";

export type HostIntakeToolHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostAskQuestionHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostReloadEmulatorHandler = () => Promise<string>;
export type HostGetEmulatorLogsHandler = (args: { max_lines?: number }) => Promise<string>;
export type HostCheckPythonHandler = (args: { paths?: string[] }) => Promise<string>;
export type HostMachineMcpHandler = (args: Record<string, unknown>) => Promise<string>;

export interface AgentSkillLibrary {
  skillsDir: string;
  allowedIds: readonly DeferredSkillId[];
}

export interface SessionEngineOptions {
  workspacePolicy: WorkspacePolicy;
  /** @deprecated Orchestrator builds per-specialist instructions from skillsDir. */
  skillPrompt?: string;
  skillLibrary?: AgentSkillLibrary;
  assetRoots?: {
    widgetFonts?: string;
  };
  completionTools?: ChatCompletionTool[];
  hostIntakeToolHandler?: HostIntakeToolHandler;
  hostAskQuestionHandler?: HostAskQuestionHandler;
  hostReloadEmulatorHandler?: HostReloadEmulatorHandler;
  hostGetEmulatorLogsHandler?: HostGetEmulatorLogsHandler;
  hostCheckPythonHandler?: HostCheckPythonHandler;
  hostMachineMcpHandler?: HostMachineMcpHandler;
  skipInitialWorkspaceResolve?: boolean;
  sessionPersistence?: AgentSessionPersistence;
  sessionTemplateMode?: string | null;
  sessionSection?: string | null;
  initialConversation?: ChatMessage[];
  hostIntakeReadyToFinish?: () => boolean;
  getIntakeState?: () => IntakeToolState;
  preferredUserLocale?: UserLocale | null;
  agentModelConfig?: AgentModelConfig;
  /** Seeds shared SDK run context for orchestrator handoffs. */
  runContextSeed?: Omit<SeedDartsnutRunContextInput, "workspacePath" | "skillsDir"> & {
    skillsDir?: string;
  };
  /** Test injection — bypasses @openai/agents run(). */
  runFn?: typeof run;
}

export interface RunPromptOptions {
  /** Raw user text (e.g. `surprise me`) — not the routed intake/creator system prompt. */
  userPrompt?: string;
}

export class SessionEngine {
  private static readonly MAIN_AGENT_MAX_TURNS = 128;

  private sessionId: string = randomUUID();
  private stoppedOnCleanEmulator = false;
  private readonly completionTools: ChatCompletionTool[];
  private readonly runFn: typeof run;

  constructor(private readonly options: SessionEngineOptions) {
    this.completionTools = options.completionTools ?? AGENT_TOOL_SCHEMAS;
    this.runFn = options.runFn ?? run;
    const existingSessionId = options.sessionPersistence?.readManifest()?.sessionId;
    if (typeof existingSessionId === "string" && existingSessionId.length > 0) {
      this.sessionId = existingSessionId;
    }
  }

  lastRunStoppedOnCleanEmulator(): boolean {
    return this.stoppedOnCleanEmulator;
  }

  private resolveModelConfig(): AgentModelConfig {
    const cfg = this.options.agentModelConfig;
    if (!cfg?.model || !cfg?.apiKey) {
      throw new Error("Provider config missing: model and apiKey are required.");
    }
    return cfg;
  }

  private resolveSkillsDir(): string {
    return (
      this.options.runContextSeed?.skillsDir ??
      this.options.skillLibrary?.skillsDir ??
      path.join(__dirname, "..", "skills")
    );
  }

  private buildRunContext(originalUserPrompt?: string): DartsnutRunContext {
    const workspacePath = this.options.workspacePolicy.getRoot();
    const seed = this.options.runContextSeed;
    return seedDartsnutRunContext({
      workspacePath,
      skillsDir: this.resolveSkillsDir(),
      preferredUserLocale: this.options.preferredUserLocale ?? null,
      projectType: seed?.projectType,
      widgetSize: seed?.widgetSize,
      templateMode: seed?.templateMode ?? (this.options.sessionTemplateMode as DartsnutTemplateMode),
      assetApplierMode: seed?.assetApplierMode,
      intakeState: seed?.intakeState,
      hostIntakeReadyToFinish: this.options.hostIntakeReadyToFinish,
      originalUserPrompt
    });
  }

  private toolsBaseForRun(runContext: DartsnutRunContext) {
    const refresh = () =>
      refreshDartsnutRunContext(
        runContext,
        this.options.hostIntakeReadyToFinish,
        this.options.getIntakeState?.()
      );
    return {
      workspacePolicy: this.options.workspacePolicy,
      skillLibrary: this.options.skillLibrary,
      assetRoots: this.options.assetRoots,
      completionTools: this.completionTools,
      hostIntakeToolHandler: this.options.hostIntakeToolHandler
        ? async (args: Record<string, unknown>) => {
            const result = await this.options.hostIntakeToolHandler!(args);
            refresh();
            return result;
          }
        : undefined,
      hostAskQuestionHandler: this.options.hostAskQuestionHandler
        ? async (args: Record<string, unknown>) => {
            const result = await this.options.hostAskQuestionHandler!(args);
            refresh();
            return result;
          }
        : undefined,
      hostReloadEmulatorHandler: this.options.hostReloadEmulatorHandler,
      hostGetEmulatorLogsHandler: this.options.hostGetEmulatorLogsHandler,
      hostCheckPythonHandler: this.options.hostCheckPythonHandler,
      hostMachineMcpHandler: this.options.hostMachineMcpHandler
    };
  }

  private persistTranscript(kind: "user" | "assistant" | "tool_status" | "thinking", text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.options.sessionPersistence?.appendTranscript({
      kind,
      at: Date.now(),
      text: trimmed.length > 50_000 ? `${trimmed.slice(0, 50_000)}…` : trimmed
    });
  }

  private readWorkspaceFileIfExists(relPath: string): string | undefined {
    try {
      const abs = this.options.workspacePolicy.resolveWithinRoot(relPath);
      if (!fs.existsSync(abs)) {
        return undefined;
      }
      return fs.readFileSync(abs, "utf-8");
    } catch {
      return undefined;
    }
  }

  private emitTokenUsage(
    baseUsage: ReturnType<AgentSessionPersistence["readTokenUsage"]>,
    runUsage: AgentTokenUsage,
    onEvent: (event: AgentEvent) => void
  ): void {
    const sessionUsage = addRunTokenUsage(baseUsage, runUsage);
    this.options.sessionPersistence?.writeTokenUsageAtomic(sessionUsage);
    onEvent({
      type: "token_usage",
      at: Date.now(),
      runUsage,
      sessionUsage
    });
  }

  async runPrompt(
    prompt: string,
    onEvent: (event: AgentEvent) => void,
    abortSignal?: AbortSignal,
    runOptions?: RunPromptOptions
  ): Promise<string> {
    if (!this.options.skipInitialWorkspaceResolve) {
      this.options.workspacePolicy.resolveWithinRoot(".");
    }
    if (abortSignal?.aborted) {
      throw new Error(AGENT_STOPPED_MESSAGE);
    }
    this.stoppedOnCleanEmulator = false;

    const cfg = this.resolveModelConfig();
    configureAgentsSdk(cfg);

    const runContext = this.buildRunContext(runOptions?.userPrompt ?? prompt);
    refreshDartsnutRunContext(
      runContext,
      this.options.hostIntakeReadyToFinish,
      this.options.getIntakeState?.()
    );

    const toolsBase = this.toolsBaseForRun(runContext);
    const agent = buildDartsnutAgent({
      model: cfg.model,
      toolsBase,
      contextSnapshot: runContext,
      preferredUserLocale: this.options.preferredUserLocale ?? null,
      getRunContext: () => runContext
    });

    const session = new DartsnutAgentsSession({
      sessionId: this.sessionId,
      initialConversation: this.options.initialConversation,
      sessionPersistence: this.options.sessionPersistence,
      sessionTemplateMode: this.options.sessionTemplateMode,
      sessionSection: this.options.sessionSection,
      preferredUserLocale: this.options.preferredUserLocale ?? null
    });

    this.persistTranscript("user", prompt);
    onEvent({ type: "status", at: Date.now(), message: "Dartsnut Agent run started." });

    try {
      if (abortSignal?.aborted) {
        throw new Error(AGENT_STOPPED_MESSAGE);
      }

      const stream = (await this.runFn(agent, prompt, {
        session,
        stream: true,
        signal: abortSignal,
        maxTurns: SessionEngine.MAIN_AGENT_MAX_TURNS,
        context: runContext,
        callModelInputFilter: fixReasoningContentEcho
      })) as StreamedRunResult<DartsnutRunContext, any>;

      const tokenUsageBase = this.options.sessionPersistence?.readTokenUsage() ?? null;
      const bridgeResult = await mapAgentsStreamToAgentEvents(stream, onEvent, {
        readWorkspaceFileIfExists: (rel) => this.readWorkspaceFileIfExists(rel),
        persistTranscript: (kind, text) => this.persistTranscript(kind, text),
        onActiveAgentChange: (name) => {
          runContext.activeAgentName = name;
        },
        onTokenUsage: (runUsage) => this.emitTokenUsage(tokenUsageBase, runUsage, onEvent)
      });

      const final = (bridgeResult.finalText || "Dartsnut Agent run complete.").trim();
      onEvent({ type: "final", at: Date.now(), content: final });
      onEvent({
        type: "status",
        at: Date.now(),
        message: `[agent_eval] reasoning=${bridgeResult.sawReasoning} tool_calls=${bridgeResult.sawToolCall} output_chars=${final.length}`
      });
      this.persistTranscript("assistant", final);
      return final;
    } catch (error) {
      if (abortSignal?.aborted) {
        throw new Error(AGENT_STOPPED_MESSAGE);
      }
      const message = error instanceof Error ? error.message : String(error);
      onEvent({ type: "error", at: Date.now(), message });
      this.persistTranscript("assistant", message);
      return message;
    }
  }
}
