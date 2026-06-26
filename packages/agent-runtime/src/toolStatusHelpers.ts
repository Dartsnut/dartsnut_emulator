import type { AgentEvent } from "@dartsnut/shared-ipc";

export const TOOL_STATUS_META_PREFIX = " @@tool_status_meta@@";

export type ToolStatusPhase = "call" | "result";

export type ToolStatusMeta = {
  callId?: string;
  toolName?: string;
  phase?: ToolStatusPhase;
  filePath?: string;
  added?: number;
  deleted?: number;
  skillId?: string;
};

export type ToolStatusContext = {
  callId?: string;
  path?: string;
  source?: string;
  added?: number;
  deleted?: number;
  skillId?: string;
};

export function toRelPath(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : undefined;
}

export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split(/\r?\n/).length;
}

export function computeWriteDiff(
  previousContent: string | undefined,
  nextContent: string
): { added: number; deleted: number } {
  const nextLines = countLines(nextContent);
  const prevLines = typeof previousContent === "string" ? countLines(previousContent) : 0;
  return {
    added: Math.max(0, nextLines),
    deleted: Math.max(0, prevLines)
  };
}

export function computeReplaceDiff(findText: string, replaceText: string): { added: number; deleted: number } {
  const removed = countLines(findText);
  const added = countLines(replaceText);
  return { added, deleted: removed };
}

export function buildToolStatusMessage(
  name: string,
  phase: ToolStatusPhase,
  context?: ToolStatusContext
): { text: string; meta?: ToolStatusMeta } {
  const filePath = context?.path;
  const baseMeta: ToolStatusMeta | undefined =
    filePath || typeof context?.added === "number" || typeof context?.deleted === "number"
      ? {
        callId: context?.callId,
        toolName: name,
        phase,
        filePath,
        added: context?.added,
        deleted: context?.deleted,
        skillId: context?.skillId
      }
      : { callId: context?.callId, toolName: name, phase, skillId: context?.skillId };

  switch (name) {
    case "list_files":
      return { text: phase === "call" ? "Listing files…" : "Listed files.", meta: baseMeta };
    case "grep_files":
      return { text: phase === "call" ? "Searching files…" : "Searched files.", meta: baseMeta };
    case "glob_files":
      return { text: phase === "call" ? "Finding files…" : "Found files.", meta: baseMeta };
    case "read_file":
      return {
        text: phase === "call" ? `Reading ${filePath ?? "file"}…` : `Read ${filePath ?? "file"}.`,
        ...(baseMeta ? { meta: baseMeta } : {})
      };
    case "write_file":
      return {
        text: phase === "call" ? `Creating ${filePath ?? "file"}…` : `Created ${filePath ?? "file"}.`,
        ...(baseMeta ? { meta: baseMeta } : {})
      };
    case "replace_in_file":
      return {
        text: phase === "call" ? `Editing ${filePath ?? "file"}…` : `Edited ${filePath ?? "file"}.`,
        ...(baseMeta ? { meta: baseMeta } : {})
      };
    case "copy_asset_file": {
      const source = context?.source ?? "asset";
      return {
        text:
          phase === "call"
            ? `Copying ${source} to ${filePath ?? "destination"}…`
            : `Copied ${source} → ${filePath ?? "destination"}.`,
        ...(baseMeta ? { meta: baseMeta } : {})
      };
    }
    case "get_dartsnut_skill":
      return { text: phase === "call" ? "Loading Dartsnut skill…" : "Loaded Dartsnut skill.", meta: baseMeta };
    case "dartsnut_ask_question":
      return { text: phase === "call" ? "Asking question…" : "Recorded answer.", meta: baseMeta };
    case "dartsnut_project_intake":
      return { text: phase === "call" ? "Updating project intake…" : "Updated project intake.", meta: baseMeta };
    case "reload_emulator":
      return { text: phase === "call" ? "Reloading emulator…" : "Reloaded emulator.", meta: baseMeta };
    case "get_emulator_logs":
      return { text: phase === "call" ? "Fetching emulator logs…" : "Fetched emulator logs.", meta: baseMeta };
    case "check_python":
      return { text: phase === "call" ? "Checking Python…" : "Checked Python.", meta: baseMeta };
    default:
      return { text: phase === "call" ? `Running ${name}…` : `Finished ${name}.`, meta: baseMeta };
  }
}

export function encodeToolStatusForTransport(message: { text: string; meta?: ToolStatusMeta }): string {
  if (!message.meta) {
    return message.text;
  }
  return `${message.text}${TOOL_STATUS_META_PREFIX}${JSON.stringify(message.meta)}`;
}

export function emitToolStatusEvent(
  name: string,
  phase: ToolStatusPhase,
  onEvent: (event: AgentEvent) => void,
  context?: ToolStatusContext,
  persist?: (kind: "tool_status", text: string) => void
): void {
  const formatted = buildToolStatusMessage(name, phase, context);
  const transportMessage = encodeToolStatusForTransport(formatted);
  onEvent({
    type: "status",
    at: Date.now(),
    message: transportMessage
  });
  if (name !== "get_dartsnut_skill" || phase === "result") {
    persist?.("tool_status", transportMessage);
  }
}

export function safeParseObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

export function extractPathFromArgumentsJson(argumentsJson: string): string | undefined {
  if (!argumentsJson.trim()) {
    return undefined;
  }
  try {
    const parsed = safeParseObject(JSON.parse(argumentsJson));
    return toRelPath(parsed.path);
  } catch {
    const match = argumentsJson.match(/"path"\s*:\s*"([^"]*)"?/);
    if (!match) {
      return undefined;
    }
    try {
      return toRelPath(JSON.parse(`"${match[1]}"`));
    } catch {
      return toRelPath(match[1]);
    }
  }
}
