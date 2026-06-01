import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  buildLanguageSystemPrompt,
  transcriptUserBubbleText,
  type AgentEvent,
  type UserLocale
} from "@dartsnut/shared-ipc";
import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";
import {
  AGENT_STOPPED_MESSAGE,
  type ChatMessage,
  type CompletionOptions,
  type CompletionProvider,
  type CompletionResult,
  type ParsedToolCall,
  type ToolCallEnvelope
} from "./providerClient";
import type { DeferredSkillId } from "./skillBundle";
import { DEFERRED_SKILL_IDS, readDeferredSkillMarkdown } from "./skillBundle";
import type { AgentSessionPersistence } from "./agentSessionPersistence";
import { AGENT_SESSION_SCHEMA_VERSION } from "./agentSessionPersistence";
import {
  decideCreatorLoopStep,
  isCreatorTemplateMode,
  isFileMutationToolName,
  readCreatorArtifactStatus
} from "./creatorTurnGuard";
import { decideModificationLoopStep } from "./modificationTurnGuard";
import {
  assessEmulatorVerifyBatch,
  EMULATOR_VERIFY_CLEAN_SUMMARY,
  type EmulatorVerifyBatchState
} from "./emulatorLogHealth";
import { AGENT_TOOL_SCHEMAS } from "./toolSchemas";
import {
  buildStreamingFileToolEnvelope,
  parsePartialFileToolArguments,
  TOOL_ENVELOPE_STREAM_REPLACE,
  type BuildStreamingFileToolEnvelopeOptions
} from "./streamingToolEnvelope";
import {
  createXmlToolUiStreamFilterState,
  filterAssistantUiStreamDelta
} from "./xmlToolCallUiStreamFilter";
import { WorkspacePolicy } from "./workspacePolicy";

/** Cap read_file tool payloads to limit conversation growth and main-thread JSON work. */
const MAX_READ_FILE_TOOL_CHARS = 48_000;

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new Error(AGENT_STOPPED_MESSAGE);
  }
}

function isDeferredSkillId(value: unknown): value is DeferredSkillId {
  return typeof value === "string" && (DEFERRED_SKILL_IDS as readonly string[]).includes(value);
}

type ToolAction =
  | {
    tool: "list_files";
    path?: string;
  }
  | {
    tool: "read_file";
    path: string;
  }
  | {
    tool: "write_file";
    path: string;
    content: string;
  }
  | {
    tool: "replace_in_file";
    path: string;
    find: string;
    replace: string;
  }
  | {
    tool: "copy_asset_file";
    source: string;
    path: string;
  }
  | {
    tool: "dartsnut_project_intake";
    args: Record<string, unknown>;
  }
  | {
    tool: "dartsnut_ask_question";
    args: Record<string, unknown>;
  }
  | {
    tool: "reload_emulator";
  }
  | {
    tool: "get_emulator_logs";
    max_lines?: number;
  }
  | {
    tool: "get_dartsnut_skill";
    skill_id: DeferredSkillId;
  };

function intakeToolSortRank(toolName: string, args?: Record<string, unknown>): number {
  if (toolName === "dartsnut_ask_question") {
    const questionId = args?.question_id;
    if (questionId === "project_type") {
      return 0;
    }
    if (questionId === "widget_display_size") {
      return 2;
    }
    return 4;
  }
  if (toolName === "dartsnut_project_intake") {
    const action = args?.action;
    if (action === "set_project_type") {
      return 1;
    }
    if (action === "set_widget_size") {
      return 3;
    }
    if (action === "read_workspace_conf") {
      return 5;
    }
    return 6;
  }
  return 10;
}

function sortParsedToolCallsForExecution(toolCalls: ParsedToolCall[]): ParsedToolCall[] {
  return [...toolCalls].sort((a, b) => {
    let aArgs: Record<string, unknown> = {};
    let bArgs: Record<string, unknown> = {};
    try {
      aArgs = JSON.parse(a.argumentsJson || "{}") as Record<string, unknown>;
    } catch {
      aArgs = {};
    }
    try {
      bArgs = JSON.parse(b.argumentsJson || "{}") as Record<string, unknown>;
    } catch {
      bArgs = {};
    }
    return intakeToolSortRank(a.name, aArgs) - intakeToolSortRank(b.name, bArgs);
  });
}

function sortToolActionsForExecution(actions: ToolAction[]): ToolAction[] {
  return [...actions].sort((a, b) => {
    const aArgs =
      a.tool === "dartsnut_project_intake" || a.tool === "dartsnut_ask_question" ? a.args : {};
    const bArgs =
      b.tool === "dartsnut_project_intake" || b.tool === "dartsnut_ask_question" ? b.args : {};
    return (
      intakeToolSortRank(a.tool, aArgs as Record<string, unknown>) -
      intakeToolSortRank(b.tool, bArgs as Record<string, unknown>)
    );
  });
}

interface AgentActionEnvelope {
  response?: string;
  actions?: unknown[];
}

interface RuntimeIntakeProgress {
  projectType?: "game" | "widget";
  widgetSize?: string;
  readWorkspaceConf: boolean;
  askedProjectType: boolean;
  askedWidgetSize: boolean;
}

/** Host (Electron main) executes `dartsnut_project_intake`; returns JSON text for the model. */
export type HostIntakeToolHandler = (args: Record<string, unknown>) => Promise<string>;

/** Host (Electron main) executes `dartsnut_ask_question` during creation intake; returns JSON text for the model. */
export type HostAskQuestionHandler = (args: Record<string, unknown>) => Promise<string>;

/** Host (Electron main) reloads the embedded emulator; returns JSON text for the model. */
export type HostReloadEmulatorHandler = () => Promise<string>;

/** Host (Electron main) returns recent emulator Python logs; returns JSON text for the model. */
export type HostGetEmulatorLogsHandler = (args: { max_lines?: number }) => Promise<string>;

/** When set, `get_dartsnut_skill` reads markdown from `skillsDir` for ids in `allowedIds`. */
export interface AgentSkillLibrary {
  skillsDir: string;
  allowedIds: readonly DeferredSkillId[];
}

export interface SessionEngineOptions {
  provider: CompletionProvider;
  workspacePolicy: WorkspacePolicy;
  skillPrompt: string;
  skillLibrary?: AgentSkillLibrary;
  assetRoots?: {
    widgetFonts?: string;
  };
  /** When set, replaces the default {@link AGENT_TOOL_SCHEMAS} on completion requests. */
  completionTools?: ChatCompletionTool[];
  hostIntakeToolHandler?: HostIntakeToolHandler;
  hostAskQuestionHandler?: HostAskQuestionHandler;
  hostReloadEmulatorHandler?: HostReloadEmulatorHandler;
  hostGetEmulatorLogsHandler?: HostGetEmulatorLogsHandler;
  /** Skip the initial `workspacePolicy.resolveWithinRoot(".")` probe (legacy; prefer a real workspace root). */
  skipInitialWorkspaceResolve?: boolean;
  /** When set, rolling chat (user/assistant/tool) is persisted under the workspace and replayed on resume. */
  sessionPersistence?: AgentSessionPersistence;
  /** Stored in session manifest for debugging / fine-tuning metadata. */
  sessionTemplateMode?: string | null;
  sessionSection?: string | null;
  /** Prior turns loaded from disk (or empty); excluded from system prompts. */
  initialConversation?: ChatMessage[];
  /** When true (creation-intake), end the tool loop after host intake fields are recorded. */
  hostIntakeReadyToFinish?: () => boolean;
  /** Sticky response locale for user-visible prose (not routing). */
  preferredUserLocale?: UserLocale | null;
}

export type RunPromptToolLoopProfile = "default" | "modification";

export interface RunPromptOptions {
  toolLoopProfile?: RunPromptToolLoopProfile;
}

export class SessionEngine {
  /** User / assistant / tool messages for this workspace session (excludes system prompts). */
  private rollingConversation: ChatMessage[];
  private stoppedOnCleanEmulator = false;

  constructor(private readonly options: SessionEngineOptions) {
    this.rollingConversation = [...(options.initialConversation ?? [])];
  }

  /** True when the most recent runPrompt ended after a clean reload + emulator log verify. */
  lastRunStoppedOnCleanEmulator(): boolean {
    return this.stoppedOnCleanEmulator;
  }

  private buildSystemMessages(): ChatMessage[] {
    return [
      { role: "system", content: this.options.skillPrompt },
      { role: "system", content: this.buildToolPrompt() },
      {
        role: "system",
        content: buildLanguageSystemPrompt(this.options.preferredUserLocale ?? null)
      }
    ];
  }

  private emitTransaction(record: Record<string, unknown>): void {
    this.options.sessionPersistence?.appendTransaction({ at: Date.now(), ...record });
  }

