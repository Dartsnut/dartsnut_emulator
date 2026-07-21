import { createHash } from "node:crypto";
import type { CallModelInputFilter } from "@openai/agents";
import type { AgentInputItem } from "@openai/agents";

const REASONING_PROVIDER_KEY = "dartsnutReasoningContent";

export const EMPTY_MODEL_RESPONSE_MESSAGE =
  "The model returned no assistant response. The run was stopped to prevent a retry loop.";

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

function fingerprintModelInput(modelData: { input: AgentInputItem[]; instructions?: string }): string {
  return createHash("sha256")
    .update(JSON.stringify({ input: modelData.input, instructions: modelData.instructions ?? "" }))
    .digest("hex");
}

/**
 * Adds a per-run no-progress guard to the reasoning replay filter.
 *
 * The Agents SDK calls the model again with identical input when a completion
 * produces no message or tool call. Reject that second request before it can
 * reach the provider and repeat indefinitely.
 */
export function createSafeCallModelInputFilter(): CallModelInputFilter {
  let previousFingerprint: string | null = null;

  return async (args) => {
    const filtered = await fixReasoningContentEcho(args);
    const fingerprint = fingerprintModelInput(filtered);
    if (fingerprint === previousFingerprint) {
      throw new Error(EMPTY_MODEL_RESPONSE_MESSAGE);
    }
    previousFingerprint = fingerprint;
    return filtered;
  };
}
