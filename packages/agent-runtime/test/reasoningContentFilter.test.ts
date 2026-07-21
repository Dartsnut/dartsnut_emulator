import { describe, expect, it } from "vitest";
import {
  createSafeCallModelInputFilter,
  EMPTY_MODEL_RESPONSE_MESSAGE
} from "../src/reasoningContentFilter";
import { ProviderClient } from "../src/providerClient";
import type { ChatMessage } from "../src/providerClient";

describe("reasoningContentFilter", () => {
  it("preserves reasoning_content provider metadata for assistant replay", async () => {
    const filtered = await createSafeCallModelInputFilter()({
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

  it("rejects an immediately repeated model input before another provider call", async () => {
    const filter = createSafeCallModelInputFilter();
    const args = {
      modelData: {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "build" }] }],
        instructions: "test"
      },
      agent: {} as never,
      context: undefined
    } as Parameters<typeof filter>[0];

    await expect(filter(args)).resolves.toMatchObject({ instructions: "test" });
    await expect(filter(args)).rejects.toThrow(EMPTY_MODEL_RESPONSE_MESSAGE);
  });

  it("allows the next model call when conversation input has progressed", async () => {
    const filter = createSafeCallModelInputFilter();
    const base = {
      modelData: {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "build" }] }],
        instructions: "test"
      },
      agent: {} as never,
      context: undefined
    } as Parameters<typeof filter>[0];

    await filter(base);
    await expect(
      filter({
        ...base,
        modelData: {
          ...base.modelData,
          input: [
            ...base.modelData.input,
            {
              type: "function_call_result",
              name: "read_file",
              callId: "call_1",
              status: "completed",
              output: { type: "text", text: "ok" }
            }
          ]
        }
      } as Parameters<typeof filter>[0])
    ).resolves.toMatchObject({ instructions: "test" });
  });
});
