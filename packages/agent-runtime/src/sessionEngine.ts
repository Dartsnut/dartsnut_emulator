import "./agentsBootstrap";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Runner, run, type AgentInputItem, type StreamedRunResult } from "@openai/agents";
import {
  type AgentEvent,
  type AgentTokenUsage,
  type AgentQuestionPrompt,
  type ChatMediaAttachment,
  type AgentProfileId
} from "@dartsnut/shared-ipc";
import type { DeferredSkillId } from "./skillBundle";
import type { AgentSessionPersistence } from "./agentSessionPersistence";
import { agentModelChainKey, type AgentModelConfig } from "./agentProviderConfig";
import { AGENT_TOOL_SCHEMAS } from "./toolSchemas";
import { WorkspacePolicy } from "./workspacePolicy";
import { AGENT_STOPPED_MESSAGE } from "./agentErrors";
import { configureAgentsSdk } from "./agentsBootstrap";
import { buildDartsnutAgent } from "./agents/buildDartsnutAgents";
import {
  refreshDartsnutRunContext,
  seedDartsnutRunContext,
  type DartsnutRunContext,
  type DartsnutTemplateMode,
  type SeedDartsnutRunContextInput
} from "./dartsnutRunContext";
import { DartsnutAgentsSession } from "./dartsnutAgentsSession";
import { forwardAgentsStream, type AgentsStreamDiagnostics } from "./agentsEventBridge";
import {
  createSafeCallModelInputFilter,
  EMPTY_MODEL_RESPONSE_MESSAGE
} from "./modelInputGuard";
import { addRunTokenUsage } from "./tokenUsage";
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
export type HostPixelLabGenerateHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostAskUserQuestionHandler = (prompt: AgentQuestionPrompt) => Promise<string | null>;

export interface AgentSkillLibrary {
  skillsDir: string;
  allowedIds: readonly DeferredSkillId[];
}

export interface SessionEngineOptions {
  workspacePolicy: WorkspacePolicy;
  skillLibrary?: AgentSkillLibrary;
  assetRoots?: {
    widgetFonts?: string;
    chatAttachments?: ChatMediaAttachment[];
  };
  toolSchemas?: AgentToolSchema[];
  hostReloadEmulatorHandler?: HostReloadEmulatorHandler;
  hostGetEmulatorLogsHandler?: HostGetEmulatorLogsHandler;
  hostCheckPythonHandler?: HostCheckPythonHandler;
  hostMachineMcpHandler?: HostMachineMcpHandler;
  hostObserveEmulatorHandler?: HostObserveEmulatorHandler;
  hostControlEmulatorInputHandler?: HostControlEmulatorInputHandler;
  hostRunEmulatorScenarioHandler?: HostRunEmulatorScenarioHandler;
  hostPixelLabGenerateHandler?: HostPixelLabGenerateHandler;
  askUserQuestionHandler?: HostAskUserQuestionHandler;
  skipInitialWorkspaceResolve?: boolean;
  sessionPersistence?: AgentSessionPersistence;
  sessionTemplateMode?: string | null;
  sessionSection?: string | null;
  initialItems?: AgentInputItem[];
  agentProfileId?: AgentProfileId | null;
  agentModelConfig?: AgentModelConfig;
  /** Seeds shared SDK run context for orchestrator handoffs. */
  runContextSeed?: Omit<SeedDartsnutRunContextInput, "workspacePath" | "skillsDir"> & {
    skillsDir?: string;
  };
  /** Test injection — bypasses @openai/agents run(). */
  runFn?: typeof run;
  /** Privacy-safe structural diagnostics; caller decides whether logging is enabled. */
  onDiagnostic?: (message: string, meta: Record<string, unknown>) => void;
}

export interface RunPromptOptions {
  /** Raw user text before any creation context is appended. */
  userPrompt?: string;
}

export function promptRequestsHostedTools(prompt: string): boolean {
  return /\b(web search|search (?:the )?(?:web|internet)|browse (?:the )?(?:web|internet)|latest online|current online|code interpreter|python sandbox|run python|data analysis)\b/i.test(prompt);
}

function isInvalidPreviousResponseError(error: unknown): boolean {
  const apiError = error as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } };
  if (apiError?.code === "INVALID_PREVIOUS_RESPONSE" || apiError?.error?.code === "INVALID_PREVIOUS_RESPONSE") {
    return true;
  }
  const message = typeof apiError?.error?.message === "string"
    ? apiError.error.message
    : typeof apiError?.message === "string"
      ? apiError.message
      : "";
  return /previous_response_id/i.test(message)
    && /(?:only supported|not supported|unsupported|unavailable|invalid|not found)/i.test(message);
}

