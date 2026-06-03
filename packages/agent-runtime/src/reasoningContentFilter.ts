import type { CallModelInputFilter } from "@openai/agents";
import type { AgentInputItem } from "@openai/agents";

const REASONING_PROVIDER_KEY = "dartsnutReasoningContent";

function readStoredReasoning(item: AgentInputItem): string | undefined {
  if (item.type === "reasoning") {
    const content = (item as { content?: Array<{ type?: string; text?: string }> }).content;
    if (Array.isArray(content)) {
      const joined = content
        .filter((part) => part?.type === "reasoning_text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      if (joined.length > 0) {
        return joined;
      }
    }
  }
  const providerData = (item as { providerData?: Record<string, unknown> }).providerData;
  const stored = providerData?.[REASONING_PROVIDER_KEY];
  return typeof stored === "string" && stored.length > 0 ? stored : undefined;
}

/**
 * Ensures prior thinking-mode assistant turns replay `reasoning_content` on Chat Completions wire format.
 */
export const fixReasoningContentEcho: CallModelInputFilter = ({ modelData }) => {
  const input = modelData.input.map((item) => {
    if (item.type !== "message" || item.role !== "assistant") {
      return item;
    }
    const reasoning = readStoredReasoning(item);
    if (!reasoning) {
      const priorReasoningItem = modelData.input.find(
        (candidate, index) =>
          index < modelData.input.indexOf(item) &&
          candidate.type === "reasoning" &&
          readStoredReasoning(candidate)
      );
      if (priorReasoningItem) {
        const text = readStoredReasoning(priorReasoningItem);
        if (text) {
          return {
            ...item,
            providerData: {
              ...(item.providerData ?? {}),
              [REASONING_PROVIDER_KEY]: text,
              reasoning_content: text
            }
          } as AgentInputItem;
        }
      }
      return item;
    }
    return {
      ...item,
      providerData: {
        ...(item.providerData ?? {}),
        [REASONING_PROVIDER_KEY]: reasoning,
        reasoning_content: reasoning
      }
    } as AgentInputItem;
  });
  return {
    input,
    instructions: modelData.instructions
  };
};
