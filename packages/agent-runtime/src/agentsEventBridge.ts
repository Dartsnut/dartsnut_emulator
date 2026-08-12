import type { AgentEvent, AgentTokenUsage } from "@dartsnut/shared-ipc";
import type { StreamedRunResult } from "@openai/agents";
import {
  isOpenAIResponsesRawModelStreamEvent,
  type RunStreamEvent
} from "@openai/agents";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
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
import { addTokenUsage, normalizeTokenUsage } from "./tokenUsage";

export type AgentsStreamBridgeHooks = {
  readWorkspaceFileIfExists?: (relPath: string) => string | undefined;
  persistTranscript?: (kind: "user" | "assistant" | "tool_status" | "thinking", text: string) => void;
  onActiveAgentChange?: (agentName: string) => void;
  onTokenUsage?: (runUsage: AgentTokenUsage) => void;
  onDiagnostic?: (message: string, meta: Record<string, unknown>) => void;
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
  chainableResponseId?: string;
  diagnostics: AgentsStreamBridgeDiagnostics;
};

export type AgentsStreamBridgeDiagnostics = {
  runEventTypes: Record<string, number>;
  rawDataTypes: Record<string, number>;
  rawModelSources: Record<string, number>;
  responseEventTypes: Record<string, number>;
  terminalResponseStatuses: string[];
  terminalFailureReasons: string[];
  terminalOutputItemTypes: string[];
  terminalContentItemTypes: string[];
  finalOutput:
    | { kind: "string"; chars: number }
    | { kind: "array"; length: number; itemTypes: string[] }
    | { kind: "object"; keys: string[] }
    | { kind: "not_read" }
    | { kind: "null" | "undefined" | "number" | "boolean" | "bigint" | "symbol" | "function" };
};

type ResponsesFunctionCallState = {
  callId: string;
  name: string;
  argumentsJson: string;
};

const WRITE_FILE_PREVIEW_MIN_LINES = 24;
const WRITE_FILE_PREVIEW_MAX_INTERMEDIATE_EVENTS = 5;
const DEFAULT_FILE_PREVIEW_PACING_MS = 18;

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function typeLabel(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") {
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" && type ? type : "object";
  }
  return typeof value;
}

function recordTerminalResponse(
  response: unknown,
  diagnostics: {
    terminalResponseStatuses: Set<string>;
    terminalFailureReasons: Set<string>;
    terminalOutputItemTypes: Set<string>;
    terminalContentItemTypes: Set<string>;
  }
): void {
  if (!response || typeof response !== "object") return;
  const record = response as {
    status?: unknown;
    output?: unknown;
    error?: unknown;
    incomplete_details?: unknown;
    providerData?: unknown;
  };
  if (typeof record.status === "string" && record.status) {
    diagnostics.terminalResponseStatuses.add(record.status);
  }
  const recordFailureReason = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const failure = value as { reason?: unknown; code?: unknown; type?: unknown };
    for (const candidate of [failure.reason, failure.code, failure.type]) {
      if (typeof candidate === "string" && candidate) diagnostics.terminalFailureReasons.add(candidate);
    }
  };
  recordFailureReason(record.error);
  recordFailureReason(record.incomplete_details);
  if (record.providerData && typeof record.providerData === "object") {
    const providerData = record.providerData as {
      status?: unknown;
      error?: unknown;
      incomplete_details?: unknown;
    };
    const status = providerData.status;
    if (typeof status === "string" && status) diagnostics.terminalResponseStatuses.add(status);
    recordFailureReason(providerData.error);
    recordFailureReason(providerData.incomplete_details);
  }
  if (!Array.isArray(record.output)) return;
  for (const item of record.output) {
    diagnostics.terminalOutputItemTypes.add(typeLabel(item));
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const contentItem of content) {
      diagnostics.terminalContentItemTypes.add(typeLabel(contentItem));
    }
  }
}

