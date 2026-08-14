import type { AgentEvent, AgentSdkStreamEvent, AgentTokenUsage } from "@dartsnut/shared-ipc";
import type { RunStreamEvent, StreamedRunResult } from "@openai/agents";
import { normalizeTokenUsage } from "./tokenUsage";

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

export async function forwardAgentsStream(
  stream: StreamedRunResult<any, any>,
  emit: (event: AgentEvent) => void,
  onActiveAgentChange?: (agentName: string) => void,
  onIterationFailure?: (diagnostics: AgentsStreamDiagnostics, streamedText: string) => void
): Promise<AgentsStreamResult> {
  let activeAgentName: string | undefined;
  let currentResponseText = "";
  let latestResponseText = "";
  let rawModelEvents = 0;
  let runItemEvents = 0;
  let agentUpdatedEvents = 0;
  const responseEventTypes: Record<string, number> = {};
  const runItemNames: Record<string, number> = {};
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
