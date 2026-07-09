import type { AgentEvent, AgentTokenUsage } from "@dartsnut/shared-ipc";
import type { StreamedRunResult } from "@openai/agents";
import {
  isOpenAIChatCompletionsRawModelStreamEvent,
  type RunStreamEvent
} from "@openai/agents";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { isFileMutationToolName } from "./creatorTurnGuard";
import {
  computeReplaceDiff,
  computeWriteDiff,
  emitToolStatusEvent,
  extractLatestArgumentsObject,
  extractPathFromArgumentsJson,
  safeParseObject,
  toRelPath,
  type ToolStatusContext
} from "./toolStatusHelpers";
import { mergeToolCallDeltas, type StreamingToolCallAccumulator } from "./toolCallDeltaMerge";
import { addTokenUsage, normalizeTokenUsage } from "./tokenUsage";

export type AgentsStreamBridgeHooks = {
  readWorkspaceFileIfExists?: (relPath: string) => string | undefined;
  persistTranscript?: (kind: "user" | "assistant" | "tool_status" | "thinking", text: string) => void;
  onActiveAgentChange?: (agentName: string) => void;
  onTokenUsage?: (runUsage: AgentTokenUsage) => void;
  filePreviewPacingMs?: number;
};

export type AgentsStreamBridgeResult = {
  finalText: string;
  sawReasoning: boolean;
  sawToolCall: boolean;
  stepText: string;
  stepReasoning: string;
  toolNames: string[];
  filesWrittenThisTurn: number;
  toolCallCount: number;
  tokenUsage?: AgentTokenUsage;
};

function readReasoningDelta(delta: unknown): string {
  if (!delta || typeof delta !== "object") {
    return "";
  }
  const d = delta as Record<string, unknown>;
  const rc = d.reasoning_content;
  if (typeof rc === "string" && rc.length > 0) {
    return rc;
  }
  const r = d.reasoning;
  if (typeof r === "string" && r.length > 0) {
    return r;
  }
  return "";
}

function resolveStreamingToolCallId(acc: StreamingToolCallAccumulator, index: number): string {
  return acc.id.length > 0 ? acc.id : `call_${index}`;
}

const WRITE_FILE_PREVIEW_MIN_LINES = 24;
const WRITE_FILE_PREVIEW_MAX_INTERMEDIATE_EVENTS = 5;
const DEFAULT_FILE_PREVIEW_PACING_MS = 18;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function countTextLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function firstLines(text: string, lineCount: number): string {
  return text.split(/\r?\n/).slice(0, lineCount).join("\n");
}

function emitFileToolCallDeltaEvent(
  callId: string,
  toolName: string,
  argumentsJson: string,
  emit: (event: AgentEvent) => void,
  streamedFileToolCallIds: Set<string>,
  pathOverride?: string
): void {
  if (!isFileMutationToolName(toolName)) {
    return;
  }
  streamedFileToolCallIds.add(callId);
  const relPath = pathOverride ?? extractPathFromArgumentsJson(argumentsJson);
  emit({
    type: "tool_call_delta",
    at: Date.now(),
    callId,
    toolName,
    argumentsJson,
    ...(relPath ? { path: relPath } : {})
  });
}

async function emitFileToolCallDelta(
  callId: string,
  toolName: string,
  argumentsJson: string,
  emit: (event: AgentEvent) => void,
  state: {
    streamedFileToolCallIds: Set<string>;
    filePreviewLineCounts: Map<string, number>;
    filePreviewPacingMs: number;
  }
): Promise<void> {
  if (toolName !== "write_file") {
    emitFileToolCallDeltaEvent(callId, toolName, argumentsJson, emit, state.streamedFileToolCallIds);
    return;
  }

  const args = extractLatestArgumentsObject(
    argumentsJson,
    (candidate) => typeof candidate.path === "string" && typeof candidate.content === "string"
  );
  const path = toRelPath(args?.path);
  const content = typeof args?.content === "string" ? args.content : "";
  const targetLines = countTextLines(content);
  const previousLines = state.filePreviewLineCounts.get(callId) ?? 0;
  const shouldPreview =
    args &&
    path &&
    targetLines >= WRITE_FILE_PREVIEW_MIN_LINES &&
    targetLines - previousLines > WRITE_FILE_PREVIEW_MIN_LINES;

  if (shouldPreview) {
    const step = Math.max(
      1,
      Math.ceil((targetLines - previousLines) / (WRITE_FILE_PREVIEW_MAX_INTERMEDIATE_EVENTS + 1))
    );
    const previewCounts: number[] = [];
    for (let lines = previousLines + step; lines < targetLines; lines += step) {
      previewCounts.push(lines);
    }
    for (const lines of previewCounts.slice(0, WRITE_FILE_PREVIEW_MAX_INTERMEDIATE_EVENTS)) {
      const previewArgs = JSON.stringify({ ...args, content: firstLines(content, lines) });
      emitFileToolCallDeltaEvent(callId, toolName, previewArgs, emit, state.streamedFileToolCallIds, path);
      state.filePreviewLineCounts.set(callId, lines);
      await sleep(state.filePreviewPacingMs);
    }
  }

  emitFileToolCallDeltaEvent(callId, toolName, argumentsJson, emit, state.streamedFileToolCallIds, path);
  if (targetLines > 0) {
    state.filePreviewLineCounts.set(callId, targetLines);
  }
}

