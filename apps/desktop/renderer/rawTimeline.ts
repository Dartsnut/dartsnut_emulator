import type { AgentEvent, AgentSessionTranscriptLine } from "@dartsnut/shared-ipc";
import { stripIntakeUiMarkers, transcriptUserBubbleText } from "@dartsnut/shared-ipc";

export interface TimelineEntry {
  id: string;
  role: "user" | "agent" | "status" | "error";
  text: string;
  reasoningMode?: "delta" | "summary" | "expanded";
  reasoningFullText?: string;
  toolStatusMeta?: {
    callId?: string;
    toolName?: string;
    phase?: "call" | "result";
    filePath?: string;
    added?: number;
    deleted?: number;
  };
}

export function formatAgentEventForTimeline(event: AgentEvent): string {
  if (event.type === "tool_call_delta") {
    const pathText = event.path ? ` ${event.path}` : "";
    return `[tool_call_delta] ${event.toolName}${pathText} (${event.argumentsJson.length} chars streamed)`;
  }
  return JSON.stringify(event, null, 2);
}

const TOOL_STATUS_META_PREFIX = " @@tool_status_meta@@";

export function parseToolStatusMessage(input: string): {
  text: string;
  meta?: {
    callId?: string;
    toolName?: string;
    phase?: "call" | "result";
    filePath?: string;
    added?: number;
    deleted?: number;
  };
} {
  const marker = input.indexOf(TOOL_STATUS_META_PREFIX);
  if (marker < 0) {
    return { text: input };
  }
  const visible = input.slice(0, marker).trimEnd();
  const rawMeta = input.slice(marker + TOOL_STATUS_META_PREFIX.length).trim();
  if (!rawMeta) {
    return { text: visible };
  }
  try {
    const parsed = JSON.parse(rawMeta) as {
      callId?: unknown;
      toolName?: unknown;
      phase?: unknown;
      filePath?: unknown;
      added?: unknown;
      deleted?: unknown;
    };
    const callId = typeof parsed.callId === "string" ? parsed.callId : undefined;
    const toolName = typeof parsed.toolName === "string" ? parsed.toolName : undefined;
    const phase = parsed.phase === "call" || parsed.phase === "result" ? parsed.phase : undefined;
    const filePath = typeof parsed.filePath === "string" ? parsed.filePath : undefined;
    const added = typeof parsed.added === "number" ? parsed.added : undefined;
    const deleted = typeof parsed.deleted === "number" ? parsed.deleted : undefined;
    return {
      text: visible,
      meta:
        toolName !== undefined ||
        phase !== undefined ||
        filePath !== undefined ||
        added !== undefined ||
        deleted !== undefined
          ? { callId, toolName, phase, filePath, added, deleted }
          : undefined
    };
  } catch {
    return { text: visible };
  }
}

export function agentEventTimelineRole(event: AgentEvent): "status" | "error" {
  return event.type === "error" ? "error" : "status";
}


export function transcriptLineToTimelineEntry(
  line: AgentSessionTranscriptLine,
  seq: number
): TimelineEntry | null {
  const id = `persisted-${line.at}-${seq}`;
  if (line.kind === "user") {
    const visible = transcriptUserBubbleText(line.text);
    if (visible == null || !visible.trim()) {
      return null;
    }
    return { id, role: "user", text: stripIntakeUiMarkers(visible) };
  }
  if (line.kind === "assistant") {
    const body = stripIntakeUiMarkers(line.text).trim();
    if (!body) {
      return null;
    }
    return { id, role: "agent", text: body };
  }

  if (line.kind === "thinking") {
    const body = stripIntakeUiMarkers(line.text).trim();
    if (!body) {
      return null;
    }
    return {
      id,
      role: "status",
      text: "Thought from transcript",
      reasoningMode: "summary",
      reasoningFullText: body
    };
  }

  if (line.kind === "tool_status") {
    const body = stripIntakeUiMarkers(line.text).trim();
    if (!body) {
      return null;
    }
    const parsed = parseToolStatusMessage(body);
    return {
      id,
      role: "status",
      text: parsed.text,
      ...(parsed.meta ? { toolStatusMeta: parsed.meta } : {})
    };
  }

  const body = stripIntakeUiMarkers(line.text).trim();
  if (!body) {
    return null;
  }
  return { id, role: "status", text: body };
}
