import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildLanguageSystemPrompt,
  type AgentEvent,
  type UserLocale
} from "@dartsnut/shared-ipc";
import type { ChatMessage } from "./providerClient";
import type { DeferredSkillId } from "./skillBundle";
import { DEFERRED_SKILL_IDS, readDeferredSkillMarkdown } from "./skillBundle";
import type { AgentSessionPersistence } from "./agentSessionPersistence";
import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";
import type { AgentModelConfig } from "./agentProviderConfig";
import { AGENT_TOOL_SCHEMAS } from "./toolSchemas";
import { WorkspacePolicy } from "./workspacePolicy";
import {
  AGENT_STOPPED_MESSAGE,
  ProviderClient,
  type CompletionProvider,
  type ParsedToolCall,
  type ToolCallEnvelope
} from "./providerClient";
import {
  CREATOR_MAX_STEPS_WITHOUT_ARTIFACTS,
  decideCreatorLoopStep,
  isFileMutationToolName,
  readCreatorArtifactStatus
} from "./creatorTurnGuard";
import { decideModificationLoopStep, MODIFICATION_MAX_STEPS } from "./modificationTurnGuard";

export type HostIntakeToolHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostAskQuestionHandler = (args: Record<string, unknown>) => Promise<string>;
export type HostReloadEmulatorHandler = () => Promise<string>;
export type HostGetEmulatorLogsHandler = (args: { max_lines?: number }) => Promise<string>;

export interface AgentSkillLibrary {
  skillsDir: string;
  allowedIds: readonly DeferredSkillId[];
}

export interface SessionEngineOptions {
  provider?: unknown;
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
  /** @deprecated temporary alias while renaming ADK-era config fields. */
  adkModelConfig?: AgentModelConfig;
  agentModelConfig?: AgentModelConfig;
}

export type RunPromptToolLoopProfile = "default" | "modification";
export interface RunPromptOptions {
  toolLoopProfile?: RunPromptToolLoopProfile;
}

type ToolResult = {
  ok: boolean;
  result: unknown;
};

const TOOL_STATUS_META_PREFIX = " @@tool_status_meta@@";

type ToolStatusPhase = "call" | "result";

type ToolStatusMeta = {
  callId?: string;
  toolName?: string;
  phase?: ToolStatusPhase;
  filePath?: string;
  added?: number;
  deleted?: number;
};

type ToolStatusContext = {
  callId?: string;
  path?: string;
  source?: string;
  added?: number;
  deleted?: number;
};

function toRelPath(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : undefined;
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split(/\r?\n/).length;
}

function computeWriteDiff(previousContent: string | undefined, nextContent: string): { added: number; deleted: number } {
  const nextLines = countLines(nextContent);
  const prevLines = typeof previousContent === "string" ? countLines(previousContent) : 0;
  return {
    added: Math.max(0, nextLines),
    deleted: Math.max(0, prevLines)
  };
}

function computeReplaceDiff(findText: string, replaceText: string): { added: number; deleted: number } {
  const removed = countLines(findText);
  const added = countLines(replaceText);
  return { added, deleted: removed };
}

function buildToolStatusMessage(name: string, phase: ToolStatusPhase, context?: ToolStatusContext): {
  text: string;
  meta?: ToolStatusMeta;
} {
  const filePath = context?.path;
  const baseMeta: ToolStatusMeta | undefined =
    filePath || typeof context?.added === "number" || typeof context?.deleted === "number"
      ? {
        callId: context?.callId,
        toolName: name,
        phase,
        filePath,
        added: context?.added,
        deleted: context?.deleted
      }
      : { callId: context?.callId, toolName: name, phase };

  switch (name) {
    case "list_files":
      return { text: phase === "call" ? "Listing files…" : "Listed files.", meta: baseMeta };
    case "read_file":
      return {
        text: phase === "call" ? `Reading ${filePath ?? "file"}…` : `Read ${filePath ?? "file"}.`,
        ...(baseMeta ? { meta: baseMeta } : {})
      };
    case "write_file":
      return {
        text:
          phase === "call"
            ? `Creating ${filePath ?? "file"}…`
            : `Created ${filePath ?? "file"}.`,
        ...(baseMeta ? { meta: baseMeta } : {})
      };
    case "replace_in_file":
      return {
        text:
          phase === "call"
            ? `Editing ${filePath ?? "file"}…`
            : `Edited ${filePath ?? "file"}.`,
        ...(baseMeta ? { meta: baseMeta } : {})
      };
    case "copy_asset_file": {
      const source = context?.source ?? "asset";
      return {
        text:
          phase === "call"
            ? `Copying ${source} to ${filePath ?? "destination"}…`
            : `Copied ${source} → ${filePath ?? "destination"}.`,
        ...(baseMeta ? { meta: baseMeta } : {})
      };
    }
    case "get_dartsnut_skill":
      return { text: phase === "call" ? "Loading Dartsnut skill…" : "Loaded Dartsnut skill.", meta: baseMeta };
    case "dartsnut_ask_question":
      return { text: phase === "call" ? "Asking question…" : "Recorded answer.", meta: baseMeta };
    case "dartsnut_project_intake":
      return { text: phase === "call" ? "Updating project intake…" : "Updated project intake.", meta: baseMeta };
    case "reload_emulator":
      return { text: phase === "call" ? "Reloading emulator…" : "Reloaded emulator.", meta: baseMeta };
    case "get_emulator_logs":
      return { text: phase === "call" ? "Fetching emulator logs…" : "Fetched emulator logs.", meta: baseMeta };
    default:
      return { text: phase === "call" ? `Running ${name}…` : `Finished ${name}.`, meta: baseMeta };
  }
}