  private async finalizeWorkspacePersistence(
    messages: ChatMessage[],
    systemSlots: number,
    finalUserVisibleSummary: string
  ): Promise<void> {
    this.rollingConversation = messages.slice(systemSlots);
    const p = this.options.sessionPersistence;
    if (!p) {
      return;
    }
    const nowIso = new Date().toISOString();
    const existing = p.readManifest();
    const sessionId = existing?.sessionId ?? randomUUID();
    const createdAt = existing?.createdAt ?? nowIso;
    p.writeManifestAtomic({
      schemaVersion: AGENT_SESSION_SCHEMA_VERSION,
      sessionId,
      createdAt,
      updatedAt: nowIso,
      templateMode: this.options.sessionTemplateMode ?? null,
      section: this.options.sessionSection ?? null,
      preferredUserLocale: this.options.preferredUserLocale ?? null
    });
    p.saveConversationAtomic(this.rollingConversation);
    const trimmed =
      finalUserVisibleSummary.length > 50_000
        ? `${finalUserVisibleSummary.slice(0, 50_000)}…`
        : finalUserVisibleSummary;
    p.appendTranscript({ kind: "assistant", at: Date.now(), text: trimmed });
    const endArtifacts = this.readCreatorArtifacts();
    p.appendTransaction({
      type: "turn.end",
      at: Date.now(),
      assistantSummaryChars: trimmed.length,
      workspaceHasConfJson: endArtifacts.confJson,
      workspaceHasMainPy: endArtifacts.mainPy
    });
    await p.flushWrites();
  }

  private normalizeAction(rawAction: unknown): ToolAction {
    if (!rawAction || typeof rawAction !== "object") {
      throw new Error("Invalid tool action payload.");
    }
    const action = rawAction as {
      tool?: unknown;
      path?: unknown;
      content?: unknown;
      text?: unknown;
      find?: unknown;
      replace?: unknown;
      source?: unknown;
    };
    const tool = typeof action.tool === "string" ? action.tool : "";
    if (tool === "list_files") {
      return {
        tool: "list_files",
        path: typeof action.path === "string" ? action.path : undefined
      };
    }
    if (tool === "read_file") {
      if (typeof action.path !== "string" || !action.path) {
        throw new Error("read_file action requires a string path.");
      }
      return { tool: "read_file", path: action.path };
    }
    if (tool === "write_file" || tool === "create_file") {
      if (typeof action.path !== "string" || !action.path) {
        throw new Error(`${tool} action requires a string path.`);
      }
      const contentValue =
        typeof action.content === "string"
          ? action.content
          : typeof action.text === "string"
            ? action.text
            : undefined;
      if (typeof contentValue !== "string") {
        throw new Error(`${tool} action requires string content.`);
      }
      return {
        tool: "write_file",
        path: action.path,
        content: contentValue
      };
    }
    if (tool === "copy_asset_file") {
      if (typeof action.source !== "string" || !action.source) {
        throw new Error("copy_asset_file action requires a string source.");
      }
      if (typeof action.path !== "string" || !action.path) {
        throw new Error("copy_asset_file action requires a string path.");
      }
      return {
        tool: "copy_asset_file",
        source: action.source,
        path: action.path
      };
    }
    if (tool === "replace_in_file") {
      if (typeof action.path !== "string" || !action.path) {
        throw new Error("replace_in_file action requires a string path.");
      }
      if (typeof action.find !== "string" || action.find.length === 0) {
        throw new Error("replace_in_file action requires a non-empty string find.");
      }
      if (typeof action.replace !== "string") {
        throw new Error("replace_in_file action requires a string replace.");
      }
      return {
        tool: "replace_in_file",
        path: action.path,
        find: action.find,
        replace: action.replace
      };
    }
    if (tool === "get_dartsnut_skill") {
      const record = action as Record<string, unknown>;
      const skillId = record.skill_id;
      if (!isDeferredSkillId(skillId)) {
        throw new Error("get_dartsnut_skill requires a valid skill_id.");
      }
      return { tool: "get_dartsnut_skill", skill_id: skillId };
    }
    if (tool === "dartsnut_project_intake") {
      const record = action as Record<string, unknown>;
      const { tool: _ignored, ...args } = record;
      if (typeof args.action !== "string" || !args.action) {
        throw new Error("dartsnut_project_intake requires a string action.");
      }
      return { tool: "dartsnut_project_intake", args };
    }
    if (tool === "dartsnut_ask_question") {
      const record = action as Record<string, unknown>;
      const { tool: _ignored, ...args } = record;
      const qid = args.question_id;
      if (qid !== "project_type" && qid !== "widget_display_size") {
        throw new Error(
          "dartsnut_ask_question requires question_id project_type or widget_display_size."
        );
      }
      return { tool: "dartsnut_ask_question", args };
    }
    if (tool === "reload_emulator") {
      return { tool: "reload_emulator" };
    }
    if (tool === "get_emulator_logs") {
      const record = action as Record<string, unknown>;
      const maxLines = record.max_lines;
      return {
        tool: "get_emulator_logs",
        ...(typeof maxLines === "number" && Number.isFinite(maxLines)
          ? { max_lines: maxLines }
          : {})
      };
    }
    throw new Error(`Unsupported tool action: ${tool || "unknown"}`);
  }

  private buildToolPrompt(): string {
    const completionTools = this.options.completionTools ?? AGENT_TOOL_SCHEMAS;
    const names = completionTools.map((t) => (t.type === "function" ? t.function.name : ""));
    const hasIntake = names.includes("dartsnut_project_intake");
    const hasAskQuestion = names.includes("dartsnut_ask_question");
    const hasReload = names.includes("reload_emulator");
    const fileToolLine = `You have native tools available via the API: ${names.filter(Boolean).join(", ")}.`;
    const lines = [
      fileToolLine,
      "Call them through the standard tool_calls mechanism — do not emit JSON envelopes, <tool_call> / <function_calls> XML, or any other text-shaped tool syntax.",
      "Rules:",
      "1) Use workspace-relative paths only.",
      "2) For existing files, prefer replace_in_file over write_file to keep payloads small and fast.",
      "3) Use write_file only when creating a new file or when replace_in_file cannot express the change.",
      "4) Use copy_asset_file for binary assets (fonts/images) instead of read_file/write_file.",
      "5) copy_asset_file strips a trailing -<8 hex> hash before the file extension on both source lookup and destination filenames (e.g. 10x20-ab12cd34.pil -> 10x20.pil).",
      "6) Do not paste full file contents in assistant messages when you will create or edit those files with tools — use tools only.",
      "7) Do not put implementable source code in reasoning/thinking — planning and tradeoffs only; write code with file tools.",
      "8) When you have nothing more to do, reply with a single short status sentence and no tool calls."
    ];
    if (isCreatorTemplateMode(this.options.sessionTemplateMode)) {
      lines[lines.length - 1] =
        "8) Creator builds: finish only after `read_file` on `main.py` confirms the widget/game matches the request.";
      lines.push(
        "Creator editing:",
        "9) `read_file` `main.py` (and `conf.json` when size/config matters) before edits when those files exist.",
        "10) Do not put implementable source code in reasoning — use file tools.",
        "11) Do not end creator work with only skills or reasoning when files still need changes — use file tools or reload+logs to verify. Final round may be a one-sentence status only.",
        "12) **Creator verify run:** after material `conf.json` or `main.py` changes, before declaring done, or when logs show errors — `reload_emulator` then `get_emulator_logs`; fix Traceback/SyntaxError before continuing.",
        "13) **User-provided images:** when the user offers to give/send/provide a picture or sprite (any language), load **`asset-pipeline`**, add or update manifest slots + `slot.draw(...)` as needed, and direct them to the desktop **Assets** pane (**Choose File** → **Apply Assets**) — do **not** ask them to paste the image in chat."
      );
    }
    if (hasIntake) {
      lines.push(
        "Intake: **dartsnut_project_intake** is host-executed — use `set_project_type`, `set_widget_size`, and `read_workspace_conf` (returns `conf.json` status for the active workspace)."
      );
    }
    if (hasAskQuestion) {
      lines.push(
        "Intake UI: **dartsnut_ask_question** is host-executed and **blocking** — it shows Game/Widget chips or widget size chips and returns only after the user answers.",
        "Information-closure loop (run before scaffold/file edits):",
        "A) Check if project type is known; if not, call `dartsnut_ask_question` with `project_type`.",
        "B) If project type is `widget`, check if widget size is known; if not, call `dartsnut_ask_question` with `widget_display_size`.",
        "C) Record known values via `dartsnut_project_intake` (`set_project_type` / `set_widget_size`) and then call `read_workspace_conf`.",
        "D) Only after A-C are satisfied, proceed to implementation/file mutation tools.",
        "If project type is not explicit, ask `project_type` first. If widget size is not explicit, ask `widget_display_size` first.",
        "Do not guess or default these values, and do not call `set_project_type` / `set_widget_size` until that value is known from user text or the blocking question result.",
        "After `read_workspace_conf`, ask at most one focused question when the folder already has a valid `conf.json`, invalid JSON, or a type/size mismatch."
      );
    }
    if (hasReload) {
      lines.push(
        "Global best practice: after material `conf.json` or `main.py` edits, run **reload_emulator** then **get_emulator_logs** before declaring done so preview/deploy state is fresh and Python runtime errors are visible."
      );
    }
    const hasEmulatorLogs = names.includes("get_emulator_logs");
    if (hasEmulatorLogs && !isCreatorTemplateMode(this.options.sessionTemplateMode)) {
      lines.push(
        "Use **get_emulator_logs** after **reload_emulator** to read recent Python stdout/stderr from the embedded emulator."
      );
    }
    return lines.join("\n");
  }

