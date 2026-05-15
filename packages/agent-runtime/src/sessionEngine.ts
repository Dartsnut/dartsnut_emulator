import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { transcriptUserBubbleText, type AgentEvent } from "@dartsnut/shared-ipc";
import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";
import type {
  ChatMessage,
  CompletionOptions,
  CompletionProvider,
  CompletionResult,
  ParsedToolCall,
  ToolCallEnvelope
} from "./providerClient";
import type { DeferredSkillId } from "./skillBundle";
import { DEFERRED_SKILL_IDS, readDeferredSkillMarkdown } from "./skillBundle";
import type { AgentSessionPersistence } from "./agentSessionPersistence";
import { AGENT_SESSION_SCHEMA_VERSION } from "./agentSessionPersistence";
import { AGENT_TOOL_SCHEMAS } from "./toolSchemas";
import { WorkspacePolicy } from "./workspacePolicy";

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
    tool: "get_dartsnut_skill";
    skill_id: DeferredSkillId;
  };

interface AgentActionEnvelope {
  response?: string;
  actions?: unknown[];
}

/** Host (Electron main) executes `dartsnut_project_intake`; returns JSON text for the model. */
export type HostIntakeToolHandler = (args: Record<string, unknown>) => Promise<string>;

/** Host (Electron main) executes `dartsnut_ask_question` during creation intake; returns JSON text for the model. */
export type HostAskQuestionHandler = (args: Record<string, unknown>) => Promise<string>;

/** Host (Electron main) reloads the embedded emulator; returns JSON text for the model. */
export type HostReloadEmulatorHandler = () => Promise<string>;

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
  /** Skip the initial `workspacePolicy.resolveWithinRoot(".")` probe (intake placeholder roots). */
  skipInitialWorkspaceResolve?: boolean;
  /** When set, rolling chat (user/assistant/tool) is persisted under the workspace and replayed on resume. */
  sessionPersistence?: AgentSessionPersistence;
  /** Stored in session manifest for debugging / fine-tuning metadata. */
  sessionTemplateMode?: string | null;
  sessionSection?: string | null;
  /** Prior turns loaded from disk (or empty); excluded from system prompts. */
  initialConversation?: ChatMessage[];
}

export class SessionEngine {
  /** User / assistant / tool messages for this workspace session (excludes system prompts). */
  private rollingConversation: ChatMessage[];

  constructor(private readonly options: SessionEngineOptions) {
    this.rollingConversation = [...(options.initialConversation ?? [])];
  }

  private buildSystemMessages(): ChatMessage[] {
    return [
      { role: "system", content: this.options.skillPrompt },
      { role: "system", content: this.buildToolPrompt() },
      { role: "system", content: SessionEngine.userLanguageMirrorSystemPrompt }
    ];
  }

  private emitTransaction(record: Record<string, unknown>): void {
    this.options.sessionPersistence?.appendTransaction({ at: Date.now(), ...record });
  }

