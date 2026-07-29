import type { AgentEvent, AgentSessionTranscriptLine } from "@dartsnut/shared-ipc";
import { stripIntakeUiMarkers, transcriptUserBubbleText } from "@dartsnut/shared-ipc";

export interface TimelineErrorPresentation {
  title: string;
  message: string;
  technicalDetail?: string;
}

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
    skillId?: string;
    skillIds?: string[];
  };
}

export function formatAgentEventForTimeline(event: AgentEvent): string {
  if (event.type === "error") {
    return event.message;
  }
  if (event.type === "tool_call_delta") {
    const pathText = event.path ? ` ${event.path}` : "";
    return `[tool_call_delta] ${event.toolName}${pathText} (${event.argumentsJson.length} chars streamed)`;
  }
  return JSON.stringify(event, null, 2);
}

const TOOL_STATUS_META_PREFIX = " @@tool_status_meta@@";

function errorMessageFromTimelineText(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Older timeline entries may contain plain text that starts with a brace.
  }
  return trimmed;
}

export function describeTimelineError(input: string): TimelineErrorPresentation {
  const message = errorMessageFromTimelineText(input);
  const normalized = message.toLowerCase();

  if (normalized.includes("daily dartsnut llm token limit") || normalized.includes("daily_quota_exceeded")) {
    return {
      title: "Daily token limit reached",
      message: "This account has used today’s Dartsnut LLM allowance. New runs unlock at 00:00 UTC."
    };
  }
  if (
    normalized.includes("token verification failed") ||
    normalized.includes("please sign in again") ||
    normalized.includes("auth_required")
  ) {
    return {
      title: "Sign-in expired",
      message: "Sign in again from the account menu, then retry this request."
    };
  }
  if (normalized.includes("bound machine") || normalized.includes("no_bound_machine")) {
    return {
      title: "Machine binding required",
      message: "Bind a Dartsnut machine to this account before starting another agent run."
    };
  }
  if (normalized.includes("another dartsnut llm run") || normalized.includes("run_already_active")) {
    return {
      title: "Another run is active",
      message: "Wait for the current agent run to finish, then try again."
    };
  }
  if (
    normalized.includes("distributor") ||
    normalized.includes("无可用渠道") ||
    /(^|\s)503(\s|$)/.test(normalized)
  ) {
    return {
      title: "Model route unavailable",
      message: "Dartsnut LLM could not find an available model channel. Try again shortly.",
      technicalDetail: message
    };
  }
  if (normalized.includes("temporarily unavailable") || normalized.includes("service_unavailable")) {
    return {
      title: "Service temporarily unavailable",
      message: "The model service did not accept this request. Try again in a moment.",
      technicalDetail: message
    };
  }

  if (/fetch failed|connection error|network error|enotfound|eai_again|econn(?:refused|reset|timedout)|socket hang up/.test(normalized)) {
    return {
      title: "Couldn’t reach the model service",
      message: "Check your internet connection, VPN, or firewall, then try again.",
      technicalDetail: message
    };
  }

  const looksTechnical = message.length > 180 || /request id|\b[45]\d\d\b/i.test(message);
  return {
    title: "Agent run interrupted",
    message: looksTechnical ? "The model request could not be completed." : message || "The agent run stopped unexpectedly.",
    ...(looksTechnical ? { technicalDetail: message } : {})
  };
}

export function parseToolStatusMessage(input: string): {
  text: string;
  meta?: {
    callId?: string;
    toolName?: string;
    phase?: "call" | "result";
    filePath?: string;
    added?: number;
    deleted?: number;
    skillId?: string;
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
      skillId?: unknown;
    };
    const callId = typeof parsed.callId === "string" ? parsed.callId : undefined;
    const toolName = typeof parsed.toolName === "string" ? parsed.toolName : undefined;
    const phase = parsed.phase === "call" || parsed.phase === "result" ? parsed.phase : undefined;
    const filePath = typeof parsed.filePath === "string" ? parsed.filePath : undefined;
    const added = typeof parsed.added === "number" ? parsed.added : undefined;
    const deleted = typeof parsed.deleted === "number" ? parsed.deleted : undefined;
    const skillId = typeof parsed.skillId === "string" ? parsed.skillId : undefined;
    return {
      text: visible,
      meta:
        toolName !== undefined ||
        phase !== undefined ||
        filePath !== undefined ||
        added !== undefined ||
        deleted !== undefined ||
        skillId !== undefined
          ? { callId, toolName, phase, filePath, added, deleted, skillId }
          : undefined
    };
  } catch {
    return { text: visible };
  }
}

export function shouldHideTimelineStatus(input: {
  text: string;
  toolStatusMeta?: {
    toolName?: string;
  };
}): boolean {
  const text = input.text.trim();
  return text === "Dartsnut Agent run started." || /^Agent:\s+\S/.test(text);
}

function timelineSkillIds(entry: TimelineEntry): string[] {
  const meta = entry.toolStatusMeta;
  if (!meta || meta.toolName !== "get_dartsnut_skill") {
    return [];
  }
  const ids = new Set<string>();
  if (Array.isArray(meta.skillIds)) {
    for (const id of meta.skillIds) {
      if (id.trim()) {
        ids.add(id.trim());
      }
    }
  }
  if (typeof meta.skillId === "string" && meta.skillId.trim()) {
    ids.add(meta.skillId.trim());
  }
  return [...ids];
}

export function mergeTimelineSkillStatusEntry(
  existing: TimelineEntry,
  next: TimelineEntry
): TimelineEntry {
  const skillIds = [...new Set([...timelineSkillIds(existing), ...timelineSkillIds(next)])];
  if (skillIds.length === 0) {
    return { ...existing, text: "Loaded Dartsnut skills." };
  }
  return {
    ...existing,
    text: `Loaded skills: ${skillIds.join(", ")}`,
    toolStatusMeta: {
      ...existing.toolStatusMeta,
      toolName: "get_dartsnut_skill",
      phase: "result",
      skillIds
    }
  };
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
    if (shouldHideTimelineStatus({ text: parsed.text, toolStatusMeta: parsed.meta })) {
      return null;
    }
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