function encodeToolStatusForTransport(message: { text: string; meta?: ToolStatusMeta }): string {
  if (!message.meta) {
    return message.text;
  }
  return `${message.text}${TOOL_STATUS_META_PREFIX}${JSON.stringify(message.meta)}`;
}

function toolResultToString(result: ToolResult): string {
  return JSON.stringify(result.result);
}

function safeParseObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function isDeferredSkillId(value: string): value is DeferredSkillId {
  return (DEFERRED_SKILL_IDS as readonly string[]).includes(value);
}

export class SessionEngine {
  private sessionId: string = randomUUID();
  private stoppedOnCleanEmulator = false;
  private readonly provider: CompletionProvider;
  private readonly tools: Record<string, (args: Record<string, unknown>) => Promise<string>>;
  private readonly completionTools: ChatCompletionTool[];
  private conversation: ChatMessage[];

  constructor(private readonly options: SessionEngineOptions) {
    this.provider = this.resolveProvider();
    this.completionTools = options.completionTools ?? AGENT_TOOL_SCHEMAS;
    this.tools = this.buildToolHandlers();
    this.conversation = Array.isArray(options.initialConversation) ? [...options.initialConversation] : [];
    const existingSessionId = options.sessionPersistence?.readManifest()?.sessionId;
    if (typeof existingSessionId === "string" && existingSessionId.length > 0) {
      this.sessionId = existingSessionId;
    }
  }

  lastRunStoppedOnCleanEmulator(): boolean {
    return this.stoppedOnCleanEmulator;
  }

  private resolveProvider(): CompletionProvider {
    const maybeProvider = this.options.provider as CompletionProvider | undefined;
    if (maybeProvider && typeof maybeProvider.complete === "function") {
      return maybeProvider;
    }
    const cfg = this.options.agentModelConfig ?? this.options.adkModelConfig;
    if (!cfg?.model || !cfg?.apiKey) {
      throw new Error("Provider config missing: model and apiKey are required.");
    }
    return new ProviderClient({
      baseUrl: cfg.baseUrl ?? "https://api.openai.com/v1",
      apiKey: cfg.apiKey,
      model: cfg.model
    });
  }

