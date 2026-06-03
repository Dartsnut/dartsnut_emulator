import type { AgentEvent } from "@dartsnut/shared-ipc";
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
  extractPathFromArgumentsJson,
  safeParseObject,
  toRelPath,
  type ToolStatusContext
} from "./toolStatusHelpers";

export type AgentsStreamBridgeHooks = {
  readWorkspaceFileIfExists?: (relPath: string) => string | undefined;
  persistTranscript?: (kind: "user" | "assistant" | "tool_status" | "thinking", text: string) => void;
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

function handleChatCompletionsChunk(
  chunk: ChatCompletionChunk,
  state: {
    reasoningId: string;
    sawReasoning: boolean;
    stepReasoning: string;
    stepText: string;
    streamedToolArgsByCallId: Map<string, string>;
  },
  emit: (event: AgentEvent) => void
): void {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) {
    return;
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
  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls) {
      const callId = call.id ?? `call_${call.index ?? 0}`;
      const name = call.function?.name ?? "";
      const prev = state.streamedToolArgsByCallId.get(callId) ?? "";
      const next = prev + (call.function?.arguments ?? "");
      state.streamedToolArgsByCallId.set(callId, next);
      if (!isFileMutationToolName(name)) {
        continue;
      }
      const relPath = extractPathFromArgumentsJson(next);
      emit({
        type: "tool_call_delta",
        at: Date.now(),
        callId,
        toolName: name,
        argumentsJson: next,
        ...(relPath ? { path: relPath } : {})
      });
    }
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
    const args = safeParseObject(JSON.parse(argsJson));
    const pathArg = toRelPath(args.path);
    const sourceArg = toRelPath(args.source);
    context = { callId, path: pathArg, source: sourceArg };
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
    streamedToolArgsByCallId: new Map<string, string>()
  };
  const toolNames: string[] = [];
  let filesWrittenThisTurn = 0;
  let toolCallCount = 0;
  let lastToolName = "";
  let lastCallId = "";
  let lastToolContext: ToolStatusContext | undefined;

  for await (const event of stream as AsyncIterable<RunStreamEvent>) {
    if (event.type === "raw_model_stream_event" && isOpenAIChatCompletionsRawModelStreamEvent(event)) {
      handleChatCompletionsChunk(event.data.event, state, emit);
      continue;
    }
    if (event.type === "run_item_stream_event") {
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
          emitToolStatusEvent(name, "call", emit, context, hooks.persistTranscript);
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
    toolCallCount
  };
}