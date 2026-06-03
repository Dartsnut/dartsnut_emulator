import type { AgentInputItem } from "@openai/agents";
import type { ChatMessage, ToolCallEnvelope } from "./providerClient";

const REASONING_PROVIDER_KEY = "dartsnutReasoningContent";

function readReasoningFromItem(item: AgentInputItem): string | undefined {
  if (item.type === "reasoning") {
    const reasoningItem = item as {
      content?: Array<{ type?: string; text?: string }>;
      rawContent?: Array<{ type?: string; text?: string }>;
      providerData?: Record<string, unknown>;
    };
    const fromRaw = reasoningItem.rawContent
      ?.filter((part) => part?.type === "reasoning_text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    if (fromRaw && fromRaw.length > 0) {
      return fromRaw;
    }
    const fromContent = reasoningItem.content
      ?.filter((part) => typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    if (fromContent && fromContent.length > 0) {
      return fromContent;
    }
  }
  const providerData = (item as { providerData?: Record<string, unknown> }).providerData;
  const stored = providerData?.[REASONING_PROVIDER_KEY];
  return typeof stored === "string" && stored.length > 0 ? stored : undefined;
}

function assistantTextFromItem(item: Extract<AgentInputItem, { role: "assistant" }>): string {
  const content = item.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => (part?.type === "output_text" && typeof part.text === "string" ? [part.text] : []))
    .join("");
}

export function chatMessagesToAgentInputItems(messages: ChatMessage[]): AgentInputItem[] {
  const out: AgentInputItem[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      out.push({
        type: "message",
        role: "system",
        content: message.content
      });
      continue;
    }
    if (message.role === "user") {
      out.push({
        type: "message",
        role: "user",
        content: message.content
      });
      continue;
    }
    if (message.role === "tool") {
      out.push({
        type: "function_call_result",
        name: "tool",
        callId: message.tool_call_id,
        status: "completed",
        output: message.content
      });
      continue;
    }
    if (message.role === "assistant") {
      if (message.reasoningContent) {
        out.push({
          type: "reasoning",
          content: [{ type: "input_text", text: message.reasoningContent }],
          rawContent: [{ type: "reasoning_text", text: message.reasoningContent }],
          providerData: { [REASONING_PROVIDER_KEY]: message.reasoningContent }
        });
      }
      const text = message.content?.trim() ?? "";
      if (text.length > 0) {
        out.push({
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text }]
        });
      }
      if (message.tool_calls) {
        for (const call of message.tool_calls) {
          out.push({
            type: "function_call",
            callId: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
            status: "completed"
          });
        }
      }
    }
  }
  return out;
}

export function agentInputItemsToChatMessages(items: AgentInputItem[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pendingAssistant: {
    content: string;
    tool_calls?: ToolCallEnvelope[];
    reasoningContent?: string;
  } | null = null;

  const flushAssistant = (): void => {
    if (!pendingAssistant) {
      return;
    }
    out.push({
      role: "assistant",
      content: pendingAssistant.content,
      ...(pendingAssistant.tool_calls && pendingAssistant.tool_calls.length > 0
        ? { tool_calls: pendingAssistant.tool_calls }
        : {}),
      ...(pendingAssistant.reasoningContent ? { reasoningContent: pendingAssistant.reasoningContent } : {})
    });
    pendingAssistant = null;
  };

  for (const item of items) {
    if (item.type === "message" && item.role === "system") {
      flushAssistant();
      out.push({ role: "system", content: typeof item.content === "string" ? item.content : "" });
      continue;
    }
    if (item.type === "message" && item.role === "user") {
      flushAssistant();
      out.push({
        role: "user",
        content: typeof item.content === "string" ? item.content : ""
      });
      continue;
    }
    if (item.type === "reasoning") {
      if (!pendingAssistant) {
        pendingAssistant = { content: "" };
      }
      const reasoning = readReasoningFromItem(item);
      if (reasoning) {
        pendingAssistant.reasoningContent = reasoning;
      }
      continue;
    }
    if (item.type === "message" && item.role === "assistant") {
      if (!pendingAssistant) {
        pendingAssistant = { content: "" };
      }
      pendingAssistant.content = assistantTextFromItem(item);
      continue;
    }
    if (item.type === "function_call") {
      if (!pendingAssistant) {
        pendingAssistant = { content: "" };
      }
      const calls = pendingAssistant.tool_calls ?? [];
      calls.push({
        id: item.callId,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments
        }
      });
      pendingAssistant.tool_calls = calls;
      continue;
    }
    if (item.type === "function_call_result") {
      flushAssistant();
      const output =
        typeof item.output === "string"
          ? item.output
          : JSON.stringify(item.output ?? "");
      out.push({
        role: "tool",
        tool_call_id: item.callId,
        content: output
      });
    }
  }
  flushAssistant();
  return out;
}
