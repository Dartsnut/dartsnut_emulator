import { Agent, Runner } from "@openai/agents";
import { configureAgentsSdk, createModelRetrySettings, type AgentModelConfig } from "@dartsnut/agent-runtime";

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
    "Return only a title of 3 to 7 words in the user's language, without quotes or trailing punctuation.",
    "",
    "First user message:",
    message
  ].join("\n");
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
    const provider = configureAgentsSdk(modelConfig, { force: true });
    const titleAgent = new Agent({
      name: "ChatTitle",
      model: modelConfig.model,
      instructions: "Return only a short chat title. Never call tools.",
      tools: [],
      modelSettings: { store: false, maxTokens: 64, retry: createModelRetrySettings() }
    });
    const result = await new Runner({ modelProvider: provider }).run(
      titleAgent,
      buildChatTitlePrompt(firstUserMessage),
      { signal: abortSignal, maxTurns: 1 }
    );
    return sanitizeGeneratedChatTitle(typeof result.finalOutput === "string" ? result.finalOutput : "", firstUserMessage);
  } catch {
    return fallback;
  }
}