  /** Extract top-level `{ ... }` spans (possibly multiple JSON objects in one reply). */
  private extractTopLevelJsonObjects(raw: string): string[] {
    const spans: string[] = [];
    const text = raw;
    let scan = 0;
    while (scan < text.length) {
      const open = text.indexOf("{", scan);
      if (open === -1) {
        break;
      }
      const endOffset = SessionEngine.scanBalancedJsonObjectEnd(text, open);
      if (endOffset === null) {
        break;
      }
      spans.push(text.slice(open, open + endOffset));
      scan = open + endOffset;
    }
    return spans;
  }

  /** Length from `start` through the matching closing `}` of that object, or null. */
  private static scanBalancedJsonObjectEnd(source: string, start: number): number | null {
    if (source[start] !== "{") {
      return null;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const c = source[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (c === "\\") {
          escaped = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === "{") {
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          return i - start + 1;
        }
      }
    }
    return null;
  }

  private tryParseEnvelope(raw: string): AgentActionEnvelope | null {
    const tryParse = (candidate: string): AgentActionEnvelope | null => {
      try {
        return JSON.parse(candidate) as AgentActionEnvelope;
      } catch {
        return null;
      }
    };

    const direct = tryParse(raw);
    if (direct) {
      return direct;
    }

    const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      const fenced = tryParse(fencedMatch[1].trim());
      if (fenced) {
        return fenced;
      }
    }

    const objects = this.extractTopLevelJsonObjects(raw);
    for (const obj of objects) {
      const envelope = tryParse(obj.trim());
      if (envelope) {
        return envelope;
      }
    }

