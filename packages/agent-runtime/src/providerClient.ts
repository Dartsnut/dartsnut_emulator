import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";
import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";
import type { ProviderConfig } from "./providerConfig";

/**
 * Mirrors the assistant `tool_calls` entry as it is sent back to the API in subsequent turns.
 */
export interface ToolCallEnvelope {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ChatMessage =
  | {
    role: "system" | "user";
    content: string;
  }
  | {
    role: "assistant";
    content: string;
    tool_calls?: ToolCallEnvelope[];
    /** MiMo / thinking-mode: replay on the next request as wire `reasoning_content`. */
    reasoningContent?: string;
  }
  | {
    role: "tool";
    tool_call_id: string;
    content: string;
  };

/** Parsed native tool call from chat completions (`tool_calls[]`). */
export interface ParsedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface CompletionResult {
  content: string;
  toolCalls: ParsedToolCall[];
  /** Thinking-mode (e.g. MiMo): must be echoed on follow-up turns as `reasoning_content`. */
  reasoningContent?: string;
  /** True when this round used OpenAI `stream: true` (incremental deltas); false for one-shot `stream: false`. */
  usedHttpStream?: boolean;
}

export interface CompletionOptions {
  tools?: ChatCompletionTool[];
  onChunk?: (delta: string) => void;
  /** Thinking-mode: stream wire `reasoning_content` deltas (and one-shot flush in non-streaming path). */
  onReasoningChunk?: (delta: string) => void;
  /** Incremental native `tool_calls` argument JSON while HTTP streaming (for file-write rolling UI). */
  onToolCallProgress?: (toolCalls: ParsedToolCall[]) => void;
}

export interface CompletionProvider {
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult>;
}

interface StreamingToolCallAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIToolCallMessage {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

function readReasoningContent(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const m = message as Record<string, unknown>;
  const rc = m.reasoning_content;
  if (typeof rc === "string" && rc.length > 0) {
    return rc;
  }
  const r = m.reasoning;
  if (typeof r === "string" && r.length > 0) {
    return r;
  }
  return undefined;
}

function readReasoningDelta(delta: unknown): string {
  if (!delta || typeof delta !== "object") {
    return "";
  }
  const d = delta as Record<string, unknown>;
  const rc = d.reasoning_content;
  if (typeof rc === "string" && rc.length > 0) {
    return rc;
  }
  const r = d.reasoning;
  if (typeof r === "string" && r.length > 0) {
    return r;
  }
  return "";
}

/** Default cap so a hung provider does not leave the UI stuck forever. */
const DEFAULT_CHAT_COMPLETION_TIMEOUT_MS = 180_000;

/**
 * OpenAI Chat Completions client (official `openai` SDK). Compatible with OpenAI and
 * OpenAI-compatible gateways (e.g. Xiaomi MiMo token plan).
 *
 * **MiMo thinking mode:** responses may include `reasoning_content`. The next request must
 * echo it on the assistant turn or the API returns `400 Param Incorrect` (upstream:
 * "The reasoning_content in the thinking mode must be passed back to the API."). We
 * accumulate and replay it through `ChatMessage.reasoningContent` / wire `reasoning_content`.
 *
 * **HTTP streaming:** Uses `stream: true` whenever `onChunk`, `onReasoningChunk`, or `onToolCallProgress` is provided,
 * including after `role: "tool"` messages, so `reasoning_content` / content arrive incrementally.
 * Callers without stream callbacks get a one-shot `stream: false` completion.
 */
export class ProviderClient implements CompletionProvider {
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(private readonly config: ProviderConfig) {
    const timeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS) || DEFAULT_CHAT_COMPLETION_TIMEOUT_MS;
    this.model = config.model;
    this.openai = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: timeoutMs,
      maxRetries: 0,
      ...(config.fetchImpl ? { fetch: config.fetchImpl } : {})
    });
  }

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<CompletionResult> {
    const { tools, onChunk, onReasoningChunk, onToolCallProgress } = options;
    const timeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS) || DEFAULT_CHAT_COMPLETION_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    const requestMessages = ProviderClient.toWireMessages(messages);

    const useStreaming = Boolean(onChunk || onReasoningChunk || onToolCallProgress);

    const common = {
      model: this.model,
      messages: requestMessages,
      temperature: 0.2,
      ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" as const } : {})
    };

    if (!useStreaming) {
      const response = await this.openai.chat.completions.create({ ...common, stream: false }, { signal });
      const message = response.choices[0]?.message;
      const content = typeof message?.content === "string" ? message.content : "";
      const toolCalls = ProviderClient.normalizeToolCallsMessage(
        message?.tool_calls as OpenAIToolCallMessage[] | undefined
      );
      const trimmed = content.trim();
      const reasoningContent = readReasoningContent(message);
      if (onReasoningChunk && reasoningContent !== undefined && reasoningContent.length > 0) {
        onReasoningChunk(reasoningContent);
      }
      if (onChunk && trimmed.length > 0) {
        onChunk(trimmed);
      }
      return {
        content: trimmed,
        toolCalls,
        usedHttpStream: false,
        ...(reasoningContent !== undefined ? { reasoningContent } : {})
      };
    }

    const notifyChunk = onChunk ?? ((_delta: string) => {});
    const notifyReasoning = onReasoningChunk;
    const stream = await this.openai.chat.completions.create({ ...common, stream: true }, { signal });
    let fullText = "";
    let fullReasoning = "";
    const toolCallAccumulators = new Map<number, StreamingToolCallAccumulator>();
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) {
        continue;
      }
      const contentDelta = delta.content ?? "";
      if (contentDelta) {
        fullText += contentDelta;
        notifyChunk(contentDelta);
      }
      const reasoningDelta = readReasoningDelta(delta);
      if (reasoningDelta) {
        fullReasoning += reasoningDelta;
        if (notifyReasoning) {
          notifyReasoning(reasoningDelta);
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        ProviderClient.mergeToolCallDeltas(toolCallAccumulators, delta.tool_calls as OpenAIToolCallDelta[]);
        if (onToolCallProgress) {
          const orderedIndices = Array.from(toolCallAccumulators.keys()).sort((a, b) => a - b);
          const progressCalls: ParsedToolCall[] = orderedIndices
            .map((index) => toolCallAccumulators.get(index)!)
            .filter((entry) => entry.name.length > 0)
            .map((entry, position) => ({
              id: entry.id || `call_${position}`,
              name: entry.name,
              argumentsJson: entry.argumentsJson
            }));
          if (progressCalls.length > 0) {
            onToolCallProgress(progressCalls);
          }
        }
      }
    }

    const orderedIndices = Array.from(toolCallAccumulators.keys()).sort((a, b) => a - b);
    const toolCalls: ParsedToolCall[] = orderedIndices
      .map((index) => toolCallAccumulators.get(index)!)
      .filter((entry) => entry.name.length > 0)
      .map((entry, position) => ({
        id: entry.id || `call_${position}`,
        name: entry.name,
        argumentsJson: entry.argumentsJson
      }));

    const trimmed = fullText.trim();
    return {
      content: trimmed,
      toolCalls,
      usedHttpStream: true,
      ...(fullReasoning.length > 0 ? { reasoningContent: fullReasoning } : {})
    };
  }

  private static toWireMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
    return messages.map((message) => {
      if (message.role !== "assistant" || message.reasoningContent === undefined) {
        return message as ChatCompletionMessageParam;
      }
      const { reasoningContent, ...rest } = message;
      return {
        role: "assistant" as const,
        content: rest.content,
        ...(rest.tool_calls && rest.tool_calls.length > 0 ? { tool_calls: rest.tool_calls } : {}),
        reasoning_content: reasoningContent
      } as ChatCompletionMessageParam;
    });
  }

  private static normalizeToolCallsMessage(toolCalls: OpenAIToolCallMessage[] | undefined): ParsedToolCall[] {
    if (!Array.isArray(toolCalls)) {
      return [];
    }
    const parsed: ParsedToolCall[] = [];
    for (let i = 0; i < toolCalls.length; i += 1) {
      const entry = toolCalls[i];
      const name = entry?.function?.name;
      if (typeof name !== "string" || name.length === 0) {
        continue;
      }
      const id = typeof entry?.id === "string" && entry.id.length > 0 ? entry.id : `call_${i}`;
      const argumentsJson =
        typeof entry?.function?.arguments === "string" ? entry.function.arguments : "";
      parsed.push({ id, name, argumentsJson });
    }
    return parsed;
  }

  private static mergeToolCallDeltas(
    accumulators: Map<number, StreamingToolCallAccumulator>,
    deltas: OpenAIToolCallDelta[]
  ): void {
    for (let i = 0; i < deltas.length; i += 1) {
      const delta = deltas[i];
      if (!delta) {
        continue;
      }
      const index = typeof delta.index === "number" ? delta.index : i;
      const existing =
        accumulators.get(index) ?? { id: "", name: "", argumentsJson: "" };
      if (typeof delta.id === "string" && delta.id.length > 0) {
        existing.id = delta.id;
      }
      const fn = delta.function;
      if (fn) {
        if (typeof fn.name === "string" && fn.name.length > 0) {
          existing.name = fn.name;
        }
        if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
          existing.argumentsJson += fn.arguments;
        }
      }
      accumulators.set(index, existing);
    }
  }
}
