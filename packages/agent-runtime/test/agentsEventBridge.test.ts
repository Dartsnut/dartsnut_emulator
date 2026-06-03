import { describe, expect, it } from "vitest";
import type { RunStreamEvent } from "@openai/agents";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { mapAgentsStreamToAgentEvents } from "../src/agentsEventBridge";
import type { StreamedRunResult } from "@openai/agents";
import type { AgentEvent } from "@dartsnut/shared-ipc";

function createMockStream(events: RunStreamEvent[], finalOutput?: string): StreamedRunResult<any, any> {
  return {
    finalOutput,
    completed: Promise.resolve(),
    cancelled: false,
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    }
  } as StreamedRunResult<any, any>;
}

describe("agentsEventBridge", () => {
  it("maps chat completion chunks to stream, reasoning, and tool_call_delta events", async () => {
    const events: AgentEvent[] = [];
    const stream = createMockStream(
      [
        {
          type: "raw_model_stream_event",
          source: "openai-chat-completions",
          data: {
            type: "model",
            event: {
              choices: [
                {
                  index: 0,
                  delta: {
                    content: "Hello",
                    reasoning_content: "think",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        function: { name: "write_file", arguments: "{\"path\":\"a.txt\"" }
                      }
                    ]
                  }
                }
              ]
            } as ChatCompletionChunk,
            providerData: { rawModelEventSource: "openai-chat-completions" }
          }
        } as RunStreamEvent
      ],
      "Hello"
    );

    const result = await mapAgentsStreamToAgentEvents(stream, (event) => events.push(event));
    expect(result.finalText).toBe("Hello");
    expect(events.some((e) => e.type === "stream")).toBe(true);
    expect(events.some((e) => e.type === "reasoning_stream")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_delta")).toBe(true);
    expect(events.some((e) => e.type === "reasoning_done")).toBe(true);
  });
});