    return null;
  }

  private tryParseEnvelopesMerged(raw: string): {
    responseText: string;
    rawActions: unknown[];
    originalAssistantPayload: unknown;
  } | null {
    const tryParse = (candidate: string): AgentActionEnvelope | null => {
      try {
        return JSON.parse(candidate) as AgentActionEnvelope;
      } catch {
        return null;
      }
    };

    const envelopes: AgentActionEnvelope[] = [];
    let working = raw;

    const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      working = fencedMatch[1];
    }

    const objectSpans =
      working === raw ? this.extractTopLevelJsonObjects(raw) : this.extractTopLevelJsonObjects(working);

    for (const span of objectSpans) {
      const envelope = tryParse(span.trim());
      if (!envelope) {
        continue;
      }
      if (!("response" in envelope) && !("actions" in envelope)) {
        continue;
      }
      envelopes.push(envelope);
    }

    if (envelopes.length === 0) {
      const single = this.tryParseEnvelope(raw);
      if (single) {
        envelopes.push(single);
      } else {
        const xml = SessionEngine.parseXmlToolCalls(raw);
        if (xml) {
          return {
            responseText: xml.responseText,
            rawActions: xml.rawActions,
            originalAssistantPayload: {
              response: xml.responseText || undefined,
              actions: xml.rawActions
            }
          };
        }
        return null;
      }
    }

    const responseText = envelopes
      .map((e) => e.response)
      .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      .join("\n\n");
    const rawActions = envelopes.flatMap((e) => (Array.isArray(e.actions) ? e.actions : []));

    const originalAssistantPayload =
      envelopes.length === 1 ? envelopes[0] : { response: responseText || undefined, actions: rawActions };

    return {
      responseText,
      rawActions,
      originalAssistantPayload
    };
  }

  private static trimXmlParameterValue(rawValue: string): string {
    return rawValue.replace(/^\r?\n/, "").replace(/\r?\n$/, "").trim();
  }

  private static parseAnthropicStyleToolCallBlocks(
    raw: string,
    rawActions: unknown[]
  ): RegExp | null {
    const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
    const matches = Array.from(raw.matchAll(toolCallRegex));
    if (matches.length === 0) {
      return null;
    }
    for (const match of matches) {
      const inner = match[1] ?? "";
      const fnMatch = inner.match(/<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/i);
      if (!fnMatch) {
        continue;
      }
      const toolName = fnMatch[1].trim();
      const paramsBody = fnMatch[2] ?? "";
      const action: Record<string, string> = { tool: toolName };
      const paramRegex = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/gi;
      for (const pMatch of paramsBody.matchAll(paramRegex)) {
        const key = pMatch[1].trim();
        action[key] = SessionEngine.trimXmlParameterValue(pMatch[2] ?? "");
      }
      rawActions.push(action);
    }
    return toolCallRegex;
  }

  /** Claude / proxy gateways that emit `<function_calls><invoke name="…">` in message text. */
  private static parseClaudeFunctionCallBlocks(
    raw: string,
    rawActions: unknown[]
  ): RegExp | null {
    const functionCallsRegex = /<function_calls>([\s\S]*?)<\/function_calls>/gi;
    const blocks = Array.from(raw.matchAll(functionCallsRegex));
    if (blocks.length === 0) {
      return null;
    }
    const invokeRegex = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/gi;
    for (const block of blocks) {
      const body = block[1] ?? "";
      for (const invoke of body.matchAll(invokeRegex)) {
        const toolName = invoke[1].trim();
        const paramsBody = invoke[2] ?? "";
        const action: Record<string, string> = { tool: toolName };
        const paramRegex = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi;
        for (const pMatch of paramsBody.matchAll(paramRegex)) {
          action[pMatch[1].trim()] = SessionEngine.trimXmlParameterValue(pMatch[2] ?? "");
        }
        rawActions.push(action);
      }
    }
    return functionCallsRegex;
  }

  private static parseXmlToolCalls(raw: string): {
    responseText: string;
    rawActions: unknown[];
  } | null {
    const rawActions: unknown[] = [];
    const anthropicStrip = SessionEngine.parseAnthropicStyleToolCallBlocks(raw, rawActions);
    const claudeStrip = SessionEngine.parseClaudeFunctionCallBlocks(raw, rawActions);

    if (rawActions.length === 0) {
      return null;
    }

    let responseText = raw;
    if (anthropicStrip) {
      responseText = responseText.replace(anthropicStrip, "");
    }
    if (claudeStrip) {
      responseText = responseText.replace(claudeStrip, "");
    }
    return { responseText: responseText.trim(), rawActions };
  }

  /** When the model emits Claude `<function_calls>` XML in `content` with no native `tool_calls`. */
  private static promoteXmlToolCallsInCompletion(completion: CompletionResult): CompletionResult {
    if (completion.toolCalls.length > 0) {
      return {
        ...completion,
        toolCalls: sortParsedToolCallsForExecution(completion.toolCalls)
      };
    }
    const xml = SessionEngine.parseXmlToolCalls(completion.content);
    if (!xml || xml.rawActions.length === 0) {
      return completion;
    }
    const toolCalls: ParsedToolCall[] = [];
    for (let i = 0; i < xml.rawActions.length; i += 1) {
      const raw = xml.rawActions[i];
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const rec = raw as Record<string, string>;
      const name = typeof rec.tool === "string" ? rec.tool.trim() : "";
      if (!name) {
        continue;
      }
      const { tool: _ignored, ...rest } = rec;
      toolCalls.push({
        id: `xml_${i}_${randomUUID().slice(0, 8)}`,
        name,
        argumentsJson: JSON.stringify(rest)
      });
    }
    if (toolCalls.length === 0) {
      return completion;
    }
    return {
      ...completion,
      content: xml.responseText,
      toolCalls: sortParsedToolCallsForExecution(toolCalls)
    };
  }

  private static stripArtifactHashSuffixFromFileName(fileName: string): string {
    let previous = "";
    let current = fileName;
    while (previous !== current) {
      previous = current;
      current = current.replace(/^(.*?)-[0-9a-f]{8}(\.[^./]+)$/i, "$1$2");
    }
    return current;
  }

  private async listFiles(relativePath?: string): Promise<string[]> {
    const root = this.options.workspacePolicy.resolveWithinRoot(relativePath ?? ".");
    const output: string[] = [];
    const stack = [root];
    while (stack.length > 0 && output.length < 200) {
      const current = stack.pop()!;
      const entries = await fsp.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        const rel = path.relative(this.options.workspacePolicy.resolveWithinRoot("."), absolute);
        if (entry.isDirectory()) {
          stack.push(absolute);
        } else {
          output.push(rel);
          if (output.length >= 200) {
            break;
          }
        }
      }
    }
    return output.sort();
  }

  private async executeAction(action: ToolAction): Promise<string> {
    if (action.tool === "dartsnut_project_intake") {
      if (!this.options.hostIntakeToolHandler) {
        throw new Error("dartsnut_project_intake is not enabled for this session.");
      }
      return this.options.hostIntakeToolHandler(action.args);
    }
    if (action.tool === "dartsnut_ask_question") {
      if (!this.options.hostAskQuestionHandler) {
        throw new Error("dartsnut_ask_question is not enabled for this session.");
      }
      return this.options.hostAskQuestionHandler(action.args);
    }
    if (action.tool === "reload_emulator") {
      if (!this.options.hostReloadEmulatorHandler) {
        throw new Error("reload_emulator is not enabled for this session.");
      }
      return this.options.hostReloadEmulatorHandler();
    }
    if (action.tool === "get_emulator_logs") {
      if (!this.options.hostGetEmulatorLogsHandler) {
        throw new Error("get_emulator_logs is not enabled for this session.");
      }
      return this.options.hostGetEmulatorLogsHandler({
        max_lines: action.max_lines
      });
    }
    if (action.tool === "get_dartsnut_skill") {
      const lib = this.options.skillLibrary;
      if (!lib) {
        throw new Error("get_dartsnut_skill requires skillLibrary to be configured.");
      }
      if (!lib.allowedIds.includes(action.skill_id)) {
        return JSON.stringify({
          ok: false,
          error: `Skill "${action.skill_id}" is not enabled for this session. Allowed: ${lib.allowedIds.join(", ")}.`
        });
      }
      const content = readDeferredSkillMarkdown(lib.skillsDir, action.skill_id);
      return JSON.stringify({ ok: true, skill_id: action.skill_id, content });
    }
    if (action.tool === "list_files") {
      const files = await this.listFiles(action.path);
      return JSON.stringify({ ok: true, files });
    }
    if (action.tool === "read_file") {
      const filePath = this.options.workspacePolicy.resolveWithinRoot(action.path);
      let content = await fsp.readFile(filePath, "utf-8");
      let truncated = false;
      if (content.length > MAX_READ_FILE_TOOL_CHARS) {
        const omitted = content.length - MAX_READ_FILE_TOOL_CHARS;
        content = `${content.slice(0, MAX_READ_FILE_TOOL_CHARS)}\n\n[truncated ${omitted} characters; use targeted reads]`;
        truncated = true;
      }
      return JSON.stringify({ ok: true, path: action.path, content, truncated });
    }
    if (action.tool === "write_file") {
      const filePath = this.options.workspacePolicy.resolveWithinRoot(action.path);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, action.content, "utf-8");
      return JSON.stringify({ ok: true, path: action.path, bytes: Buffer.byteLength(action.content) });
    }
    if (action.tool === "replace_in_file") {
      const filePath = this.options.workspacePolicy.resolveWithinRoot(action.path);
      const original = await fsp.readFile(filePath, "utf-8");
      if (!original.includes(action.find)) {
        throw new Error(`replace_in_file could not find target text in ${action.path}`);
      }
      const updated = original.replace(action.find, action.replace);
      await fsp.writeFile(filePath, updated, "utf-8");
      return JSON.stringify({
        ok: true,
        path: action.path,
        replaced: true,
        bytes: Buffer.byteLength(updated)
      });
    }
    const fontsRoot = this.options.assetRoots?.widgetFonts;
    if (!fontsRoot) {
      throw new Error("copy_asset_file is unavailable because widget font assets root is not configured.");
    }
    const normalizedFontsRoot = path.resolve(fontsRoot) + path.sep;
    const sourceBase = path.basename(action.source);
    const sourceCandidates = Array.from(
      new Set([sourceBase, SessionEngine.stripArtifactHashSuffixFromFileName(sourceBase)])
    );

    let resolvedSourcePath: string | null = null;
    let resolvedSourceKey = sourceBase;
    for (const candidate of sourceCandidates) {
      const candidatePath = path.resolve(fontsRoot, candidate);
      if (
        (candidatePath.startsWith(normalizedFontsRoot) || candidatePath === path.resolve(fontsRoot)) &&
        fs.existsSync(candidatePath) &&
        fs.statSync(candidatePath).isFile()
      ) {
        resolvedSourcePath = candidatePath;
        resolvedSourceKey = candidate;
        break;
      }
    }

    if (!resolvedSourcePath) {
      throw new Error(`copy_asset_file source does not exist: ${action.source}`);
    }

    const destRelativeDir = path.dirname(action.path);
    const destCanonicalBase = SessionEngine.stripArtifactHashSuffixFromFileName(path.basename(action.path));
    const destRelative = path.join(destRelativeDir, destCanonicalBase);
    const outputPath = this.options.workspacePolicy.resolveWithinRoot(destRelative);
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.copyFile(resolvedSourcePath, outputPath);
    const stat = await fsp.stat(outputPath);
    return JSON.stringify({
      ok: true,
      source: resolvedSourceKey,
      path: destRelative,
      requestedSource: action.source,
      requestedPath: action.path,
      bytes: stat.size
    });
  }

  private async readPreviousContentForPath(relativePath: string): Promise<string | undefined> {
    try {
      const filePath = this.options.workspacePolicy.resolveWithinRoot(relativePath);
      return await fsp.readFile(filePath, "utf-8");
    } catch {
      return undefined;
    }
  }

  private async readPreviousContent(action: ToolAction): Promise<string | undefined> {
    if (action.tool !== "write_file") {
      return undefined;
    }
    try {
      const filePath = this.options.workspacePolicy.resolveWithinRoot(action.path);
      return await fsp.readFile(filePath, "utf-8");
    } catch {
      return undefined;
    }
  }

  private describeStatusAction(action: ToolAction): string {
    if (action.tool === "list_files") {
      if (typeof action.path === "string" && action.path.length > 0) {
        return `Ran list files in ${action.path}`;
      }
      return "Ran list files";
    }
    if (action.tool === "read_file") {
      return `Ran read file ${action.path}`;
    }
    if (action.tool === "write_file") {
      return `Ran write file ${action.path}`;
    }
    if (action.tool === "replace_in_file") {
      return `Ran replace in file ${action.path}`;
    }
    if (action.tool === "dartsnut_project_intake") {
      const step = typeof action.args.action === "string" ? action.args.action : "intake";
      return `Ran project intake (${step})`;
    }
    if (action.tool === "dartsnut_ask_question") {
      const qid = typeof action.args.question_id === "string" ? action.args.question_id : "";
      return `Asked intake question (${qid || "unknown"})`;
    }
    if (action.tool === "reload_emulator") {
      return "Reloaded emulator";
    }
    if (action.tool === "get_emulator_logs") {
      return "Checked emulator logs";
    }
    if (action.tool === "get_dartsnut_skill") {
      return `Loaded skill ${action.skill_id}`;
    }
    return `Ran copy asset ${action.source} -> ${action.path}`;
  }

  private readRuntimeIntakeProgressFromWorkspace(): RuntimeIntakeProgress {
    try {
      const confPath = this.options.workspacePolicy.resolveWithinRoot("conf.json");
      if (!fs.existsSync(confPath)) {
        return {
          readWorkspaceConf: false,
          askedProjectType: false,
          askedWidgetSize: false
        };
      }
      const parsed = JSON.parse(fs.readFileSync(confPath, "utf-8")) as Record<string, unknown>;
      const projectType = parsed.type === "game" || parsed.type === "widget" ? parsed.type : undefined;
      let widgetSize: string | undefined;
      if (projectType === "widget" && Array.isArray(parsed.size) && parsed.size.length === 2) {
        const w = Number(parsed.size[0]);
        const h = Number(parsed.size[1]);
        if (Number.isFinite(w) && Number.isFinite(h)) {
          widgetSize = `${w}x${h}`;
        }
      }
      return {
        projectType,
        widgetSize,
        readWorkspaceConf: true,
        askedProjectType: Boolean(projectType),
        askedWidgetSize: projectType === "widget" ? Boolean(widgetSize) : false
      };
    } catch {
      return {
        readWorkspaceConf: false,
        askedProjectType: false,
        askedWidgetSize: false
      };
    }
  }

  private gateIntakeSetUntilAsked(
    action: ToolAction,
    intake: RuntimeIntakeProgress
  ): string | null {
    if (action.tool !== "dartsnut_project_intake") {
      return null;
    }
    const actionName = action.args.action;
    if (actionName === "set_project_type" && !intake.projectType && !intake.askedProjectType) {
      return "intake_required: call dartsnut_ask_question(project_type) before set_project_type when type is unknown.";
    }
    if (
      actionName === "set_widget_size" &&
      intake.projectType === "widget" &&
      !intake.widgetSize &&
      !intake.askedWidgetSize
    ) {
      return "intake_required: call dartsnut_ask_question(widget_display_size) before set_widget_size when size is unknown.";
    }
    return null;
  }

  private gateFileMutationUntilIntakeReady(
    action: ToolAction,
    intake: RuntimeIntakeProgress
  ): string | null {
    const completionTools = this.options.completionTools ?? AGENT_TOOL_SCHEMAS;
    const toolNames = completionTools
      .map((t) => (t.type === "function" ? t.function.name : ""))
      .filter(Boolean);
    const intakeFlowAvailable =
      this.options.hostIntakeToolHandler &&
      this.options.hostAskQuestionHandler &&
      toolNames.includes("dartsnut_project_intake") &&
      toolNames.includes("dartsnut_ask_question");
    if (!intakeFlowAvailable) {
      return null;
    }
    if (
      action.tool !== "write_file" &&
      action.tool !== "replace_in_file" &&
      action.tool !== "copy_asset_file"
    ) {
      return null;
    }
    if (!intake.projectType) {
      return "intake_required: call dartsnut_ask_question(project_type) first, or set_project_type only when user text already states game/widget.";
    }
    if (intake.projectType === "widget" && !intake.widgetSize) {
      return "intake_required: widget project needs size. call dartsnut_ask_question(widget_display_size) first, or set_widget_size only when user text already states a supported size.";
    }
    if (!intake.readWorkspaceConf) {
      return "intake_required: call dartsnut_project_intake(read_workspace_conf) before file mutations.";
    }
    return null;
  }

  private updateRuntimeIntakeProgress(
    action: ToolAction,
    result: string,
    intake: RuntimeIntakeProgress
  ): void {
    if (action.tool === "dartsnut_project_intake") {
      const actionName = action.args.action;
      if (actionName === "set_project_type") {
        const pt = action.args.project_type;
        if (pt === "game" || pt === "widget") {
          intake.projectType = pt;
          if (pt === "game") {
            intake.widgetSize = undefined;
          }
        }
      } else if (actionName === "set_widget_size") {
        const sz = action.args.widget_size;
        if (typeof sz === "string" && sz.length > 0) {
          intake.widgetSize = sz;
        }
      } else if (actionName === "read_workspace_conf") {
        intake.readWorkspaceConf = true;
      }
    }
    if (action.tool === "dartsnut_ask_question") {
      const qid = action.args.question_id;
      if (qid === "project_type") {
        intake.askedProjectType = true;
      } else if (qid === "widget_display_size") {
        intake.askedWidgetSize = true;
      }
    }
    if (action.tool !== "dartsnut_ask_question" && action.tool !== "dartsnut_project_intake") {
      return;
    }
    try {
      const parsed = JSON.parse(result) as {
        recorded?: { projectType?: unknown; widgetSize?: unknown };
        creator_hints?: { projectType?: unknown; widgetSize?: unknown };
      };
      const recordedProjectType = parsed.recorded?.projectType ?? parsed.creator_hints?.projectType;
      if (recordedProjectType === "game" || recordedProjectType === "widget") {
        intake.projectType = recordedProjectType;
        if (recordedProjectType === "game") {
          intake.widgetSize = undefined;
        }
      }
      const recordedWidgetSize = parsed.recorded?.widgetSize ?? parsed.creator_hints?.widgetSize;
      if (typeof recordedWidgetSize === "string" && recordedWidgetSize.length > 0) {
        intake.widgetSize = recordedWidgetSize;
      }
    } catch {
      // Ignore malformed host tool JSON; explicit action args still update state.
    }
  }

  /** Widget/game creator flows need read→edit→verify rounds but should not run unbounded. */
  private static readonly DEFAULT_TOOL_LOOP_MAX = 128;
  private static readonly CREATOR_TOOL_LOOP_MAX = 48;
  private static readonly INTAKE_TOOL_LOOP_MAX = 12;
  private static readonly MODIFICATION_TOOL_LOOP_MAX = 8;

  private resolveToolLoopMax(runOptions?: RunPromptOptions): number {
    const raw = process.env.AGENT_TOOL_LOOP_MAX;
    let cap = SessionEngine.DEFAULT_TOOL_LOOP_MAX;
    if (raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) {
        cap = Math.min(128, Math.max(1, Math.floor(n)));
      }
    }
    if (runOptions?.toolLoopProfile === "modification") {
      return Math.min(cap, SessionEngine.MODIFICATION_TOOL_LOOP_MAX);
    }
    if (this.options.sessionSection === "creation-intake") {
      return Math.min(cap, SessionEngine.INTAKE_TOOL_LOOP_MAX);
    }
    if (isCreatorTemplateMode(this.options.sessionTemplateMode)) {
      return Math.min(cap, SessionEngine.CREATOR_TOOL_LOOP_MAX);
    }
    return cap;
  }

  private readCreatorArtifacts(): { confJson: boolean; mainPy: boolean } {
    return readCreatorArtifactStatus(
      fs.existsSync.bind(fs),
      (relativePath) => this.options.workspacePolicy.resolveWithinRoot(relativePath)
    );
  }

  private creatorNeedsScaffold(artifactStatus: { confJson: boolean }): boolean {
    return isCreatorTemplateMode(this.options.sessionTemplateMode) && !artifactStatus.confJson;
  }

  private static readonly CREATOR_SCAFFOLD_NUDGE =
    "The workspace has no conf.json yet. Call get_dartsnut_skill for karpathy-guidelines, creator-incremental, conf-contract, and pydartsnut-core, then write_file for conf.json and main.py. Do not reply with prose only — use tools.";

  private static readonly MAX_CREATOR_SCAFFOLD_NUDGES = 6;

  /** Cap assistant stream forwarded to UI during creator (avoids 10k+ JSON prose freezing the timeline). */
  private static readonly CREATOR_STREAM_UI_CAP = 2_500;

  private pushCreatorScaffoldNudge(
    messages: ChatMessage[],
    onEvent: (event: AgentEvent) => void
  ): void {
    onEvent({
      type: "status",
      message: "Scaffolding widget files (conf.json, main.py)…",
      at: Date.now()
    });
    messages.push({ role: "user", content: SessionEngine.CREATOR_SCAFFOLD_NUDGE });
  }

  private bumpCreatorStepsWithoutConfJson(counter: { value: number }): void {
    if (!isCreatorTemplateMode(this.options.sessionTemplateMode)) {
      return;
    }
    const artifacts = this.readCreatorArtifacts();
    const artifactsReady = artifacts.confJson && artifacts.mainPy;
    if (!artifactsReady) {
      counter.value += 1;
    } else {
      counter.value = 0;
    }
  }

  private emitTurnCompletionStats(
    correlationId: string,
    step: number,
    stats: {
      toolCallCount: number;
      reasoningChars: number;
      filesWrittenThisTurn: number;
      workspaceHasConfJson: boolean;
      workspaceHasMainPy: boolean;
    }
  ): void {
    this.emitTransaction({
      type: "turn.completion_stats",
      correlationId,
      step,
      ...stats
    });
  }

  private async tryCompleteOnCleanEmulatorVerify(
    outcomes: Array<{ toolCall: ParsedToolCall; result: string }>,
    emulatorVerifyState: EmulatorVerifyBatchState,
    artifactStatus: { confJson: boolean; mainPy: boolean },
    runOptions: RunPromptOptions | undefined,
    turnCorrelationId: string,
    step: number,
    messages: ChatMessage[],
    systemSlots: number,
    onEvent: (event: AgentEvent) => void
  ): Promise<string | null> {
    const batch = assessEmulatorVerifyBatch(outcomes, emulatorVerifyState);
    emulatorVerifyState.reloadPending = batch.reloadPending;
    if (!batch.cleanVerifyAfterReload) {
      return null;
    }

    const isModification = runOptions?.toolLoopProfile === "modification";
    const isCreator = isCreatorTemplateMode(this.options.sessionTemplateMode);
    const artifactsReady = artifactStatus.confJson && artifactStatus.mainPy;
    if (!isModification && !(isCreator && artifactsReady)) {
      return null;
    }

    this.stoppedOnCleanEmulator = true;
    this.emitTransaction({
      type: "emulator.verify_clean",
      correlationId: turnCorrelationId,
      step
    });
    onEvent({
      type: "status",
      message: "Emulator reload verified — no runtime errors in logs.",
      at: Date.now()
    });
    onEvent({ type: "final", content: EMULATOR_VERIFY_CLEAN_SUMMARY, at: Date.now() });
    await this.finalizeWorkspacePersistence(messages, systemSlots, EMULATOR_VERIFY_CLEAN_SUMMARY);
    return EMULATOR_VERIFY_CLEAN_SUMMARY;
  }

  private async buildFileToolEnvelopeJson(
    toolCalls: ParsedToolCall[],
    responseLead: string,
    options: BuildStreamingFileToolEnvelopeOptions
  ): Promise<string | null> {
    if (!options.includePreviousContent) {
      return buildStreamingFileToolEnvelope(toolCalls, responseLead);
    }
    const previousByPath = new Map<string, string>();
    for (const toolCall of toolCalls) {
      if (toolCall.name !== "write_file") {
        continue;
      }
      const partial = parsePartialFileToolArguments(toolCall.name, toolCall.argumentsJson);
      if (!partial?.path) {
        continue;
      }
      const previous = await this.readPreviousContentForPath(partial.path);
      if (previous !== undefined) {
        previousByPath.set(partial.path, previous);
      }
    }
    return buildStreamingFileToolEnvelope(
      toolCalls,
      responseLead,
      (relativePath) => previousByPath.get(relativePath),
      { includePreviousContent: true }
    );
  }

  private async buildUiEnvelopeString(actions: ToolAction[], responseText: string): Promise<string | null> {
    const trimmedResponse = responseText.trim();
    if (actions.length === 0 && trimmedResponse.length === 0) {
      return null;
    }
    const uiActions = await Promise.all(
      actions.map(async (action) => {
        if (action.tool !== "write_file") {
          return action;
        }
        return {
          ...action,
          previousContent: await this.readPreviousContent(action)
        };
      })
    );
    const writeCount = actions.filter((action) => action.tool === "write_file").length;
    let uiResponse: string | undefined;
    if (trimmedResponse.length > 0) {
      uiResponse = responseText;
    } else if (writeCount > 0) {
      uiResponse = `Applying ${writeCount} file update(s).`;
    } else if (actions.length > 0) {
      uiResponse = "Executing requested tool actions.";
    }
    return JSON.stringify(
      {
        response: uiResponse,
        actions: uiActions
      },
      null,
      2
    );
  }

  private async emitUiEnvelope(
    actions: ToolAction[],
    responseText: string,
    onEvent: (event: AgentEvent) => void
  ): Promise<void> {
    const uiEnvelope = await this.buildUiEnvelopeString(actions, responseText);
    if (!uiEnvelope) {
      return;
    }
    onEvent({ type: "final", content: uiEnvelope, at: Date.now() });
  }

  private streamNativeToolEnvelopePreview(
    leadContent: string,
    envelopeJson: string,
    onEvent: (event: AgentEvent) => void
  ): void {
    const lead = leadContent.trimEnd();
    const tail = lead.length > 0 ? `\n\n${envelopeJson}` : envelopeJson;
    onEvent({
      type: "stream",
      delta: `${TOOL_ENVELOPE_STREAM_REPLACE}${tail}`,
      at: Date.now()
    });
    onEvent({ type: "final", content: "", at: Date.now() });
  }

  private async finalizeNativeFileToolPreview(
    completion: CompletionResult,
    liveToolEnvelopeStreamed: { count: number; lastTail?: string },
    onEvent: (event: AgentEvent) => void
  ): Promise<void> {
    const hasFileMutation = completion.toolCalls.some(
      (toolCall) => toolCall.name === "write_file" || toolCall.name === "replace_in_file"
    );
    if (!hasFileMutation) {
      return;
    }
    if (liveToolEnvelopeStreamed.count > 0) {
      // Renderer already has the streamed envelope; end streaming without replacing text.
      onEvent({ type: "final", content: "", at: Date.now() });
      return;
    }
    const previewEnvelope = await this.buildFileToolEnvelopeJson(completion.toolCalls, completion.content, {
      includePreviousContent: true
    });
    if (!previewEnvelope) {
      return;
    }
    this.streamNativeToolEnvelopePreview(completion.content, previewEnvelope, onEvent);
  }

  /** Max prior file size embedded in live write_file preview envelopes. */
  private static readonly LIVE_PREVIOUS_CONTENT_MAX_BYTES = 256 * 1024;

  private cacheLivePreviousContentForToolCalls(
    toolCalls: ParsedToolCall[],
    cache: Map<string, string>
  ): void {
    for (const toolCall of toolCalls) {
      if (toolCall.name !== "write_file") {
        continue;
      }
      const partial = parsePartialFileToolArguments(toolCall.name, toolCall.argumentsJson);
      if (!partial?.path || cache.has(partial.path)) {
        continue;
      }
      try {
        const filePath = this.options.workspacePolicy.resolveWithinRoot(partial.path);
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > SessionEngine.LIVE_PREVIOUS_CONTENT_MAX_BYTES) {
          continue;
        }
        cache.set(partial.path, fs.readFileSync(filePath, "utf-8"));
      } catch {
        // New file or unreadable path — no previousContent for preview.
      }
    }
  }

  private emitLiveFileToolEnvelopeProgress(
    toolCalls: ParsedToolCall[],
    responseLead: string,
    streamedChars: { count: number; lastTail?: string },
    livePreviousByPath: Map<string, string>,
    onEvent: (event: AgentEvent) => void
  ): boolean {
    const envelopeOptions: BuildStreamingFileToolEnvelopeOptions | undefined =
      livePreviousByPath.size > 0 ? { includePreviousContent: true } : undefined;
    const envelope = buildStreamingFileToolEnvelope(
      toolCalls,
      responseLead,
      (relativePath) => livePreviousByPath.get(relativePath),
      envelopeOptions
    );
    if (!envelope) {
      return false;
    }
    const trimmedLead = responseLead.trimEnd();
    const tail = trimmedLead.length > 0 ? `\n\n${envelope}` : envelope;
    if (streamedChars.count > 0 && streamedChars.lastTail === tail) {
      return true;
    }
    onEvent({
      type: "stream",
      delta: `${TOOL_ENVELOPE_STREAM_REPLACE}${tail}`,
      at: Date.now()
    });
    streamedChars.count = envelope.length;
    streamedChars.lastTail = tail;
    return true;
  }

  private rawActionFromToolCall(toolCall: ParsedToolCall): unknown {
    const argumentsText = toolCall.argumentsJson.length > 0 ? toolCall.argumentsJson : "{}";
    const parsedArgs: unknown = JSON.parse(argumentsText);
    if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
      throw new Error("Tool arguments must be a JSON object.");
    }
    return { tool: toolCall.name, ...(parsedArgs as Record<string, unknown>) };
  }

  private async processNativeToolCalls(
    completion: CompletionResult,
    runtimeIntake: RuntimeIntakeProgress,
    abortSignal?: AbortSignal
  ): Promise<{
    assistantMessage: ChatMessage;
    toolMessages: ChatMessage[];
    successfulActions: ToolAction[];
    outcomes: Array<{
      toolCall: ParsedToolCall;
      action: ToolAction | null;
      result: string;
    }>;
  }> {
    const outcomes: Array<{
      toolCall: ParsedToolCall;
      action: ToolAction | null;
      result: string;
    }> = [];

    const orderedCalls = sortParsedToolCallsForExecution(completion.toolCalls);
    for (const toolCall of orderedCalls) {
      throwIfAborted(abortSignal);
      let action: ToolAction | null = null;
      let result: string;
      try {
        const rawAction = this.rawActionFromToolCall(toolCall);
        action = this.normalizeAction(rawAction);
        const intakeBlock = this.gateFileMutationUntilIntakeReady(action, runtimeIntake);
        const intakeSetBlock = this.gateIntakeSetUntilAsked(action, runtimeIntake);
        if (intakeSetBlock) {
          result = JSON.stringify({ ok: false, error: intakeSetBlock });
        } else if (intakeBlock) {
          result = JSON.stringify({ ok: false, error: intakeBlock });
        } else {
          result = await this.executeAction(action);
        }
      } catch (error) {
        if (error instanceof Error && error.message === AGENT_STOPPED_MESSAGE) {
          throw error;
        }
        const message = error instanceof Error ? error.message : "Unknown tool error";
        result = JSON.stringify({ ok: false, error: message });
      }
      if (action) {
        this.updateRuntimeIntakeProgress(action, result, runtimeIntake);
      }
      outcomes.push({ toolCall, action, result });
    }

    const successfulActions = outcomes
      .map((outcome) => outcome.action)
      .filter(
        (value): value is ToolAction =>
          value !== null &&
          value.tool !== "dartsnut_project_intake" &&
          value.tool !== "dartsnut_ask_question" &&
          value.tool !== "reload_emulator" &&
          value.tool !== "get_emulator_logs" &&
          value.tool !== "get_dartsnut_skill"
      );

    const assistantToolCalls: ToolCallEnvelope[] = orderedCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: { name: toolCall.name, arguments: toolCall.argumentsJson }
    }));
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: completion.content,
      tool_calls: assistantToolCalls,
      ...(completion.reasoningContent !== undefined
        ? { reasoningContent: completion.reasoningContent }
        : {})
    };
    const toolMessages: ChatMessage[] = outcomes.map((outcome) => ({
      role: "tool",
      tool_call_id: outcome.toolCall.id,
      content: outcome.result
    }));

    return { assistantMessage, toolMessages, successfulActions, outcomes };
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

    this.stoppedOnCleanEmulator = false;

    const completionTools = this.options.completionTools ?? AGENT_TOOL_SCHEMAS;

    const systemMessages = this.buildSystemMessages();
    const systemSlots = systemMessages.length;
    const messages: ChatMessage[] = [
      ...systemMessages,
      ...this.rollingConversation,
      { role: "user", content: prompt }
    ];

    const turnCorrelationId = randomUUID();
    this.emitTransaction({
      type: "turn.start",
      correlationId: turnCorrelationId,
      promptChars: prompt.length,
      rollingMessages: this.rollingConversation.length
    });
    const p = this.options.sessionPersistence;
    if (p) {
      p.ensureDir();
      const forTranscript = transcriptUserBubbleText(prompt);
      if (forTranscript != null) {
        const userLine =
          forTranscript.length > 50_000 ? `${forTranscript.slice(0, 50_000)}…` : forTranscript;
        p.appendTranscript({ kind: "user", at: Date.now(), text: userLine });
      }
    }

    const maxToolRounds = this.resolveToolLoopMax(runOptions);
    let verifyStepsSinceArtifactsReady = 0;
    let stepsAfterArtifactsReady = 0;
    let creatorStallNudgeUsed = false;
    let creatorScaffoldNudgeCount = 0;
    const creatorStepsWithoutConf = { value: 0 };
    const runtimeIntake = this.readRuntimeIntakeProgressFromWorkspace();
    const emulatorVerifyState: EmulatorVerifyBatchState = { reloadPending: false };

    for (let step = 0; step < maxToolRounds; step += 1) {
      let filesWrittenThisCompletion = 0;
      throwIfAborted(abortSignal);
      this.emitTransaction({
        type: "completion.request",
        correlationId: turnCorrelationId,
        step,
        messageCount: messages.length
      });

      let reasoningChunkEvents = 0;
      const liveToolEnvelopeStreamed: { count: number; lastTail?: string } = { count: 0 };
      const livePreviousByPath = new Map<string, string>();
      let assistantStreamContent = "";
      const uiXmlStreamFilter = createXmlToolUiStreamFilterState();
      const creatorStreamMode = isCreatorTemplateMode(this.options.sessionTemplateMode);
      let creatorStreamToUiChars = 0;
      let creatorStreamTruncationNotified = false;
      const completionRaw = await this.options.provider.complete(messages, {
        tools: completionTools,
        abortSignal,
        onChunk: (delta) => {
          assistantStreamContent += delta;
          const uiDelta = filterAssistantUiStreamDelta(uiXmlStreamFilter, delta);
          if (uiDelta.length === 0) {
            return;
          }
          if (creatorStreamMode) {
            if (creatorStreamToUiChars >= SessionEngine.CREATOR_STREAM_UI_CAP) {
              if (!creatorStreamTruncationNotified) {
                creatorStreamTruncationNotified = true;
                onEvent({
                  type: "status",
                  message: "Creator still working (long model output hidden in chat)…",
                  at: Date.now()
                });
              }
              return;
            }
            const remain = SessionEngine.CREATOR_STREAM_UI_CAP - creatorStreamToUiChars;
            const slice = uiDelta.length <= remain ? uiDelta : uiDelta.slice(0, remain);
            creatorStreamToUiChars += slice.length;
            if (slice.length > 0) {
              onEvent({ type: "stream", delta: slice, at: Date.now() });
            }
            return;
          }
          onEvent({ type: "stream", delta: uiDelta, at: Date.now() });
        },
        onReasoningChunk: (delta) => {
          if (delta.length > 0) {
            reasoningChunkEvents += 1;
          }
          onEvent({ type: "reasoning_stream", delta, at: Date.now() });
        },
        onToolCallProgress: (toolCalls) => {
          this.cacheLivePreviousContentForToolCalls(toolCalls, livePreviousByPath);
          this.emitLiveFileToolEnvelopeProgress(
            toolCalls,
            assistantStreamContent,
            liveToolEnvelopeStreamed,
            livePreviousByPath,
            onEvent
          );
        }
      });
      const completion = SessionEngine.promoteXmlToolCallsInCompletion(completionRaw);

      const reasoningTrimmed = completion.reasoningContent?.trim() ?? "";
      if (reasoningTrimmed.length > 0) {
        const forTranscript =
          reasoningTrimmed.length > 50_000
            ? `${reasoningTrimmed.slice(0, 50_000)}…`
            : reasoningTrimmed;
        p?.appendTranscript({ kind: "thinking", at: Date.now(), text: forTranscript });
      }
      onEvent({ type: "reasoning_done", at: Date.now() });

      const artifactStatus = this.readCreatorArtifacts();
      this.emitTransaction({
        type: "completion.response",
        correlationId: turnCorrelationId,
        step,
        toolCallCount: completion.toolCalls.length,
        contentLength: completion.content.length,
        reasoningChars: reasoningTrimmed.length,
        reasoningChunkEvents,
        reasoningHttpStream: completion.usedHttpStream === true,
        filesWrittenThisTurn: filesWrittenThisCompletion,
        workspaceHasConfJson: artifactStatus.confJson,
        workspaceHasMainPy: artifactStatus.mainPy
      });
      this.emitTurnCompletionStats(turnCorrelationId, step, {
        toolCallCount: completion.toolCalls.length,
        reasoningChars: reasoningTrimmed.length,
        filesWrittenThisTurn: filesWrittenThisCompletion,
        workspaceHasConfJson: artifactStatus.confJson,
        workspaceHasMainPy: artifactStatus.mainPy
      });

      if (isCreatorTemplateMode(this.options.sessionTemplateMode)) {
        const artifactsReady = artifactStatus.confJson && artifactStatus.mainPy;
        if (artifactsReady) {
          stepsAfterArtifactsReady += 1;
          if (completion.toolCalls.length > 0) {
            verifyStepsSinceArtifactsReady += 1;
          }
        } else {
          verifyStepsSinceArtifactsReady = 0;
          stepsAfterArtifactsReady = 0;
        }
        const loopDecision = decideCreatorLoopStep(
          {
            step,
            toolCallCount: completion.toolCalls.length,
            contentChars: completion.content.length,
            reasoningChars: reasoningTrimmed.length,
            filesWrittenThisTurn: filesWrittenThisCompletion,
            workspaceHasConfJson: artifactStatus.confJson,
            workspaceHasMainPy: artifactStatus.mainPy,
            toolNames: completion.toolCalls.map((tc) => tc.name),
            stepsAfterArtifactsReady
          },
          verifyStepsSinceArtifactsReady,
          creatorStepsWithoutConf.value
        );
        if (loopDecision.type === "fail") {
          this.emitTransaction({
            type: "creator.incomplete_turn",
            correlationId: turnCorrelationId,
            step,
            reason: loopDecision.reason,
            stepsWithoutConfJson: creatorStepsWithoutConf.value
          });
          onEvent({ type: "error", message: loopDecision.message, at: Date.now() });
          await this.finalizeWorkspacePersistence(messages, systemSlots, loopDecision.message);
          return loopDecision.message;
        }
        if (loopDecision.type === "complete") {
          const summary =
            completion.content.trim().length > 0 ? completion.content.trim() : loopDecision.summary;
          onEvent({ type: "final", content: summary, at: Date.now() });
          await this.finalizeWorkspacePersistence(messages, systemSlots, summary);
          return summary;
        }
        if (loopDecision.type === "stall_turn") {
          this.emitTransaction({
            type: "creator.stall_turn",
            correlationId: turnCorrelationId,
            step,
            reason: loopDecision.reason,
            reasoningChars: reasoningTrimmed.length,
            workspaceHasConfJson: artifactStatus.confJson,
            workspaceHasMainPy: artifactStatus.mainPy
          });
          if (!creatorStallNudgeUsed) {
            creatorStallNudgeUsed = true;
            onEvent({
              type: "status",
              message: "Long reply without file tools — nudging creator to write files…",
              at: Date.now()
            });
            messages.push({ role: "user", content: loopDecision.nudgeUser });
            this.bumpCreatorStepsWithoutConfJson(creatorStepsWithoutConf);
            continue;
          }
          if (this.creatorNeedsScaffold(artifactStatus)) {
            creatorScaffoldNudgeCount += 1;
            if (creatorScaffoldNudgeCount > SessionEngine.MAX_CREATOR_SCAFFOLD_NUDGES) {
              const failMsg =
                "Creator could not scaffold conf.json after repeated prose-only replies.";
              this.emitTransaction({
                type: "creator.incomplete_turn",
                correlationId: turnCorrelationId,
                step,
                reason: "prose_stall_nudge_exhausted",
                scaffoldNudges: creatorScaffoldNudgeCount
              });
              onEvent({ type: "error", message: failMsg, at: Date.now() });
              await this.finalizeWorkspacePersistence(messages, systemSlots, failMsg);
              return failMsg;
            }
            this.pushCreatorScaffoldNudge(messages, onEvent);
            this.bumpCreatorStepsWithoutConfJson(creatorStepsWithoutConf);
            continue;
          }
        }
      }

      if (runOptions?.toolLoopProfile === "modification") {
        const modDecision = decideModificationLoopStep({
          step,
          toolCallCount: completion.toolCalls.length
        });
        if (modDecision.type === "complete") {
          const summary =
            completion.content.trim().length > 0 ? completion.content.trim() : modDecision.summary;
          onEvent({ type: "final", content: summary, at: Date.now() });
          await this.finalizeWorkspacePersistence(messages, systemSlots, summary);
          return summary;
        }
      }

      if (completion.toolCalls.length > 0) {
        throwIfAborted(abortSignal);
        await this.finalizeNativeFileToolPreview(completion, liveToolEnvelopeStreamed, onEvent);
        const { assistantMessage, toolMessages, successfulActions, outcomes } =
          await this.processNativeToolCalls(completion, runtimeIntake, abortSignal);
        for (const outcome of outcomes) {
          if (outcome.action && isFileMutationToolName(outcome.toolCall.name)) {
            filesWrittenThisCompletion += 1;
          }
        }
        const envelope = await this.buildUiEnvelopeString(successfulActions, completion.content);
        const hasFileWritePreview = successfulActions.some(
          (action) => action.tool === "write_file" || action.tool === "replace_in_file"
        );
        if (envelope && !hasFileWritePreview) {
          this.streamNativeToolEnvelopePreview(completion.content, envelope, onEvent);
        }
        for (const outcome of outcomes) {
          this.emitTransaction({
            type: "tool.call",
            correlationId: turnCorrelationId,
            id: outcome.toolCall.id,
            name: outcome.toolCall.name,
            argsChars: outcome.toolCall.argumentsJson.length
          });
          this.emitTransaction({
            type: "tool.result",
            correlationId: turnCorrelationId,
            id: outcome.toolCall.id,
            name: outcome.toolCall.name,
            resultChars: outcome.result.length
          });
          if (outcome.action) {
            const statusMessage = this.describeStatusAction(outcome.action);
            onEvent({
              type: "status",
              message: statusMessage,
              at: Date.now()
            });
            p?.appendTranscript({
              kind: "tool_status",
              at: Date.now(),
              text: statusMessage,
              toolName: outcome.toolCall.name
            });
          }
        }
        messages.push(assistantMessage);
        for (const toolMessage of toolMessages) {
          messages.push(toolMessage);
        }
        if (
          this.options.sessionSection === "creation-intake" &&
          this.options.hostIntakeReadyToFinish?.()
        ) {
          const summary =
            completion.content.trim().length > 0
              ? completion.content.trim()
              : "Intake complete. Creator phase will run next.";
          onEvent({ type: "final", content: summary, at: Date.now() });
          await this.finalizeWorkspacePersistence(messages, systemSlots, summary);
          return summary;
        }
        const cleanVerifySummary = await this.tryCompleteOnCleanEmulatorVerify(
          outcomes,
          emulatorVerifyState,
          artifactStatus,
          runOptions,
          turnCorrelationId,
          step,
          messages,
          systemSlots,
          onEvent
        );
        if (cleanVerifySummary) {
          return cleanVerifySummary;
        }
        this.bumpCreatorStepsWithoutConfJson(creatorStepsWithoutConf);
        continue;
      }

      const merged = this.tryParseEnvelopesMerged(completion.content);

      if (!merged) {
        if (this.creatorNeedsScaffold(artifactStatus) && completion.toolCalls.length === 0) {
          creatorScaffoldNudgeCount += 1;
          if (creatorScaffoldNudgeCount > SessionEngine.MAX_CREATOR_SCAFFOLD_NUDGES) {
            const failMsg =
              "Creator could not scaffold conf.json after repeated tool-free replies.";
            this.emitTransaction({
              type: "creator.incomplete_turn",
              correlationId: turnCorrelationId,
              step,
              reason: "scaffold_nudge_exhausted",
              scaffoldNudges: creatorScaffoldNudgeCount
            });
            onEvent({ type: "error", message: failMsg, at: Date.now() });
            await this.finalizeWorkspacePersistence(messages, systemSlots, failMsg);
            return failMsg;
          }
          this.pushCreatorScaffoldNudge(messages, onEvent);
          this.bumpCreatorStepsWithoutConfJson(creatorStepsWithoutConf);
          continue;
        }
        onEvent({ type: "final", content: completion.content, at: Date.now() });
        await this.finalizeWorkspacePersistence(messages, systemSlots, completion.content);
        return completion.content;
      }

      const actions: ToolAction[] = [];
      for (const rawAction of merged.rawActions) {
        try {
          actions.push(this.normalizeAction(rawAction));
        } catch {
          // Omit invalid entries; malformed tool payloads cannot be executed reliably.
        }
      }

      if (actions.length === 0) {
        if (this.creatorNeedsScaffold(artifactStatus)) {
          creatorScaffoldNudgeCount += 1;
          if (creatorScaffoldNudgeCount > SessionEngine.MAX_CREATOR_SCAFFOLD_NUDGES) {
            const failMsg =
              "Creator could not scaffold conf.json after repeated empty action envelopes.";
            this.emitTransaction({
              type: "creator.incomplete_turn",
              correlationId: turnCorrelationId,
              step,
              reason: "scaffold_nudge_exhausted",
              scaffoldNudges: creatorScaffoldNudgeCount
            });
            onEvent({ type: "error", message: failMsg, at: Date.now() });
            await this.finalizeWorkspacePersistence(messages, systemSlots, failMsg);
            return failMsg;
          }
          this.pushCreatorScaffoldNudge(messages, onEvent);
          this.bumpCreatorStepsWithoutConfJson(creatorStepsWithoutConf);
          continue;
        }
        const finalText = merged.responseText || "Done.";
        onEvent({ type: "final", content: finalText, at: Date.now() });
        await this.finalizeWorkspacePersistence(messages, systemSlots, finalText);
        return finalText;
      }

      const orderedActions = sortToolActionsForExecution(actions);

      throwIfAborted(abortSignal);
      await this.emitUiEnvelope(orderedActions, merged.responseText, onEvent);

      for (const action of orderedActions) {
        if (isFileMutationToolName(action.tool)) {
          filesWrittenThisCompletion += 1;
        }
        onEvent({
          type: "status",
          message: this.describeStatusAction(action),
          at: Date.now()
        });
        const toolName = action.tool;
        p?.appendTranscript({
          kind: "tool_status",
          at: Date.now(),
          text: this.describeStatusAction(action),
          toolName
        });
        this.emitTransaction({
          type: "tool.call",
          correlationId: turnCorrelationId,
          name: toolName,
          synthetic: true
        });
      }

      const toolResults: Array<{ action: ToolAction; result: string }> = [];
      for (const action of actions) {
        throwIfAborted(abortSignal);
        try {
          const intakeBlock = this.gateFileMutationUntilIntakeReady(action, runtimeIntake);
          const intakeSetBlock = this.gateIntakeSetUntilAsked(action, runtimeIntake);
          const result = intakeSetBlock
            ? JSON.stringify({ ok: false, error: intakeSetBlock })
            : intakeBlock
              ? JSON.stringify({ ok: false, error: intakeBlock })
              : await this.executeAction(action);
          toolResults.push({ action, result });
        } catch (error) {
          if (error instanceof Error && error.message === AGENT_STOPPED_MESSAGE) {
            throw error;
          }
          const message = error instanceof Error ? error.message : "Unknown tool error";
          toolResults.push({ action, result: JSON.stringify({ ok: false, error: message }) });
        }
      }
      for (const row of toolResults) {
        this.updateRuntimeIntakeProgress(row.action, row.result, runtimeIntake);
      }

      for (const row of toolResults) {
        this.emitTransaction({
          type: "tool.result",
          correlationId: turnCorrelationId,
          name: row.action.tool,
          resultChars: row.result.length
        });
      }

      messages.push({
        role: "assistant",
        content: JSON.stringify(merged.originalAssistantPayload)
      });
      messages.push({
        role: "user",
        content: `TOOL_RESULTS:\n${JSON.stringify(toolResults, null, 2)}`
      });

      this.bumpCreatorStepsWithoutConfJson(creatorStepsWithoutConf);
      continue;
    }

    const fallback = "Tool loop limit reached before final response.";
    onEvent({ type: "error", message: fallback, at: Date.now() });
    await this.finalizeWorkspacePersistence(messages, systemSlots, fallback);
    return fallback;
  }
}
