import type { AgentModelConfig } from "@dartsnut/agent-runtime";

const MAX_TITLE_INPUT_CHARS = 4_000;
const MAX_TITLE_CHARS = 80;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [["\"", "\""], ["'", "'"], ["`", "`"], ["“", "”"], ["‘", "’"]];
  for (const [open, close] of pairs) {
    if (value.startsWith(open) && value.endsWith(close) && value.length > open.length + close.length) {
      return value.slice(open.length, -close.length).trim();
    }
  }
  return value;
}

export function fallbackChatTitle(firstUserMessage: string): string {
  const collapsed = collapseWhitespace(firstUserMessage);
  return collapsed ? collapsed.slice(0, MAX_TITLE_CHARS).trim() : "New chat";
}

export function sanitizeGeneratedChatTitle(output: string, firstUserMessage: string): string {
  const firstLine = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const cleaned = collapseWhitespace(trimWrappingQuotes(firstLine))
    .replace(/[.!?。！？]+$/u, "")
    .trim()
    .slice(0, MAX_TITLE_CHARS)
    .trim();
  return cleaned || fallbackChatTitle(firstUserMessage);
}

export function buildChatTitlePrompt(firstUserMessage: string): string {
  const message = firstUserMessage.trim().slice(0, MAX_TITLE_INPUT_CHARS);
  return [
    "Generate a concise title for this chat based only on the user's first message.",
    "Rules:",
    "- Use the same language as the user.",
    "- Use 3 to 7 words.",
    "- Do not use quotes.",
    "- Do not end with punctuation.",
    "- Return only the title.",
    "",
    "First user message:",
    message
  ].join("\n");
}

function responsesUrl(baseUrl: string | undefined): string {
  const trimmed = (baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1";
    return `${url.toString().replace(/\/+$/, "")}/responses`;
  } catch {
    return `${trimmed}/responses`;
  }
}

function responseOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const response = payload as { output_text?: unknown; output?: unknown };
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return "";
  for (const item of response.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) return text;
    }
  }
  return "";
}

export async function generateChatTitle(
  modelConfig: AgentModelConfig,
  firstUserMessage: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const fallback = fallbackChatTitle(firstUserMessage);
  if (!firstUserMessage.trim()) return fallback;
  if (!modelConfig.model || !modelConfig.apiKey) return fallback;
  try {
    const fetchImpl = modelConfig.fetchImpl ?? fetch;
    const response = await fetchImpl(responsesUrl(modelConfig.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${modelConfig.apiKey}`
      },
      signal: abortSignal,
      body: JSON.stringify({
        model: modelConfig.model,
        input: buildChatTitlePrompt(firstUserMessage),
        tools: [],
        store: false,
        max_output_tokens: 64
      })
    });
    if (!response.ok) return fallback;
    return sanitizeGeneratedChatTitle(responseOutputText(await response.json()), firstUserMessage);
  } catch {
    return fallback;
  }
}