function hasAgentsStreamActivity(diagnostics: AgentsStreamDiagnostics | null): boolean {
  if (!diagnostics) return true;
  return diagnostics.rawModelEvents > 0
    || diagnostics.runItemEvents > 0
    || diagnostics.agentUpdatedEvents > 0;
}

export class SessionEngine {
  private static readonly MAIN_AGENT_MAX_TURNS = 128;

  private sessionId: string = randomUUID();
  private stoppedOnCleanEmulator = false;
  private readonly toolSchemas: AgentToolSchema[];

  constructor(private readonly options: SessionEngineOptions) {
    this.toolSchemas = options.toolSchemas ?? AGENT_TOOL_SCHEMAS;
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
      agentProfileId: this.options.agentProfileId ?? null,
      projectType: seed?.projectType,
      widgetSize: seed?.widgetSize,
      templateMode: seed?.templateMode ?? (this.options.sessionTemplateMode as DartsnutTemplateMode),
      assetApplierMode: seed?.assetApplierMode,
      originalUserPrompt
    });
  }

  private toolsBaseForRun(runContext: DartsnutRunContext, modelConfig: AgentModelConfig, userPrompt: string) {
    return {
      workspacePolicy: this.options.workspacePolicy,
      skillLibrary: this.options.skillLibrary,
      assetRoots: this.options.assetRoots,
      toolSchemas: this.toolSchemas,
      supportsHostedTools: modelConfig.supportsHostedTools === true && promptRequestsHostedTools(userPrompt),
      hostReloadEmulatorHandler: this.options.hostReloadEmulatorHandler,
      hostGetEmulatorLogsHandler: this.options.hostGetEmulatorLogsHandler,
      hostCheckPythonHandler: this.options.hostCheckPythonHandler,
      hostMachineMcpHandler: this.options.hostMachineMcpHandler,
      hostObserveEmulatorHandler: this.options.hostObserveEmulatorHandler,
      hostControlEmulatorInputHandler: this.options.hostControlEmulatorInputHandler,
      hostRunEmulatorScenarioHandler: this.options.hostRunEmulatorScenarioHandler,
      hostPixelLabGenerateHandler: this.options.hostPixelLabGenerateHandler,
      askUserQuestionHandler: this.options.askUserQuestionHandler
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
    const runStartedAt = Date.now();
    if (!this.options.skipInitialWorkspaceResolve) {
      this.options.workspacePolicy.resolveWithinRoot(".");
    }
    if (abortSignal?.aborted) {
      throw new Error(AGENT_STOPPED_MESSAGE);
    }
    this.stoppedOnCleanEmulator = false;

    const cfg = this.resolveModelConfig();
    const modelProvider = configureAgentsSdk(cfg);
    const modelChainKey = cfg.supportsResponseContinuation === false ? null : agentModelChainKey(cfg);
    if (!modelChainKey) this.options.sessionPersistence?.clearModelChain();
    const previousResponseId = modelChainKey
      ? this.options.sessionPersistence?.readModelChainResponseId(modelChainKey) ?? undefined
      : undefined;

    const runContext = this.buildRunContext(runOptions?.userPrompt ?? prompt);
    refreshDartsnutRunContext(runContext);

    const toolsBase = this.toolsBaseForRun(runContext, cfg, runOptions?.userPrompt ?? prompt);
    const agent = buildDartsnutAgent({
      model: cfg.model,
      toolsBase,
      contextSnapshot: runContext,
      agentProfileId: this.options.agentProfileId ?? null,
      onModelRetry: (diagnostic) => this.options.onDiagnostic?.("agent model request retry", diagnostic)
    });
    const toolNames = agent.tools.map((tool) => {
      const value = tool as { name?: unknown; type?: unknown };
      if (typeof value.name === "string") return value.name;
      if (typeof value.type === "string") return value.type;
      return "unknown";
    });
    this.options.onDiagnostic?.("agent SDK run configured", {
      model: cfg.model,
      endpointKind: cfg.endpointKind,
      hasPreviousResponseId: Boolean(previousResponseId),
      hostedToolsEnabled: toolsBase.supportsHostedTools,
      toolCount: toolNames.length,
      toolNames,
      maxTurns: SessionEngine.MAIN_AGENT_MAX_TURNS,
      promptChars: prompt.length
    });

    const session = new DartsnutAgentsSession({
      sessionId: this.sessionId,
      initialItems: this.options.initialItems,
      sessionPersistence: this.options.sessionPersistence,
      sessionTemplateMode: this.options.sessionTemplateMode,
      sessionSection: this.options.sessionSection,
      agentProfileId: this.options.agentProfileId ?? null
    });

    this.persistTranscript("user", prompt);
    onEvent({ type: "status", at: Date.now(), message: "Dartsnut Agent run started." });

    try {
      if (abortSignal?.aborted) {
        throw new Error(AGENT_STOPPED_MESSAGE);
      }

      const sdkRunOptions = {
        stream: true as const,
        signal: abortSignal,
        maxTurns: SessionEngine.MAIN_AGENT_MAX_TURNS,
        context: runContext,
        previousResponseId,
        callModelInputFilter: createSafeCallModelInputFilter((diagnostic) => {
          this.options.onDiagnostic?.("agent model repeated identical input", {
            failure: "repeated_model_input",
            ...diagnostic,
            hadPreviousResponseId: Boolean(previousResponseId)
          });
        })
      };
      // @openai/agents' process-global run() caches its first model provider.
      // A per-run Runner keeps provider switches and bridge fetch injection authoritative.
      const startStream = async (chainId: string | undefined, runSession: DartsnutAgentsSession) =>
        (await (this.options.runFn
          ? this.options.runFn(agent, prompt, { ...sdkRunOptions, session: runSession, previousResponseId: chainId })
          : new Runner({ modelProvider }).run(agent, prompt, {
            ...sdkRunOptions,
            session: runSession,
            previousResponseId: chainId
          }))) as StreamedRunResult<DartsnutRunContext, any>;
      let stream: StreamedRunResult<DartsnutRunContext, any>;
      let retriedWithoutContinuation = false;
      try {
        stream = await startStream(previousResponseId, session);
      } catch (error) {
        if (!previousResponseId || !isInvalidPreviousResponseError(error)) throw error;
        this.options.sessionPersistence?.clearModelChain();
        this.options.onDiagnostic?.("agent response chain unavailable; retrying without continuation", {
          failure: "invalid_previous_response",
          hadPreviousResponseId: true,
          status: typeof (error as { status?: unknown }).status === "number"
            ? (error as { status: number }).status
            : undefined,
          code: "INVALID_PREVIOUS_RESPONSE"
        });
        retriedWithoutContinuation = true;
        stream = await startStream(undefined, new DartsnutAgentsSession({
          sessionId: this.sessionId,
          initialItems: this.options.initialItems,
          sessionPersistence: this.options.sessionPersistence,
          sessionTemplateMode: this.options.sessionTemplateMode,
          sessionSection: this.options.sessionSection,
          agentProfileId: this.options.agentProfileId ?? null
        }));
      }
      this.options.onDiagnostic?.("agent SDK stream opened", {
        elapsedMs: Date.now() - runStartedAt,
        hadPreviousResponseId: Boolean(previousResponseId),
        retriedWithoutContinuation
      });

      const tokenUsageBase = this.options.sessionPersistence?.readTokenUsage() ?? null;
      let streamedFallbackText = "";
      let streamFailureDiagnostics: AgentsStreamDiagnostics | null = null;
      let streamResult: Awaited<ReturnType<typeof forwardAgentsStream>>;
      const consumeStream = async (
        activeStream: StreamedRunResult<DartsnutRunContext, any>,
        hadContinuation: boolean
      ) => {
        streamedFallbackText = "";
        streamFailureDiagnostics = null;
        return forwardAgentsStream(activeStream, onEvent, (name) => {
          runContext.activeAgentName = name;
        }, (diagnostics, streamedText) => {
          streamedFallbackText = streamedText;
          streamFailureDiagnostics = diagnostics;
          this.options.onDiagnostic?.("agent stream iteration failed", {
            failure: "stream_iteration_error",
            hadPreviousResponseId: hadContinuation,
            streamedTextChars: streamedText.length,
            ...diagnostics
          });
        }, {
          readWorkspaceFileIfExists: (relPath) => this.readWorkspaceFileIfExists(relPath),
          persistTranscript: (kind, text) => this.persistTranscript(kind, text)
        });
      };
      try {
        streamResult = await consumeStream(stream, Boolean(previousResponseId));
      } catch (error) {
        if (
          previousResponseId
          && !retriedWithoutContinuation
          && isInvalidPreviousResponseError(error)
          && !hasAgentsStreamActivity(streamFailureDiagnostics)
        ) {
          this.options.sessionPersistence?.clearModelChain();
          this.options.onDiagnostic?.("agent response chain unavailable; retrying without continuation", {
            failure: "invalid_previous_response",
            hadPreviousResponseId: true,
            status: typeof (error as { status?: unknown }).status === "number"
              ? (error as { status: number }).status
              : undefined,
            code: "INVALID_PREVIOUS_RESPONSE"
          });
          retriedWithoutContinuation = true;
          const fallbackStream = await startStream(undefined, new DartsnutAgentsSession({
            sessionId: this.sessionId,
            initialItems: this.options.initialItems,
            sessionPersistence: this.options.sessionPersistence,
            sessionTemplateMode: this.options.sessionTemplateMode,
            sessionSection: this.options.sessionSection,
            agentProfileId: this.options.agentProfileId ?? null
          }));
          streamResult = await consumeStream(fallbackStream, false);
        } else if (
          error instanceof Error
          && error.message === EMPTY_MODEL_RESPONSE_MESSAGE
          && streamedFallbackText
        ) {
          this.options.onDiagnostic?.("agent recovered streamed assistant text after loop guard", {
            recovery: "streamed_text_fallback",
            finalChars: streamedFallbackText.length,
            ...(streamFailureDiagnostics ?? {})
          });
          onEvent({ type: "final", at: Date.now(), content: streamedFallbackText });
          this.persistTranscript("assistant", streamedFallbackText);
          return streamedFallbackText;
        } else {
          throw error;
        }
      }

      if (streamResult.tokenUsage) {
        this.emitTokenUsage(tokenUsageBase, streamResult.tokenUsage, onEvent);
      }
      const final = streamResult.finalText;
      if (!final) {
        this.options.onDiagnostic?.("agent stream completed without assistant text", {
          failure: "empty_mapped_output",
          hadPreviousResponseId: Boolean(previousResponseId)
        });
        throw new Error(EMPTY_MODEL_RESPONSE_MESSAGE);
      }
      if (modelChainKey && streamResult.lastResponseId) {
        await this.options.sessionPersistence?.flushWrites();
        this.options.sessionPersistence?.writeModelChainResponseIdAtomic(
          modelChainKey,
          streamResult.lastResponseId
        );
      } else if (modelChainKey && previousResponseId) {
        this.options.sessionPersistence?.clearModelChain();
      }
      onEvent({ type: "final", at: Date.now(), content: final });
      onEvent({
        type: "status",
        at: Date.now(),
        message: `[agent_eval] output_chars=${final.length}`
      });
      this.persistTranscript("assistant", final);
      this.options.onDiagnostic?.("agent SDK run completed", {
        elapsedMs: Date.now() - runStartedAt,
        finalChars: final.length,
        lastResponseIdPresent: Boolean(streamResult.lastResponseId),
        activeAgentName: streamResult.activeAgentName ?? runContext.activeAgentName,
        tokenUsage: streamResult.tokenUsage,
        ...streamResult.diagnostics
      });
      return final;
    } catch (error) {
      const apiError = error as {
        name?: unknown;
        status?: unknown;
        code?: unknown;
        type?: unknown;
        error?: { code?: unknown; message?: unknown; type?: unknown };
        message?: unknown;
      };
      const aborted = abortSignal?.aborted === true;
      const abortReason = aborted && typeof abortSignal?.reason === "string"
        ? abortSignal.reason
        : undefined;
      this.options.onDiagnostic?.("agent SDK run failed", {
        elapsedMs: Date.now() - runStartedAt,
        errorName: error instanceof Error ? error.name : apiError?.name,
        status: typeof apiError?.status === "number" ? apiError.status : undefined,
        code: typeof apiError?.error?.code === "string"
          ? apiError.error.code
          : typeof apiError?.code === "string"
            ? apiError.code
            : undefined,
        type: typeof apiError?.error?.type === "string"
          ? apiError.error.type
          : typeof apiError?.type === "string"
            ? apiError.type
            : undefined,
        message: typeof apiError?.error?.message === "string"
          ? apiError.error.message
          : error instanceof Error
            ? error.message
            : String(error),
        hadPreviousResponseId: Boolean(previousResponseId),
        aborted,
        abortReason
      });
      if (abortSignal?.aborted) {
        throw new Error(AGENT_STOPPED_MESSAGE);
      }
      if (previousResponseId) this.options.sessionPersistence?.clearModelChain();
      const detail = apiError?.error && typeof apiError.error === "object"
        ? [apiError.error.message, apiError.error.code].filter((value) => typeof value === "string" && value).join(" ")
        : "";
      const message = detail || (error instanceof Error ? error.message : String(error));
      throw new Error(message, { cause: error });
    }
  }
}
