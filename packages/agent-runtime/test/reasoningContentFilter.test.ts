import { describe, expect, it } from "vitest";
import { fixReasoningContentEcho } from "../src/reasoningContentFilter";
import { ProviderClient } from "../src/providerClient";
import type { ChatMessage } from "../src/providerClient";

describe("reasoningContentFilter", () => {
  it("preserves reasoning_content provider metadata for assistant replay", async () => {
    const filtered = await fixReasoningContentEcho({
      modelData: {
        input: [
          {
            type: "reasoning",
            content: [{ type: "input_text", text: "chain-of-thought" }],
            rawContent: [{ type: "reasoning_text", text: "chain-of-thought" }],
            providerData: { dartsnutReasoningContent: "chain-of-thought" }
          },
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "answer" }]
          }
        ],
        instructions: "test"
      },
      agent: {} as never,
      context: undefined
    });

    const assistant = filtered.input.find(
      (item) => item.type === "message" && item.role === "assistant"
    ) as { providerData?: Record<string, unknown> } | undefined;
    expect(assistant?.providerData?.reasoning_content).toBe("chain-of-thought");
  });

  it("matches ProviderClient wire replay shape for reasoning assistant turns", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "answer",
        reasoningContent: "thoughts"
      }
    ];
    const wire = (ProviderClient as unknown as { toWireMessages: (m: ChatMessage[]) => unknown[] }).toWireMessages(
      messages
    );
    const assistantWire = wire.find((entry) => (entry as { role?: string }).role === "assistant") as {
      reasoning_content?: string;
    };
    expect(assistantWire.reasoning_content).toBe("thoughts");
  });
});