async function handleChatCompletionsChunk(
  chunk: ChatCompletionChunk,
  state: {
    reasoningId: string;
    sawReasoning: boolean;
    stepReasoning: string;
    stepText: string;
    toolCallAccumulators: Map<number, StreamingToolCallAccumulator>;
    activeModelResponseId: string;
    streamedFileToolCallIds: Set<string>;
    filePreviewLineCounts: Map<string, number>;
    filePreviewPacingMs: number;
    tokenUsage: AgentTokenUsage | null;
    onTokenUsage?: (runUsage: AgentTokenUsage) => void;
  },
  emit: (event: AgentEvent) => void
): Promise<void> {
  const chunkUsage = normalizeTokenUsage((chunk as { usage?: unknown }).usage);
  if (chunkUsage) {
    state.tokenUsage = state.tokenUsage ? addTokenUsage(state.tokenUsage, chunkUsage) : chunkUsage;
    state.onTokenUsage?.(state.tokenUsage);
  }
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) {
    return;
  }
  const chunkId = typeof chunk.id === "string" && chunk.id.length > 0 ? chunk.id : "";
  if (chunkId && state.activeModelResponseId && state.activeModelResponseId !== chunkId) {
    state.toolCallAccumulators.clear();
  }
  if (chunkId) {
    state.activeModelResponseId = chunkId;
  }
  const contentDelta = delta.content ?? "";
  if (contentDelta) {
    state.stepText += contentDelta;
    emit({ type: "stream", at: Date.now(), delta: contentDelta });
  }
  const reasoningDelta = readReasoningDelta(delta);
  if (reasoningDelta) {
    state.sawReasoning = true;
    state.stepReasoning += reasoningDelta;
    emit({
      type: "reasoning_stream",
      at: Date.now(),
      reasoningId: state.reasoningId,
      delta: reasoningDelta
    });
  }
  if (!Array.isArray(delta.tool_calls)) {
    return;
  }
  const changedIndices = mergeToolCallDeltas(state.toolCallAccumulators, delta.tool_calls);
  for (const index of changedIndices) {
    const acc = state.toolCallAccumulators.get(index);
    if (!acc) {
      continue;
    }
    if (!isFileMutationToolName(acc.name)) {
      continue;
    }
    await emitFileToolCallDelta(resolveStreamingToolCallId(acc, index), acc.name, acc.argumentsJson, emit, state);
  }
}

function toolContextFromArgs(
  toolName: string,
  argsJson: string,
  callId: string,
  hooks: AgentsStreamBridgeHooks
): ToolStatusContext {
  let context: ToolStatusContext = { callId };
  try {
    const args = extractLatestArgumentsObject(argsJson, (candidate) => {
      if (toolName === "write_file") {
        return typeof candidate.path === "string" && typeof candidate.content === "string";
      }
      if (toolName === "replace_in_file") {
        return (
          typeof candidate.path === "string" &&
          typeof candidate.find === "string" &&
          typeof candidate.replace === "string"
        );
      }
      if (toolName === "copy_asset_file") {
        return typeof candidate.path === "string" || typeof candidate.source === "string";
      }
      if (toolName === "get_dartsnut_skill") {
        return typeof candidate.skill_id === "string";
      }
      return true;
    }) ?? safeParseObject(JSON.parse(argsJson));
    const pathArg = toRelPath(args.path);
    const sourceArg = toRelPath(args.source);
    const skillIdArg = toRelPath(args.skill_id);
    context = { callId, path: pathArg, source: sourceArg, skillId: skillIdArg };
    if (toolName === "write_file") {
      const nextContent = typeof args.content === "string" ? args.content : "";
      const previousContent = pathArg ? hooks.readWorkspaceFileIfExists?.(pathArg) : undefined;
      context = { ...context, ...computeWriteDiff(previousContent, nextContent) };
    } else if (toolName === "replace_in_file") {
      const findText = typeof args.find === "string" ? args.find : "";
      const replaceText = typeof args.replace === "string" ? args.replace : "";
      context = { ...context, ...computeReplaceDiff(findText, replaceText) };
    }
  } catch {
    // ignore partial args
  }
  return context;
}