  private async listFilesRecursive(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          await walk(abs);
          continue;
        }
        out.push(rel);
      }
    };
    await walk(root);
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  private buildToolHandlers(): Record<string, (args: Record<string, unknown>) => Promise<string>> {
    const listFiles = async (args: Record<string, unknown>) => {
      const rel = typeof args.path === "string" ? args.path : ".";
      try {
        const target = this.options.workspacePolicy.resolveWithinRoot(rel);
        const files = await this.listFilesRecursive(target);
        const result: ToolResult = { ok: true, result: { ok: true, files } };
        return toolResultToString(result);
      } catch (error) {
        const result: ToolResult = {
          ok: false,
          result: { ok: false, error: error instanceof Error ? error.message : String(error) }
        };
        return toolResultToString(result);
      }
    };

    const readFile = async (args: Record<string, unknown>) => {
      const rel = typeof args.path === "string" ? args.path : "";
      try {
        const target = this.options.workspacePolicy.resolveWithinRoot(rel);
        const content = await fsp.readFile(target, "utf-8");
        const result: ToolResult = { ok: true, result: { ok: true, content } };
        return toolResultToString(result);
      } catch (error) {
        const result: ToolResult = {
          ok: false,
          result: { ok: false, error: error instanceof Error ? error.message : String(error) }
        };
        return toolResultToString(result);
      }
    };

    const writeFile = async (args: Record<string, unknown>) => {
      const rel = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : "";
      try {
        const target = this.options.workspacePolicy.resolveWithinRoot(rel);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, content, "utf-8");
        const result: ToolResult = { ok: true, result: { ok: true, path: rel } };
        return toolResultToString(result);
      } catch (error) {
        const result: ToolResult = {
          ok: false,
          result: { ok: false, error: error instanceof Error ? error.message : String(error) }
        };
        return toolResultToString(result);
      }
    };

    const replaceInFile = async (args: Record<string, unknown>) => {
      const rel = typeof args.path === "string" ? args.path : "";
      const find = typeof args.find === "string" ? args.find : "";
      const replace = typeof args.replace === "string" ? args.replace : "";
      try {
        const target = this.options.workspacePolicy.resolveWithinRoot(rel);
        const content = await fsp.readFile(target, "utf-8");
        if (!find || !content.includes(find)) {
          return JSON.stringify({ ok: false, error: "find target not present in file" });
        }
        await fsp.writeFile(target, content.replace(find, replace), "utf-8");
        return JSON.stringify({ ok: true, path: rel });
      } catch (error) {
        return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    };

    const stripAssetHashSuffix = (value: string): string => value.replace(/-[0-9a-f]{8}(?=\.[^./\\]+$)/i, "");

    const copyAssetFile = async (args: Record<string, unknown>) => {
      const sourceRaw = typeof args.source === "string" ? args.source : "";
      const toRaw = typeof args.path === "string" ? args.path : "";
      const source = stripAssetHashSuffix(sourceRaw);
      const to = stripAssetHashSuffix(toRaw);
      const root = this.options.assetRoots?.widgetFonts;
      if (!root) {
        return JSON.stringify({ ok: false, error: "Widget font asset root is not configured." });
      }
      try {
        const sourceAbs = path.join(root, path.basename(source));
        const destAbs = this.options.workspacePolicy.resolveWithinRoot(to);
        await fsp.mkdir(path.dirname(destAbs), { recursive: true });
        await fsp.copyFile(sourceAbs, destAbs);
        return JSON.stringify({ ok: true, source, path: to });
      } catch (error) {
        return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    };

    const getSkill = async (args: Record<string, unknown>) => {
      const skillIdRaw = typeof args.skill_id === "string" ? args.skill_id : "";
      if (!isDeferredSkillId(skillIdRaw)) {
        return JSON.stringify({ ok: false, error: `Unknown skill_id: ${skillIdRaw}` });
      }
      const allowed = this.options.skillLibrary?.allowedIds ?? [];
      if (this.options.skillLibrary && !allowed.includes(skillIdRaw)) {
        return JSON.stringify({ ok: false, error: `${skillIdRaw} is unavailable in this session.` });
      }
      if (!this.options.skillLibrary) {
        return JSON.stringify({ ok: false, error: "Skill library is not configured." });
      }
      try {
        const content = readDeferredSkillMarkdown(this.options.skillLibrary.skillsDir, skillIdRaw);
        return JSON.stringify({ ok: true, skill_id: skillIdRaw, content });
      } catch (error) {
        return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    };

    const projectIntake = async (args: Record<string, unknown>) => {
      if (!this.options.hostIntakeToolHandler) {
        return JSON.stringify({ ok: false, error: "Intake handler unavailable." });
      }
      return this.options.hostIntakeToolHandler(args);
    };

    const askQuestion = async (args: Record<string, unknown>) => {
      if (!this.options.hostAskQuestionHandler) {
        return JSON.stringify({ ok: false, error: "Ask-question handler unavailable." });
      }
      return this.options.hostAskQuestionHandler(args);
    };

    const reloadEmulator = async () => {
      if (!this.options.hostReloadEmulatorHandler) {
        return JSON.stringify({ ok: false, error: "reload_emulator handler unavailable." });
      }
      return this.options.hostReloadEmulatorHandler();
    };

    const getEmulatorLogs = async (args: Record<string, unknown>) => {
      const max_lines = typeof args.max_lines === "number" ? Math.floor(args.max_lines) : undefined;
      if (!this.options.hostGetEmulatorLogsHandler) {
        return JSON.stringify({ ok: false, error: "get_emulator_logs handler unavailable." });
      }
      return this.options.hostGetEmulatorLogsHandler({ max_lines });
    };

    const requested = new Set(
      this.completionTools.map((tool) => tool.function?.name).filter((name): name is string => Boolean(name))
    );

    const registry: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
      list_files: listFiles,
      read_file: readFile,
      write_file: writeFile,
      replace_in_file: replaceInFile,
      copy_asset_file: copyAssetFile,
      dartsnut_project_intake: projectIntake,
      dartsnut_ask_question: askQuestion,
      reload_emulator: () => reloadEmulator(),
      get_emulator_logs: getEmulatorLogs,
      get_dartsnut_skill: getSkill
    };

    const handlers: Record<string, (args: Record<string, unknown>) => Promise<string>> = {};
    for (const name of requested) {
      const handler = registry[name];
      if (handler) {
        handlers[name] = handler;
      }
    }
    return handlers;
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

  private ensureSystemMessage(): void {
    const hasSystem = this.conversation.some((m) => m.role === "system");
    if (hasSystem) {
      return;
    }
    const languagePrompt = buildLanguageSystemPrompt(this.options.preferredUserLocale ?? null);
    this.conversation.unshift({
      role: "system",
      content: [
        "You are the Dartsnut coding runtime. Use function tool calls for all tool usage.",
        this.options.skillPrompt,
        languagePrompt
      ].join("\n\n")
    });
  }

  private parseArguments(argumentsJson: string): Record<string, unknown> {
    if (!argumentsJson.trim()) {
      return {};
    }
    try {
      return safeParseObject(JSON.parse(argumentsJson));
    } catch {
      return {};
    }
  }

  private async executeToolCall(call: ParsedToolCall): Promise<string> {
    const handler = this.tools[call.name];
    if (!handler) {
      return JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` });
    }
    const args = this.parseArguments(call.argumentsJson);
    return handler(args);
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

  private persistSessionState(): void {
    const persistence = this.options.sessionPersistence;
    if (!persistence) {
      return;
    }
    const nowIso = new Date().toISOString();
    const manifest = persistence.readManifest();
    persistence.writeManifestAtomic({
      schemaVersion: 1,
      sessionId: this.sessionId,
      createdAt: manifest?.createdAt ?? nowIso,
      updatedAt: nowIso,
      templateMode: this.options.sessionTemplateMode ?? null,
      section: this.options.sessionSection ?? null,
      preferredUserLocale: this.options.preferredUserLocale ?? null
    });
    persistence.saveConversationAtomic(this.conversation);
  }

  private emitToolStatus(
    name: string,
    phase: ToolStatusPhase,
    onEvent: (event: AgentEvent) => void,
    context?: ToolStatusContext
  ): void {
    const formatted = buildToolStatusMessage(name, phase, context);
    const transportMessage = encodeToolStatusForTransport(formatted);
    onEvent({
      type: "status",
      at: Date.now(),
      message: transportMessage
    });
    this.persistTranscript("tool_status", transportMessage);
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
    if (abortSignal?.aborted) throw new Error(AGENT_STOPPED_MESSAGE);
    this.stoppedOnCleanEmulator = false;
    this.ensureSystemMessage();
    this.persistTranscript("user", prompt);
    this.conversation.push({ role: "user", content: prompt });
    this.persistSessionState();

    let finalText = "";
    let sawReasoning = false;
    let sawToolCall = false;
    let verifyStepsAfterArtifactsReady = 0;
    let stepsWithoutArtifactsReady = 0;
    let stepsAfterArtifactsReady = 0;

    onEvent({ type: "status", at: Date.now(), message: "Dartsnut Agent run started." });

    try {
      const profile = runOptions?.toolLoopProfile ?? "default";
      const maxSteps = profile === "modification" ? MODIFICATION_MAX_STEPS : Math.max(12, CREATOR_MAX_STEPS_WITHOUT_ARTIFACTS + 4);
      for (let step = 0; step < maxSteps; step += 1) {
        if (abortSignal?.aborted) {
          throw new Error(AGENT_STOPPED_MESSAGE);
        }

        let stepText = "";
        let stepReasoning = "";
        const completion = await this.provider.complete(this.conversation, {
          tools: this.completionTools,
          abortSignal,
          onChunk: (delta) => {
            stepText += delta;
            finalText += delta;
            onEvent({ type: "stream", at: Date.now(), delta });
          },
          onReasoningChunk: (delta) => {
            if (!delta) {
              return;
            }
            sawReasoning = true;
            stepReasoning += delta;
            onEvent({ type: "reasoning_stream", at: Date.now(), delta });
          }
        });

        const assistantText = completion.content ?? stepText;
        const assistantToolCalls: ToolCallEnvelope[] = completion.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.argumentsJson
          }
        }));
        this.conversation.push({
          role: "assistant",
          content: assistantText,
          ...(assistantToolCalls.length > 0 ? { tool_calls: assistantToolCalls } : {}),
          ...(completion.reasoningContent ? { reasoningContent: completion.reasoningContent } : {})
        });
        if (stepReasoning) {
          this.persistTranscript("thinking", stepReasoning);
        }
        if (assistantText.trim()) {
          this.persistTranscript("assistant", assistantText);
        }
        if (stepReasoning) {
          onEvent({ type: "reasoning_done", at: Date.now() });
        }

        if (completion.toolCalls.length === 0) {
          finalText = assistantText || finalText;
          this.persistSessionState();
          break;
        }

        sawToolCall = true;
        const toolNames: string[] = [];
        let filesWrittenThisTurn = 0;
        for (const call of completion.toolCalls) {
          toolNames.push(call.name);
          if (isFileMutationToolName(call.name)) {
            filesWrittenThisTurn += 1;
          }
          const args = this.parseArguments(call.argumentsJson);
          const pathArg = toRelPath(args.path);
          const sourceArg = toRelPath(args.source);
          let context: ToolStatusContext = {
            callId: call.id,
            path: pathArg,
            source: sourceArg
          };
          if (call.name === "write_file") {
            const nextContent = typeof args.content === "string" ? args.content : "";
            const previousContent = pathArg ? this.readWorkspaceFileIfExists(pathArg) : undefined;
            context = {
              ...context,
              ...computeWriteDiff(previousContent, nextContent)
            };
          } else if (call.name === "replace_in_file") {
            const findText = typeof args.find === "string" ? args.find : "";
            const replaceText = typeof args.replace === "string" ? args.replace : "";
            context = {
              ...context,
              ...computeReplaceDiff(findText, replaceText)
            };
          }
          this.emitToolStatus(call.name, "call", onEvent, context);
          const toolResult = await this.executeToolCall(call);
          this.conversation.push({
            role: "tool",
            tool_call_id: call.id,
            content: toolResult
          });
          this.emitToolStatus(call.name, "result", onEvent, context);
        }

        if (profile === "modification") {
          const modDecision = decideModificationLoopStep({
            step,
            toolCallCount: completion.toolCalls.length
          });
          if (modDecision.type === "complete") {
            onEvent({ type: "status", at: Date.now(), message: modDecision.summary });
            finalText = (assistantText || finalText || modDecision.summary).trim();
            this.persistSessionState();
            break;
          }
        } else {
          const artifacts = readCreatorArtifactStatus(
            (absolutePath) => fs.existsSync(absolutePath),
            (relativePath) => this.options.workspacePolicy.resolveWithinRoot(relativePath)
          );
          const artifactsReady = artifacts.confJson && artifacts.mainPy;
          if (artifactsReady) {
            stepsAfterArtifactsReady += 1;
            const verificationOnly = completion.toolCalls.every((call) =>
              ["read_file", "get_emulator_logs", "get_dartsnut_skill", "list_files", "reload_emulator"].includes(call.name)
            );
            verifyStepsAfterArtifactsReady = verificationOnly ? verifyStepsAfterArtifactsReady + 1 : 0;
          } else {
            stepsWithoutArtifactsReady += 1;
            verifyStepsAfterArtifactsReady = 0;
          }

          const creatorDecision = decideCreatorLoopStep(
            {
              step,
              toolCallCount: completion.toolCalls.length,
              contentChars: assistantText.length,
              reasoningChars: stepReasoning.length,
              filesWrittenThisTurn,
              workspaceHasConfJson: artifacts.confJson,
              workspaceHasMainPy: artifacts.mainPy,
              toolNames,
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
            this.conversation.push({ role: "user", content: creatorDecision.nudgeUser });
            this.persistTranscript("user", creatorDecision.nudgeUser);
          }
          if (creatorDecision.type === "complete") {
            onEvent({ type: "status", at: Date.now(), message: creatorDecision.summary });
            finalText = (assistantText || finalText || creatorDecision.summary).trim();
            this.persistSessionState();
            break;
          }
        }
        this.persistSessionState();
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
    this.persistSessionState();
    return final;
  }
}

