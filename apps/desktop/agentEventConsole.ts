import { stripIntakeUiMarkers, type AgentEvent } from "@dartsnut/shared-ipc";

interface ParsedAction {
  tool: string;
  path?: string;
  isFileWrite: boolean;
  isToolPlan?: boolean;
}

interface FormattedAgentMessage {
  narrative: string;
  response: string | null;
  actions: ParsedAction[];
}

function decodeEscapedStreamingText(input: string): string {
  return input
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "");
}

function parseJsonStringValue(input: string, startQuoteIdx: number): { value: string; nextIndex: number; closed: boolean } {
  let escaped = false;
  let idx = startQuoteIdx + 1;
  while (idx < input.length) {
    const ch = input[idx];
    if (escaped) {
      escaped = false;
      idx += 1;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      idx += 1;
      continue;
    }
    if (ch === "\"") {
      const raw = input.slice(startQuoteIdx, idx + 1);
      try {
        return { value: JSON.parse(raw) as string, nextIndex: idx + 1, closed: true };
      } catch {
        return { value: input.slice(startQuoteIdx + 1, idx), nextIndex: idx + 1, closed: true };
      }
    }
    idx += 1;
  }
  const raw = `${input.slice(startQuoteIdx)}"`;
  try {
    return { value: JSON.parse(raw) as string, nextIndex: input.length, closed: false };
  } catch {
    return {
      value: decodeEscapedStreamingText(input.slice(startQuoteIdx + 1)),
      nextIndex: input.length,
      closed: false
    };
  }
}

function parsePartialAgentMessage(text: string): FormattedAgentMessage {
  const actions: ParsedAction[] = [];
  const jsonStart = text.indexOf("{");
  const narrative = jsonStart > 0 ? text.slice(0, jsonStart).trim() : "";
  let response: string | null = null;

  const responseKey = text.indexOf("\"response\"");
  if (responseKey >= 0) {
    const responseQuote = text.indexOf("\"", text.indexOf(":", responseKey));
    if (responseQuote >= 0) {
      response = parseJsonStringValue(text, responseQuote).value;
    }
  }

  let scanFrom = 0;
  while (scanFrom < text.length) {
    const toolKey = text.indexOf("\"tool\"", scanFrom);
    if (toolKey < 0) {
      break;
    }
    const toolQuote = text.indexOf("\"", text.indexOf(":", toolKey));
    if (toolQuote < 0) {
      break;
    }
    const parsedTool = parseJsonStringValue(text, toolQuote);
    const nextToolKey = text.indexOf("\"tool\"", parsedTool.nextIndex);
    const sectionEnd = nextToolKey >= 0 ? nextToolKey : text.length;

    const pathKey = text.indexOf("\"path\"", toolKey);
    let pathValue: string | undefined;
    if (pathKey >= 0 && pathKey < sectionEnd) {
      const pathQuote = text.indexOf("\"", text.indexOf(":", pathKey));
      if (pathQuote >= 0 && pathQuote < sectionEnd) {
        pathValue = parseJsonStringValue(text, pathQuote).value;
      }
    }

    if (parsedTool.value === "write_file" || parsedTool.value === "replace_in_file") {
      actions.push({
        tool: parsedTool.value,
        path: pathValue,
        isFileWrite: true
      });
    }

    if (parsedTool.value === "read_file" || parsedTool.value === "list_files") {
      actions.push({
        tool: parsedTool.value,
        path: pathValue,
        isFileWrite: false,
        isToolPlan: true
      });
    }

    scanFrom = parsedTool.nextIndex;
  }

  return { narrative, response, actions };
}

function formatAgentMessage(text: string): FormattedAgentMessage {
  const trimmed = text.trim();
  if (!trimmed) {
    return { narrative: "", response: null, actions: [] };
  }

  for (let idx = trimmed.indexOf("{"); idx >= 0; idx = trimmed.indexOf("{", idx + 1)) {
    const maybeJson = trimmed.slice(idx).trim();
    try {
      const parsed = JSON.parse(maybeJson) as {
        response?: string;
        actions?: Array<{ tool?: string; path?: string; content?: string }>;
      };
      const narrative = trimmed.slice(0, idx).trim();
      return {
        narrative,
        response: typeof parsed.response === "string" ? parsed.response : null,
        actions: Array.isArray(parsed.actions)
          ? parsed.actions.map((action) => ({
            tool: action.tool ?? "unknown",
            path: action.path,
            isFileWrite:
              action.tool === "write_file" ||
              action.tool === "replace_in_file" ||
              action.tool === "create_file",
            isToolPlan: action.tool === "read_file" || action.tool === "list_files"
          }))
          : []
      };
    } catch {
      // Keep scanning for a valid JSON block.
    }
  }

  return parsePartialAgentMessage(text);
}

function dedupeToolPlansLastWins(actions: ParsedAction[]): ParsedAction[] {
  const rev = [...actions].reverse();
  const seen = new Set<string>();
  const out: ParsedAction[] = [];
  for (const action of rev) {
    if (!action.isToolPlan) {
      continue;
    }
    const key = `${action.tool}\0${action.path ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(action);
  }
  out.reverse();
  return out;
}

function summarizeAction(action: ParsedAction): string {
  const path = action.path?.trim() ? ` ${action.path}` : " …";
  return `[${action.tool}]${path}`;
}

export function isStructuredAgentEnvelopeText(text: string): boolean {
  const trimmed = stripIntakeUiMarkers(text).trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.includes("\"response\"") && (trimmed.includes("\"tool\"") || trimmed.includes("\"actions\""))) {
    return true;
  }
  return trimmed.startsWith("{") && (trimmed.includes("\"response\"") || trimmed.includes("\"actions\""));
}

export function summarizeAgentTextForConsole(text: string): string[] {
  const displayText = stripIntakeUiMarkers(text).trim();
  if (!displayText) {
    return [];
  }

  const formatted = formatAgentMessage(displayText);
  const leadText = (formatted.response || formatted.narrative || "").trim();
  const fileActions = formatted.actions.filter((action) => action.isFileWrite);
  const planActions = dedupeToolPlansLastWins(formatted.actions);
  const lines = [
    ...(leadText ? [leadText] : []),
    ...planActions.map(summarizeAction),
    ...fileActions.map(summarizeAction)
  ];

  if (lines.length > 0) {
    return lines;
  }
  if (isStructuredAgentEnvelopeText(displayText)) {
    return [];
  }
  return [displayText];
}

export function formatAgentEventForConsole(
  event: AgentEvent
): { level: "debug" | "info" | "warn" | "error"; lines: string[] } | null {
  switch (event.type) {
    case "stream": {
      const lines = summarizeAgentTextForConsole(event.delta);
      return lines.length > 0 ? { level: "debug", lines } : null;
    }
    case "reasoning_stream": {
      const lines = summarizeAgentTextForConsole(event.delta);
      return lines.length > 0 ? { level: "debug", lines: lines.map((l) => `[reasoning] ${l}`) } : null;
    }
    case "reasoning_done":
      return { level: "debug", lines: ["[reasoning] done"] };
    case "final": {
      const lines = summarizeAgentTextForConsole(event.content);
      return lines.length > 0 ? { level: "info", lines } : null;
    }
    case "status":
      return event.message.trim() ? { level: "info", lines: [event.message.trim()] } : null;
    case "error":
      return event.message.trim() ? { level: "error", lines: [event.message.trim()] } : null;
    default:
      return null;
  }
}