  private finalizeWorkspacePersistence(
    messages: ChatMessage[],
    systemSlots: number,
    finalUserVisibleSummary: string
  ): void {
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
      section: this.options.sessionSection ?? null
    });
    p.saveConversationAtomic(this.rollingConversation);
    const trimmed =
      finalUserVisibleSummary.length > 50_000
        ? `${finalUserVisibleSummary.slice(0, 50_000)}…`
        : finalUserVisibleSummary;
    p.appendTranscript({ kind: "assistant", at: Date.now(), text: trimmed });
    p.appendTransaction({
      type: "turn.end",
      at: Date.now(),
      assistantSummaryChars: trimmed.length
    });
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
      "Call them through the standard tool_calls mechanism — do not emit JSON envelopes, <tool_call> XML, or any other text-shaped tool syntax.",
      "Rules:",
      "1) Use workspace-relative paths only.",
      "2) For existing files, prefer replace_in_file over write_file to keep payloads small and fast.",
      "3) Use write_file only when creating a new file or when replace_in_file cannot express the change.",
      "4) Use copy_asset_file for binary assets (fonts/images) instead of read_file/write_file.",
      "5) copy_asset_file strips a trailing -<8 hex> hash before the file extension on both source lookup and destination filenames (e.g. big_digits-ab12cd34.pil -> big_digits.pil).",
      "6) When you have nothing more to do, reply with a single short status sentence and no tool calls."
    ];
    if (hasIntake) {
      lines.push(
        "Intake: **dartsnut_project_intake** is host-executed — use `set_project_type`, `set_widget_size`, and `read_workspace_conf` (the host allocates an empty temp workspace automatically the first time `read_workspace_conf` runs while no folder is selected)."
      );
    }
    if (hasAskQuestion) {
      lines.push(
        "Intake UI: **dartsnut_ask_question** is host-executed and **blocking** — it shows Game/Widget chips or widget size chips and returns only after the user answers. Use it whenever you need that choice and cannot take it reliably from the user's text alone. Never assume a widget display size without evidence. After `read_workspace_conf`, ask at most one focused question when the folder already has a valid `conf.json`, invalid JSON, or a type/size mismatch."
      );
    }
    if (hasReload) {
      lines.push(
        "After creating or changing root `conf.json`, call **reload_emulator** so the preview and deploy panel see the new config (host re-reads conf and restarts the widget process)."
      );
    }
    return lines.join("\n");
  }

  /** Per-turn: mirror the user's natural language in assistant-visible prose. */
  private static readonly userLanguageMirrorSystemPrompt =
    "Language: In explanations, status text, and questions to the user, try to match the natural language of the user's latest message. If it is mostly English or too short to tell, use English. Do not translate code, file paths, JSON keys, or conventional API or library names.";

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

  private static parseXmlToolCalls(raw: string): {
    responseText: string;
    rawActions: unknown[];
  } | null {
    const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
    const matches = Array.from(raw.matchAll(toolCallRegex));
    if (matches.length === 0) {
      return null;
    }

    const rawActions: unknown[] = [];
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
        const rawValue = pMatch[2] ?? "";
        action[key] = rawValue.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      }
      rawActions.push(action);
    }

    if (rawActions.length === 0) {
      return null;
    }

    const responseText = raw.replace(toolCallRegex, "").trim();
    return { responseText, rawActions };
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

  private listFiles(relativePath?: string): string[] {
    const root = this.options.workspacePolicy.resolveWithinRoot(relativePath ?? ".");
    const output: string[] = [];
    const stack = [root];
    while (stack.length > 0 && output.length < 200) {
      const current = stack.pop()!;
      const entries = fs.readdirSync(current, { withFileTypes: true });
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
      const files = this.listFiles(action.path);
      return JSON.stringify({ ok: true, files });
    }
    if (action.tool === "read_file") {
      const filePath = this.options.workspacePolicy.resolveWithinRoot(action.path);
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.stringify({ ok: true, path: action.path, content });
    }
    if (action.tool === "write_file") {
      const filePath = this.options.workspacePolicy.resolveWithinRoot(action.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, action.content, "utf-8");
      return JSON.stringify({ ok: true, path: action.path, bytes: Buffer.byteLength(action.content) });
    }
    if (action.tool === "replace_in_file") {
      const filePath = this.options.workspacePolicy.resolveWithinRoot(action.path);
      const original = fs.readFileSync(filePath, "utf-8");
      if (!original.includes(action.find)) {
        throw new Error(`replace_in_file could not find target text in ${action.path}`);
      }
      const updated = original.replace(action.find, action.replace);
      fs.writeFileSync(filePath, updated, "utf-8");
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
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(resolvedSourcePath, outputPath);
    return JSON.stringify({
      ok: true,
      source: resolvedSourceKey,
      path: destRelative,
      requestedSource: action.source,
      requestedPath: action.path,
      bytes: fs.statSync(outputPath).size
    });
  }

  private readPreviousContent(action: ToolAction): string | undefined {
    if (action.tool !== "write_file") {
      return undefined;
    }
    try {
      const filePath = this.options.workspacePolicy.resolveWithinRoot(action.path);
      if (!fs.existsSync(filePath)) {
        return undefined;
      }
      return fs.readFileSync(filePath, "utf-8");
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
    if (action.tool === "get_dartsnut_skill") {
      return `Loaded skill ${action.skill_id}`;
    }
    return `Ran copy asset ${action.source} -> ${action.path}`;
  }

  private static readonly DEFAULT_TOOL_LOOP_MAX = 32;

  private static resolveToolLoopMax(): number {
    const raw = process.env.AGENT_TOOL_LOOP_MAX;
    if (raw === undefined || raw === "") {
      return SessionEngine.DEFAULT_TOOL_LOOP_MAX;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return SessionEngine.DEFAULT_TOOL_LOOP_MAX;
    }
    return Math.min(128, Math.max(1, Math.floor(n)));
  }

  private buildUiEnvelopeString(actions: ToolAction[], responseText: string): string | null {
    const trimmedResponse = responseText.trim();
    if (actions.length === 0 && trimmedResponse.length === 0) {
      return null;
    }
    const uiActions = actions.map((action) => {
      if (action.tool !== "write_file") {
        return action;
      }
      return {
        ...action,
        previousContent: this.readPreviousContent(action)
      };
    });
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

  private emitUiEnvelope(
    actions: ToolAction[],
    responseText: string,
    onEvent: (event: AgentEvent) => void
  ): void {
    const uiEnvelope = this.buildUiEnvelopeString(actions, responseText);
    if (!uiEnvelope) {
      return;
    }
    onEvent({ type: "final", content: uiEnvelope, at: Date.now() });
  }

  private async streamNativeToolEnvelopePreview(
    leadContent: string,
    envelopeJson: string,
    onEvent: (event: AgentEvent) => void
  ): Promise<void> {
    const lead = leadContent.trimEnd();
    const tail = lead.length > 0 ? `\n\n${envelopeJson}` : envelopeJson;
    const chunkSize = Math.max(256, Math.ceil(tail.length / 10));
    const renderFrameMs = 24;
    for (let i = 0; i < tail.length; i += chunkSize) {
      onEvent({ type: "stream", delta: tail.slice(i, i + chunkSize), at: Date.now() });
      await new Promise<void>((resolve) => setTimeout(resolve, renderFrameMs));
    }
    const finalContent = lead.length > 0 ? `${lead}\n\n${envelopeJson}` : envelopeJson;
    onEvent({ type: "final", content: finalContent, at: Date.now() });
  }

  private rawActionFromToolCall(toolCall: ParsedToolCall): unknown {
    const argumentsText = toolCall.argumentsJson.length > 0 ? toolCall.argumentsJson : "{}";
    const parsedArgs: unknown = JSON.parse(argumentsText);
    if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
      throw new Error("Tool arguments must be a JSON object.");
    }
    return { tool: toolCall.name, ...(parsedArgs as Record<string, unknown>) };
  }

  private async processNativeToolCalls(completion: CompletionResult): Promise<{
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

    for (const toolCall of completion.toolCalls) {
      let action: ToolAction | null = null;
      let result: string;
      try {
        const rawAction = this.rawActionFromToolCall(toolCall);
        action = this.normalizeAction(rawAction);
        result = await this.executeAction(action);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown tool error";
        result = JSON.stringify({ ok: false, error: message });
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
          value.tool !== "get_dartsnut_skill"
      );

    const assistantToolCalls: ToolCallEnvelope[] = completion.toolCalls.map((toolCall) => ({
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
    abortSignal?: AbortSignal
  ): Promise<string> {
    if (!this.options.skipInitialWorkspaceResolve) {
      this.options.workspacePolicy.resolveWithinRoot(".");
    }

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

    const maxToolRounds = SessionEngine.resolveToolLoopMax();

    for (let step = 0; step < maxToolRounds; step += 1) {
      if (abortSignal?.aborted) {
        throw new Error("Agent stopped.");
      }
      if (step > 0) {
        onEvent({ type: "status", message: "Agent is thinking...", at: Date.now() });
      }

      this.emitTransaction({
        type: "completion.request",
        correlationId: turnCorrelationId,
        step,
        messageCount: messages.length
      });

      let reasoningChunkEvents = 0;
      const completion = await this.options.provider.complete(messages, {
        tools: completionTools,
        onChunk: (delta) => {
          onEvent({ type: "stream", delta, at: Date.now() });
        },
        onReasoningChunk: (delta) => {
          if (delta.length > 0) {
            reasoningChunkEvents += 1;
          }
          onEvent({ type: "reasoning_stream", delta, at: Date.now() });
        }
      });

      const reasoningTrimmed = completion.reasoningContent?.trim() ?? "";
      if (reasoningTrimmed.length > 0) {
        const forTranscript =
          reasoningTrimmed.length > 50_000
            ? `${reasoningTrimmed.slice(0, 50_000)}…`
            : reasoningTrimmed;
        p?.appendTranscript({ kind: "thinking", at: Date.now(), text: forTranscript });
      }
      onEvent({ type: "reasoning_done", at: Date.now() });

      this.emitTransaction({
        type: "completion.response",
        correlationId: turnCorrelationId,
        step,
        toolCallCount: completion.toolCalls.length,
        contentLength: completion.content.length,
        reasoningChars: reasoningTrimmed.length,
        reasoningChunkEvents,
        reasoningHttpStream: completion.usedHttpStream === true
      });

      if (completion.toolCalls.length > 0) {
        const { assistantMessage, toolMessages, successfulActions, outcomes } =
          await this.processNativeToolCalls(completion);
        const envelope = this.buildUiEnvelopeString(successfulActions, completion.content);
        if (envelope) {
          await this.streamNativeToolEnvelopePreview(completion.content, envelope, onEvent);
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
            onEvent({
              type: "status",
              message: this.describeStatusAction(outcome.action),
              at: Date.now()
            });
            p?.appendTranscript({
              kind: "tool_status",
              at: Date.now(),
              text: this.describeStatusAction(outcome.action),
              toolName: outcome.toolCall.name
            });
          }
        }
        messages.push(assistantMessage);
        for (const toolMessage of toolMessages) {
          messages.push(toolMessage);
        }
        continue;
      }

      const merged = this.tryParseEnvelopesMerged(completion.content);

      if (!merged) {
        onEvent({ type: "final", content: completion.content, at: Date.now() });
        this.finalizeWorkspacePersistence(messages, systemSlots, completion.content);
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
        const finalText = merged.responseText || "Done.";
        onEvent({ type: "final", content: finalText, at: Date.now() });
        this.finalizeWorkspacePersistence(messages, systemSlots, finalText);
        return finalText;
      }

      this.emitUiEnvelope(actions, merged.responseText, onEvent);

      for (const action of actions) {
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

      const toolResults = await Promise.all(
        actions.map(async (action) => {
          try {
            return { action, result: await this.executeAction(action) };
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown tool error";
            return { action, result: JSON.stringify({ ok: false, error: message }) };
          }
        })
      );

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
    }

    const fallback = "Tool loop limit reached before final response.";
    onEvent({ type: "error", message: fallback, at: Date.now() });
    this.finalizeWorkspacePersistence(messages, systemSlots, fallback);
    return fallback;
  }
}
