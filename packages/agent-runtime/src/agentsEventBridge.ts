import type { AgentEvent, AgentSdkStreamEvent, AgentTokenUsage } from "@dartsnut/shared-ipc";
import type { RunStreamEvent, StreamedRunResult } from "@openai/agents";
import { normalizeTokenUsage } from "./tokenUsage";
import {
  computeReplaceDiff,
  computeWriteDiff,
  emitToolStatusEvent,
  extractLatestArgumentsObject,
  safeParseObject,
  toRelPath,
  type ToolStatusContext
} from "./toolStatusHelpers";

export type AgentsStreamDiagnostics = {
  rawModelEvents: number;
  runItemEvents: number;
  agentUpdatedEvents: number;
  responseEventTypes: Record<string, number>;
  runItemNames: Record<string, number>;
};

export type AgentsStreamResult = {
  finalText: string;
  lastResponseId?: string;
  tokenUsage?: AgentTokenUsage;
  activeAgentName?: string;
  diagnostics: AgentsStreamDiagnostics;
};

export type AgentsStreamHooks = {
  readWorkspaceFileIfExists?: (relPath: string) => string | undefined;
  persistTranscript?: (kind: "tool_status", text: string) => void;
};

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function rawResponseEventType(event: RunStreamEvent): string | undefined {
  if (event.type !== "raw_model_stream_event" || !event.data || typeof event.data !== "object") {
    return undefined;
  }
  const data = event.data as { type?: unknown; event?: { type?: unknown } };
  if (data.type === "model" && typeof data.event?.type === "string") {
    return data.event.type;
  }
  return typeof data.type === "string" ? data.type : undefined;
}

export function serializeAgentsStreamEvent(event: RunStreamEvent): AgentSdkStreamEvent {
  if (event.type === "raw_model_stream_event") {
    return {
      type: event.type,
      ...(event.source ? { source: event.source } : {}),
      data: event.data
    };
  }
  if (event.type === "run_item_stream_event") {
    return {
      type: event.type,
      name: event.name,
      item: event.item.toJSON()
    };
  }
  return {
    type: event.type,
    agent: event.agent.toJSON()
  };
}