function summarizeFinalOutput(value: unknown): AgentsStreamBridgeDiagnostics["finalOutput"] {
  if (typeof value === "string") return { kind: "string", chars: value.length };
  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
      itemTypes: [...new Set(value.map(typeLabel))].slice(0, 12)
    };
  }
  if (value && typeof value === "object") {
    return { kind: "object", keys: Object.keys(value).slice(0, 12) };
  }
  if (value === null) return { kind: "null" };
  switch (typeof value) {
    case "undefined": return { kind: "undefined" };
    case "number": return { kind: "number" };
    case "boolean": return { kind: "boolean" };
    case "bigint": return { kind: "bigint" };
    case "symbol": return { kind: "symbol" };
    case "function": return { kind: "function" };
    default: return { kind: "undefined" };
  }
}

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

async function handleResponsesEvent(
  event: ResponseStreamEvent,
  state: {
    reasoningId: string;
    sawReasoning: boolean;
    stepReasoning: string;
    stepText: string;
    functionCalls: Map<string, ResponsesFunctionCallState>;
    accountedResponseIds: Set<string>;
    streamedFileToolCallIds: Set<string>;
    filePreviewLineCounts: Map<string, number>;
    filePreviewPacingMs: number;
    tokenUsage: AgentTokenUsage | null;
    chainableResponseId: string;
    onTokenUsage?: (runUsage: AgentTokenUsage) => void;
  },
  emit: (event: AgentEvent) => void
): Promise<void> {
  if (event.type === "response.output_text.delta") {
    if (event.delta) {
      state.stepText += event.delta;
      emit({ type: "stream", at: Date.now(), delta: event.delta });
    }
    return;
  }

  if (event.type === "response.reasoning_text.delta" || event.type === "response.reasoning_summary_text.delta") {
    const reasoningDelta = event.delta;
    state.sawReasoning = true;
    state.stepReasoning += reasoningDelta;
    emit({
      type: "reasoning_stream",
      at: Date.now(),
      reasoningId: state.reasoningId,
      delta: reasoningDelta
    });
    return;
  }

  if (event.type === "response.output_item.added" && event.item.type === "function_call") {
    state.functionCalls.set(event.item.id ?? event.item.call_id, {
      callId: event.item.call_id,
      name: event.item.name,
      argumentsJson: event.item.arguments ?? ""
    });
    return;
  }

  if (event.type === "response.function_call_arguments.delta") {
    const call = state.functionCalls.get(event.item_id);
    if (!call) {
      return;
    }
    call.argumentsJson += event.delta;
    if (isFileMutationToolName(call.name)) {
      await emitFileToolCallDelta(call.callId, call.name, call.argumentsJson, emit, state);
    }
    return;
  }

  if (event.type === "response.function_call_arguments.done") {
    const call = state.functionCalls.get(event.item_id);
    if (!call) {
      return;
    }
    call.name = event.name || call.name;
    call.argumentsJson = event.arguments;
    if (isFileMutationToolName(call.name)) {
      await emitFileToolCallDelta(call.callId, call.name, call.argumentsJson, emit, state);
    }
    return;
  }

  if (event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete") {
    accountResponseUsage(state, event.response.id, event.response.usage);
    if (event.type === "response.completed") state.chainableResponseId = event.response.id;
  }
}

