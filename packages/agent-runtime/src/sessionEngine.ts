import "./agentsBootstrap";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Agent, run, type StreamedRunResult } from "@openai/agents";
import {
  buildLanguageSystemPrompt,
  type AgentEvent,
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
import {
  CREATOR_MAX_STEPS_WITHOUT_ARTIFACTS,
  decideCreatorLoopStep,
  readCreatorArtifactStatus
} from "./creatorTurnGuard";
import { decideModificationLoopStep, MODIFICATION_MAX_STEPS } from "./modificationTurnGuard";
import { configureAgentsSdk } from "./agentsBootstrap";
import { buildAgentTools } from "./agentTools";
import { DartsnutAgentsSession } from "./dartsnutAgentsSession";
import { mapAgentsStreamToAgentEvents } from "./agentsEventBridge";
import { fixReasoningContentEcho } from "./reasoningContentFilter";

export type HostIntakeToolHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostAskQuestionHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostReloadEmulatorHandler = () => Promise<string>;
export type HostGetEmulatorLogsHandler = (args: { max_lines?: number }) => Promise<string>;

export interface AgentSkillLibrary {
  skillsDir: string;
  allowedIds: readonly DeferredSkillId[];
}

export interface SessionEngineOptions {
  workspacePolicy: WorkspacePolicy;
  skillPrompt: string;
  skillLibrary?: AgentSkillLibrary;
  assetRoots?: {
    widgetFonts?: string;
  };
  completionTools?: ChatCompletionTool[];
  hostIntakeToolHandler?: HostIntakeToolHandler;
  hostAskQuestionHandler?: HostAskQuestionHandler;
  hostReloadEmulatorHandler?: HostReloadEmulatorHandler;
  hostGetEmulatorLogsHandler?: HostGetEmulatorLogsHandler;
  skipInitialWorkspaceResolve?: boolean;
  sessionPersistence?: AgentSessionPersistence;
  sessionTemplateMode?: string | null;
  sessionSection?: string | null;
  initialConversation?: ChatMessage[];
  hostIntakeReadyToFinish?: () => boolean;
  preferredUserLocale?: UserLocale | null;
  agentModelConfig?: AgentModelConfig;
  /** Test injection — bypasses @openai/agents run(). */
  runFn?: typeof run;
}

export type RunPromptToolLoopProfile = "default" | "modification";
export interface RunPromptOptions {
  toolLoopProfile?: RunPromptToolLoopProfile;
}

export class SessionEngine {
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

  private buildInstructions(): string {
    const languagePrompt = buildLanguageSystemPrompt(this.options.preferredUserLocale ?? null);
    return [
      "You are the Dartsnut coding runtime. Use function tool calls for all tool usage.",
      this.options.skillPrompt,
      languagePrompt
    ].join("\n\n");
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

    const agent = new Agent({
      name: "DartsnutAgent",
      instructions: this.buildInstructions(),
      model: cfg.model,
      tools: buildAgentTools({
        workspacePolicy: this.options.workspacePolicy,
        skillLibrary: this.options.skillLibrary,
        assetRoots: this.options.assetRoots,
        completionTools: this.completionTools,
        hostIntakeToolHandler: this.options.hostIntakeToolHandler,
        hostAskQuestionHandler: this.options.hostAskQuestionHandler,
        hostReloadEmulatorHandler: this.options.hostReloadEmulatorHandler,
        hostGetEmulatorLogsHandler: this.options.hostGetEmulatorLogsHandler
      })
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

    const profile = runOptions?.toolLoopProfile ?? "default";
    const maxSteps =
      profile === "modification" ? MODIFICATION_MAX_STEPS : Math.max(12, CREATOR_MAX_STEPS_WITHOUT_ARTIFACTS + 4);

    let finalText = "";
    let sawReasoning = false;
    let sawToolCall = false;
    let verifyStepsAfterArtifactsReady = 0;
    let stepsWithoutArtifactsReady = 0;
    let stepsAfterArtifactsReady = 0;
    let nextInput: string | undefined = prompt;

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        if (abortSignal?.aborted) {
          throw new Error(AGENT_STOPPED_MESSAGE);
        }

        const stream = (await this.runFn(agent, nextInput ?? " ", {
          session,
          stream: true,
          signal: abortSignal,
          // SDK default maxTurns is 10 — enough for model→tool→model within one outer step.
          // Do not set maxTurns: 1; that fails as soon as any tool call needs a follow-up turn.
          callModelInputFilter: fixReasoningContentEcho
        })) as StreamedRunResult<any, any>;

        const bridgeResult = await mapAgentsStreamToAgentEvents(stream, onEvent, {
          readWorkspaceFileIfExists: (rel) => this.readWorkspaceFileIfExists(rel),
          persistTranscript: (kind, text) => this.persistTranscript(kind, text)
        });

        finalText = bridgeResult.finalText || finalText;
        sawReasoning = sawReasoning || bridgeResult.sawReasoning;
        sawToolCall = sawToolCall || bridgeResult.sawToolCall;
        nextInput = undefined;

        if (profile === "modification") {
          const modDecision = decideModificationLoopStep({
            step,
            toolCallCount: bridgeResult.toolCallCount
          });
          if (modDecision.type === "complete") {
            onEvent({ type: "status", at: Date.now(), message: modDecision.summary });
            finalText = (bridgeResult.finalText || finalText || modDecision.summary).trim();
            break;
          }
          if (bridgeResult.toolCallCount === 0) {
            break;
          }
          continue;
        }

        const artifacts = readCreatorArtifactStatus(
          (absolutePath) => fs.existsSync(absolutePath),
          (relativePath) => this.options.workspacePolicy.resolveWithinRoot(relativePath)
        );
        const artifactsReady = artifacts.confJson && artifacts.mainPy;
        if (artifactsReady) {
          stepsAfterArtifactsReady += 1;
          const verificationOnly = bridgeResult.toolNames.every((name) =>
            ["read_file", "get_emulator_logs", "get_dartsnut_skill", "list_files", "reload_emulator"].includes(name)
          );
          verifyStepsAfterArtifactsReady = verificationOnly ? verifyStepsAfterArtifactsReady + 1 : 0;
        } else {
          stepsWithoutArtifactsReady += 1;
          verifyStepsAfterArtifactsReady = 0;
        }

        const creatorDecision = decideCreatorLoopStep(
          {
            step,
            toolCallCount: bridgeResult.toolCallCount,
            contentChars: bridgeResult.stepText.length,
            reasoningChars: bridgeResult.stepReasoning.length,
            filesWrittenThisTurn: bridgeResult.filesWrittenThisTurn,
            workspaceHasConfJson: artifacts.confJson,
            workspaceHasMainPy: artifacts.mainPy,
            toolNames: bridgeResult.toolNames,
            stepsAfterArtifactsReady
          },
          verifyStepsAfterArtifactsReady,
          stepsWithoutArtifactsReady
        );

        if (creatorDecision.type === "fail") {
          throw new Error(creatorDecision.message);
        }
        if (creatorDecision.type === "stall_turn") {
          onEvent({ type: "status", at: Date.now(), message: creatorDecision.reason });
          this.persistTranscript("user", creatorDecision.nudgeUser);
          nextInput = creatorDecision.nudgeUser;
          continue;
        }
        if (creatorDecision.type === "complete") {
          onEvent({ type: "status", at: Date.now(), message: creatorDecision.summary });
          finalText = (bridgeResult.finalText || finalText || creatorDecision.summary).trim();
          break;
        }
        if (bridgeResult.toolCallCount === 0) {
          break;
        }
      }
    } catch (error) {
      if (abortSignal?.aborted) {
        throw new Error(AGENT_STOPPED_MESSAGE);
      }
      const message = error instanceof Error ? error.message : String(error);
      onEvent({ type: "error", at: Date.now(), message });
      this.persistTranscript("assistant", message);
      return message;
    }

    const final = finalText.trim() || "Dartsnut Agent run complete.";
    onEvent({ type: "final", at: Date.now(), content: final });
    onEvent({
      type: "status",
      at: Date.now(),
      message: `[agent_eval] reasoning=${sawReasoning} tool_calls=${sawToolCall} output_chars=${final.length}`
    });
    this.persistTranscript("assistant", final);
    return final;
  }
}