export async function mapAgentsStreamToAgentEvents(
  stream: StreamedRunResult<any, any>,
  emit: (event: AgentEvent) => void,
  hooks: AgentsStreamBridgeHooks = {}
): Promise<AgentsStreamBridgeResult> {
  const reasoningId = `rsn-${Date.now()}`;
  const state = {
    reasoningId,
    sawReasoning: false,
    stepReasoning: "",
    stepText: "",
    toolCallAccumulators: new Map<number, StreamingToolCallAccumulator>(),
    activeModelResponseId: "",
    streamedFileToolCallIds: new Set<string>(),
    filePreviewLineCounts: new Map<string, number>(),
    filePreviewPacingMs: hooks.filePreviewPacingMs ?? DEFAULT_FILE_PREVIEW_PACING_MS,
    tokenUsage: null as AgentTokenUsage | null,
    onTokenUsage: hooks.onTokenUsage
  };
  const toolNames: string[] = [];
  let filesWrittenThisTurn = 0;
  let toolCallCount = 0;
  let lastToolName = "";
  let lastCallId = "";
  let lastToolContext: ToolStatusContext | undefined;

  for await (const event of stream as AsyncIterable<RunStreamEvent>) {
    if (event.type === "raw_model_stream_event" && isOpenAIChatCompletionsRawModelStreamEvent(event)) {
      await handleChatCompletionsChunk(event.data.event, state, emit);
      continue;
    }
    if (event.type === "agent_updated_stream_event") {
      const agentName = event.agent?.name;
      if (typeof agentName === "string" && agentName.length > 0) {
        hooks.onActiveAgentChange?.(agentName);
        emit({ type: "status", at: Date.now(), message: `Agent: ${agentName}` });
      }
      continue;
    }
    if (event.type === "run_item_stream_event") {
      if (event.name === "handoff_requested" || event.name === "handoff_occurred") {
        const item = event.item as { agent?: { name?: string }; rawItem?: { name?: string } };
        const targetName =
          typeof item.agent?.name === "string"
            ? item.agent.name
            : typeof item.rawItem?.name === "string"
              ? item.rawItem.name
              : "specialist";
        const verb = event.name === "handoff_requested" ? "Handoff requested" : "Handoff";
        emit({ type: "status", at: Date.now(), message: `${verb}: ${targetName}` });
        if (typeof item.agent?.name === "string") {
          hooks.onActiveAgentChange?.(item.agent.name);
        }
      }
      if (event.name === "tool_called") {
        const raw = event.item.rawItem as { name?: string; callId?: string; arguments?: string };
        const name = typeof raw?.name === "string" ? raw.name : "";
        const callId = typeof raw?.callId === "string" ? raw.callId : `call_${Date.now()}`;
        const argsJson = typeof raw?.arguments === "string" ? raw.arguments : "";
        if (name) {
          lastToolName = name;
          lastCallId = callId;
          toolNames.push(name);
          toolCallCount += 1;
          if (isFileMutationToolName(name)) {
            filesWrittenThisTurn += 1;
          }
          const context = toolContextFromArgs(name, argsJson, callId, hooks);
          lastToolContext = context;
          if (isFileMutationToolName(name) && !state.streamedFileToolCallIds.has(callId)) {
            await emitFileToolCallDelta(callId, name, argsJson, emit, state);
          }
          const skipCallStatus =
            isFileMutationToolName(name) && state.streamedFileToolCallIds.has(callId);
          if (!skipCallStatus) {
            emitToolStatusEvent(name, "call", emit, context, hooks.persistTranscript);
          }
        }
      }
      if (event.name === "tool_output") {
        const item = event.item as {
          rawItem?: { name?: string; callId?: string; arguments?: string };
          agent?: { name?: string };
        };
        const raw = item.rawItem;
        const name = typeof raw?.name === "string" ? raw.name : lastToolName;
        const callId = typeof raw?.callId === "string" ? raw.callId : lastCallId;
        if (name) {
          const context = lastToolContext?.callId === callId && lastToolContext
            ? { ...lastToolContext, callId: callId ?? lastToolContext.callId }
            : toolContextFromArgs(name, raw?.arguments ?? "{}", callId ?? `call_${Date.now()}`, hooks);
          emitToolStatusEvent(name, "result", emit, context, hooks.persistTranscript);
        }
      }
    }
  }

  await stream.completed;

  if (state.stepReasoning) {
    hooks.persistTranscript?.("thinking", state.stepReasoning);
    emit({ type: "reasoning_done", at: Date.now(), reasoningId });
  }
  if (state.stepText.trim()) {
    hooks.persistTranscript?.("assistant", state.stepText.trim());
  }

  const finalText = typeof stream.finalOutput === "string" ? stream.finalOutput : state.stepText;
  return {
    finalText: finalText.trim(),
    sawReasoning: state.sawReasoning,
    sawToolCall: toolCallCount > 0,
    stepText: state.stepText,
    stepReasoning: state.stepReasoning,
    toolNames,
    filesWrittenThisTurn,
    toolCallCount,
    ...(state.tokenUsage ? { tokenUsage: state.tokenUsage } : {})
  };
}
