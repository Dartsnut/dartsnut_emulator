import type { ParsedToolCall } from "./providerClient";

function decodeEscapedStreamingText(input: string): string {
  return input
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r");
}

function parseJsonStringValue(
  input: string,
  startQuoteIdx: number
): { value: string; nextIndex: number; closed: boolean } {
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

function readPartialStringField(argsJson: string, field: string): string | undefined {
  const key = argsJson.indexOf(`"${field}"`);
  if (key < 0) {
    return undefined;
  }
  const quote = argsJson.indexOf("\"", argsJson.indexOf(":", key));
  if (quote < 0) {
    return undefined;
  }
  return parseJsonStringValue(argsJson, quote).value;
}

/** Best-effort parse of in-flight native tool `arguments` JSON for file-write previews. */
export function parsePartialFileToolArguments(
  toolName: string,
  argumentsJson: string
): Record<string, string> | null {
  const trimmed = argumentsJson.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        out[key] = value;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    if (toolName !== "write_file" && toolName !== "replace_in_file") {
      return null;
    }
    const out: Record<string, string> = {};
    const path = readPartialStringField(trimmed, "path");
    if (path !== undefined) {
      out.path = path;
    }
    if (toolName === "write_file") {
      const content = readPartialStringField(trimmed, "content");
      if (content !== undefined) {
        out.content = content;
      }
    } else {
      const find = readPartialStringField(trimmed, "find");
      const replace = readPartialStringField(trimmed, "replace");
      if (find !== undefined) {
        out.find = find;
      }
      if (replace !== undefined) {
        out.replace = replace;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }
}

export function buildStreamingFileToolEnvelope(
  toolCalls: ParsedToolCall[],
  responseLead: string,
  readPreviousContent?: (path: string) => string | undefined
): string | null {
  const actions: Array<Record<string, unknown>> = [];
  for (const toolCall of toolCalls) {
    if (toolCall.name !== "write_file" && toolCall.name !== "replace_in_file") {
      continue;
    }
    const partial = parsePartialFileToolArguments(toolCall.name, toolCall.argumentsJson);
    if (!partial) {
      continue;
    }
    const action: Record<string, unknown> = { tool: toolCall.name, ...partial };
    if (
      toolCall.name === "write_file" &&
      typeof partial.path === "string" &&
      readPreviousContent
    ) {
      const previousContent = readPreviousContent(partial.path);
      if (previousContent !== undefined) {
        action.previousContent = previousContent;
      }
    }
    actions.push(action);
  }
  if (actions.length === 0) {
    return null;
  }
  const trimmedLead = responseLead.trim();
  const response =
    trimmedLead.length > 0
      ? responseLead
      : actions.length === 1
        ? "Writing file…"
        : "Writing files…";
  return JSON.stringify({ response, actions });
}