function finalText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function runItemRawItem(event: Extract<RunStreamEvent, { type: "run_item_stream_event" }>): Record<string, unknown> {
  const item = event.item as unknown as { rawItem?: unknown; toJSON?: () => unknown };
  if (item.rawItem && typeof item.rawItem === "object") {
    return item.rawItem as Record<string, unknown>;
  }
  const serialized = typeof item.toJSON === "function" ? item.toJSON() : null;
  if (!serialized || typeof serialized !== "object") {
    return {};
  }
  const rawItem = (serialized as { rawItem?: unknown }).rawItem;
  return rawItem && typeof rawItem === "object" ? rawItem as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function toolContextFromArgs(
  toolName: string,
  argsJson: string,
  callId: string,
  hooks: AgentsStreamHooks
): ToolStatusContext {
  let context: ToolStatusContext = { callId };
  try {
    const args = extractLatestArgumentsObject(argsJson, (candidate) => {
      if (toolName === "write_file") {
        return typeof candidate.path === "string" && typeof candidate.content === "string";
      }
      if (toolName === "replace_in_file") {
        return typeof candidate.path === "string"
          && typeof candidate.find === "string"
          && typeof candidate.replace === "string";
      }
      return true;
    }) ?? safeParseObject(JSON.parse(argsJson));
    const path = toRelPath(args.path);
    context = {
      callId,
      path,
      source: toRelPath(args.source),
      attachment_id: typeof args.attachment_id === "string" ? args.attachment_id : undefined,
      skillId: toRelPath(args.skill_id)
    };
    if (toolName === "write_file") {
      const nextContent = typeof args.content === "string" ? args.content : "";
      context = { ...context, ...computeWriteDiff(path ? hooks.readWorkspaceFileIfExists?.(path) : undefined, nextContent) };
    } else if (toolName === "replace_in_file") {
      context = {
        ...context,
        ...computeReplaceDiff(
          typeof args.find === "string" ? args.find : "",
          typeof args.replace === "string" ? args.replace : ""
        )
      };
    }
  } catch {
    // Tool status remains useful when a provider omits or partially serializes arguments.
  }
  return context;
}

export async function forwardAgentsStream(
  stream: StreamedRunResult<any, any>,
  emit: (event: AgentEvent) => void,
  onActiveAgentChange?: (agentName: string) => void,
  onIterationFailure?: (diagnostics: AgentsStreamDiagnostics, streamedText: string) => void,
  hooks: AgentsStreamHooks = {}
): Promise<AgentsStreamResult> {
  let activeAgentName: string | undefined;
  let currentResponseText = "";
  let latestResponseText = "";
  let rawModelEvents = 0;
  let runItemEvents = 0;
  let agentUpdatedEvents = 0;
  const responseEventTypes: Record<string, number> = {};
  const runItemNames: Record<string, number> = {};
  const toolContexts = new Map<string, { name: string; context: ToolStatusContext }>();
  let lastTool: { name: string; context: ToolStatusContext } | undefined;
  const diagnostics = (): AgentsStreamDiagnostics => ({
    rawModelEvents,
    runItemEvents,
    agentUpdatedEvents,
    responseEventTypes: { ...responseEventTypes },
    runItemNames: { ...runItemNames }
  });
  try {
    for await (const event of stream as AsyncIterable<RunStreamEvent>) {
      emit(serializeAgentsStreamEvent(event));
      if (event.type === "raw_model_stream_event") {
        rawModelEvents += 1;
        const data = event.data && typeof event.data === "object"
          ? event.data as { type?: unknown; delta?: unknown }
          : null;
        if (data?.type === "response_started") {
          currentResponseText = "";
        } else if (data?.type === "output_text_delta" && typeof data.delta === "string") {
          currentResponseText += data.delta;
        } else if (data?.type === "response_done" && currentResponseText.trim()) {
          latestResponseText = currentResponseText.trim();
        }
        const responseType = rawResponseEventType(event);
        if (responseType) incrementCount(responseEventTypes, responseType);
      } else if (event.type === "run_item_stream_event") {
        runItemEvents += 1;
        incrementCount(runItemNames, event.name);
        const rawItem = runItemRawItem(event);
        if (event.name === "tool_called") {
          const name = stringField(rawItem, "name");
          if (name) {
            const callId = stringField(rawItem, "callId", "call_id") ?? `call_${Date.now()}`;
            const argsJson = stringField(rawItem, "arguments") ?? "{}";
            const context = toolContextFromArgs(name, argsJson, callId, hooks);
            const tracked = { name, context };
            toolContexts.set(callId, tracked);
            lastTool = tracked;
            emitToolStatusEvent(name, "call", emit, context, hooks.persistTranscript);
          }
        } else if (event.name === "tool_output") {
          const callId = stringField(rawItem, "callId", "call_id");
          const tracked = (callId ? toolContexts.get(callId) : undefined) ?? lastTool;
          const name = stringField(rawItem, "name") ?? tracked?.name;
          if (name) {
            const resolvedCallId = callId ?? tracked?.context.callId ?? `call_${Date.now()}`;
            const context = tracked?.context.callId === resolvedCallId
              ? tracked.context
              : toolContextFromArgs(name, stringField(rawItem, "arguments") ?? "{}", resolvedCallId, hooks);
            emitToolStatusEvent(name, "result", emit, context, hooks.persistTranscript);
            toolContexts.delete(resolvedCallId);
          }
        }
      } else if (event.type === "agent_updated_stream_event") {
        agentUpdatedEvents += 1;
      }
      if (event.type === "agent_updated_stream_event" && event.agent.name) {
        activeAgentName = event.agent.name;
        onActiveAgentChange?.(activeAgentName);
      }
    }
  } catch (error) {
    onIterationFailure?.(diagnostics(), currentResponseText.trim() || latestResponseText);
    throw error;
  }
  await stream.completed;
  const tokenUsage = normalizeTokenUsage(stream.state.usage);
  return {
    finalText: finalText(stream.finalOutput).trim(),
    ...(stream.lastResponseId ? { lastResponseId: stream.lastResponseId } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(activeAgentName ? { activeAgentName } : {}),
    diagnostics: diagnostics()
  };
}