function accountResponseUsage(
  state: {
    accountedResponseIds: Set<string>;
    tokenUsage: AgentTokenUsage | null;
    onTokenUsage?: (runUsage: AgentTokenUsage) => void;
  },
  responseId: string,
  rawUsage: unknown
): void {
  if (state.accountedResponseIds.has(responseId)) {
    return;
  }
  state.accountedResponseIds.add(responseId);
  const usage = normalizeTokenUsage(rawUsage);
  if (usage) {
    state.tokenUsage = state.tokenUsage ? addTokenUsage(state.tokenUsage, usage) : usage;
    state.onTokenUsage?.(state.tokenUsage);
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
      if (toolName === "copy_chat_attachment") {
        return typeof candidate.path === "string" || typeof candidate.attachment_id === "string";
      }
      if (toolName === "get_dartsnut_skill") {
        return typeof candidate.skill_id === "string";
      }
      return true;
    }) ?? safeParseObject(JSON.parse(argsJson));
    const pathArg = toRelPath(args.path);
    const sourceArg = toRelPath(args.source);
    const attachmentIdArg = typeof args.attachment_id === "string" ? args.attachment_id : undefined;
    const skillIdArg = toRelPath(args.skill_id);
    context = { callId, path: pathArg, source: sourceArg, attachment_id: attachmentIdArg, skillId: skillIdArg };
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
    functionCalls: new Map<string, ResponsesFunctionCallState>(),
    accountedResponseIds: new Set<string>(),
    streamedFileToolCallIds: new Set<string>(),
    filePreviewLineCounts: new Map<string, number>(),
    filePreviewPacingMs: hooks.filePreviewPacingMs ?? DEFAULT_FILE_PREVIEW_PACING_MS,
    tokenUsage: null as AgentTokenUsage | null,
    chainableResponseId: "",
    onTokenUsage: hooks.onTokenUsage
  };
  const toolNames: string[] = [];
  let filesWrittenThisTurn = 0;
  let toolCallCount = 0;
  let lastToolName = "";
  let lastCallId = "";
  let lastToolContext: ToolStatusContext | undefined;
  const runEventTypes: Record<string, number> = {};
  const rawDataTypes: Record<string, number> = {};
  const rawModelSources: Record<string, number> = {};
  const responseEventTypes: Record<string, number> = {};
  const terminalResponseStatuses = new Set<string>();
  const terminalFailureReasons = new Set<string>();
  const terminalOutputItemTypes = new Set<string>();
  const terminalContentItemTypes = new Set<string>();
  const snapshotDiagnostics = (readFinalOutput = true): AgentsStreamBridgeDiagnostics => ({
    runEventTypes,
    rawDataTypes,
    rawModelSources,
    responseEventTypes,
    terminalResponseStatuses: [...terminalResponseStatuses],
    terminalFailureReasons: [...terminalFailureReasons],
    terminalOutputItemTypes: [...terminalOutputItemTypes],
    terminalContentItemTypes: [...terminalContentItemTypes],
    finalOutput: readFinalOutput ? summarizeFinalOutput(stream.finalOutput) : { kind: "not_read" }
  });

  try {
    for await (const event of stream as AsyncIterable<RunStreamEvent>) {
    incrementCount(runEventTypes, event.type);
    if (event.type === "raw_model_stream_event") {
      const rawEvent = event as unknown as {
        source?: unknown;
        data?: { type?: unknown; event?: { type?: unknown; response?: unknown }; response?: unknown };
      };
      const rawDataType = typeof rawEvent.data?.type === "string" ? rawEvent.data.type : "unknown";
      const source = typeof rawEvent.source === "string" ? rawEvent.source : "missing";
      incrementCount(rawDataTypes, rawDataType);
      incrementCount(rawModelSources, source);
      if (rawDataType === "model") {
        const responseEventType = rawEvent.data?.event?.type;
        incrementCount(responseEventTypes, typeof responseEventType === "string" ? responseEventType : "unknown");
        recordTerminalResponse(rawEvent.data?.event?.response, {
          terminalResponseStatuses,
          terminalFailureReasons,
          terminalOutputItemTypes,
          terminalContentItemTypes
        });
      } else if (rawDataType === "response_done") {
        recordTerminalResponse(rawEvent.data?.response, {
          terminalResponseStatuses,
          terminalFailureReasons,
          terminalOutputItemTypes,
          terminalContentItemTypes
        });
      }
    }
    if (event.type === "raw_model_stream_event" && isOpenAIResponsesRawModelStreamEvent(event)) {
      await handleResponsesEvent(event.data.event, state, emit);
      continue;
    }
    if (event.type === "raw_model_stream_event" && event.data.type === "response_done") {
      accountResponseUsage(state, event.data.response.id, event.data.response.usage);
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
  } catch (error) {
    hooks.onDiagnostic?.("agent stream iteration failed", {
      failure: "stream_iteration_error",
      errorName: error instanceof Error ? error.name : typeof error,
      ...snapshotDiagnostics(false)
    });
    throw error;
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
    diagnostics: snapshotDiagnostics(),
    ...(state.tokenUsage ? { tokenUsage: state.tokenUsage } : {}),
    ...(state.chainableResponseId ? { chainableResponseId: state.chainableResponseId } : {})
  };
}
