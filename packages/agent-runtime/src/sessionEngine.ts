import fs from "node:fs";
import path from "node:path";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import type {
  ChatMessage,
  CompletionOptions,
  CompletionProvider,
  CompletionResult,
  ParsedToolCall,
  ToolCallEnvelope
} from "./providerClient";
import { AGENT_TOOL_SCHEMAS } from "./toolSchemas";
import { WorkspacePolicy } from "./workspacePolicy";

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
    };

interface AgentActionEnvelope {
  response?: string;
  actions?: unknown[];
}

export interface SessionEngineOptions {
  provider: CompletionProvider;
  workspacePolicy: WorkspacePolicy;
  skillPrompt: string;
  assetRoots?: {
    widgetFonts?: string;
  };
}

export class SessionEngine {
  constructor(private readonly options: SessionEngineOptions) {}

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
    throw new Error(`Unsupported tool action: ${tool || "unknown"}`);
  }

  private buildToolPrompt(): string {
    return [
      "You have native tools available via the API: list_files, read_file, write_file, replace_in_file, copy_asset_file.",
      "Call them through the standard tool_calls mechanism — do not emit JSON envelopes, <tool_call> XML, or any other text-shaped tool syntax.",
      "Rules:",
      "1) Use workspace-relative paths only.",
      "2) For existing files, prefer replace_in_file over write_file to keep payloads small and fast.",
      "3) Use write_file only when creating a new file or when replace_in_file cannot express the change.",
      "4) Use copy_asset_file for binary assets (fonts/images) instead of read_file/write_file.",
      "5) copy_asset_file strips a trailing -<8 hex> hash before the file extension on both source lookup and destination filenames (e.g. big_digits-ab12cd34.pil -> big_digits.pil).",
      "6) When you have nothing more to do, reply with a single short status sentence and no tool calls."
    ].join("\n");
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

  private executeAction(action: ToolAction): string {
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

  private processNativeToolCalls(completion: CompletionResult): {
    assistantMessage: ChatMessage;
    toolMessages: ChatMessage[];
    successfulActions: ToolAction[];
    outcomes: Array<{
      toolCall: ParsedToolCall;
      action: ToolAction | null;
      result: string;
    }>;
  } {
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
        result = this.executeAction(action);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown tool error";
        result = JSON.stringify({ ok: false, error: message });
      }
      outcomes.push({ toolCall, action, result });
    }

    const successfulActions = outcomes
      .map((outcome) => outcome.action)
      .filter((value): value is ToolAction => value !== null);

    const assistantToolCalls: ToolCallEnvelope[] = completion.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: { name: toolCall.name, arguments: toolCall.argumentsJson }
    }));
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: completion.content,
      tool_calls: assistantToolCalls
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
    this.options.workspacePolicy.resolveWithinRoot(".");

    const messages: ChatMessage[] = [
      { role: "system", content: this.options.skillPrompt },
      { role: "system", content: this.buildToolPrompt() },
      { role: "user", content: prompt }
    ];

    const maxToolRounds = SessionEngine.resolveToolLoopMax();

    for (let step = 0; step < maxToolRounds; step += 1) {
      if (abortSignal?.aborted) {
        throw new Error("Agent stopped.");
      }
      if (step > 0) {
        onEvent({ type: "status", message: "Agent is thinking...", at: Date.now() });
      }

      const completion = await this.options.provider.complete(messages, {
        tools: AGENT_TOOL_SCHEMAS,
        onChunk: (delta) => {
          onEvent({ type: "stream", delta, at: Date.now() });
        }
      });

      if (completion.toolCalls.length > 0) {
        const { assistantMessage, toolMessages, successfulActions, outcomes } =
          this.processNativeToolCalls(completion);
        const envelope = this.buildUiEnvelopeString(successfulActions, completion.content);
        if (envelope) {
          await this.streamNativeToolEnvelopePreview(completion.content, envelope, onEvent);
        }
        for (const outcome of outcomes) {
          if (outcome.action) {
            onEvent({
              type: "status",
              message: this.describeStatusAction(outcome.action),
              at: Date.now()
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
        return finalText;
      }

      this.emitUiEnvelope(actions, merged.responseText, onEvent);

      for (const action of actions) {
        onEvent({
          type: "status",
          message: this.describeStatusAction(action),
          at: Date.now()
        });
      }

      const toolResults = actions.map((action) => {
        try {
          return { action, result: this.executeAction(action) };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown tool error";
          return { action, result: JSON.stringify({ ok: false, error: message }) };
        }
      });

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
    return fallback;
  }
}
