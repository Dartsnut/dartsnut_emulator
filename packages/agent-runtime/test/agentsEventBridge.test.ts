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

  it("merges tool call chunks by index when id arrives after arguments", async () => {
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
                    tool_calls: [
                      {
                        index: 0,
                        function: { name: "write_file", arguments: "{\"path\":\"a.txt\"" }
                      }
                    ]
                  }
                }
              ]
            } as ChatCompletionChunk,
            providerData: { rawModelEventSource: "openai-chat-completions" }
          }
        } as RunStreamEvent,
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
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        function: { arguments: ",\"content\":\"line1\\nline2\"}" }
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
      ""
    );

    await mapAgentsStreamToAgentEvents(stream, (event) => events.push(event));
    const deltas = events.filter((e) => e.type === "tool_call_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.at(-1)).toMatchObject({
      type: "tool_call_delta",
      callId: "call_1",
      toolName: "write_file",
      path: "a.txt"
    });
  });

  it("does not overwrite streamed file tool UI with static call status", async () => {
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
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        function: { name: "write_file", arguments: "{\"path\":\"a.txt\",\"content\":\"x\"}" }
                      }
                    ]
                  }
                }
              ]
            } as ChatCompletionChunk,
            providerData: { rawModelEventSource: "openai-chat-completions" }
          }
        } as RunStreamEvent,
        {
          type: "run_item_stream_event",
          name: "tool_called",
          item: {
            rawItem: {
              name: "write_file",
              callId: "call_1",
              arguments: "{\"path\":\"a.txt\",\"content\":\"x\"}"
            }
          }
        } as RunStreamEvent
      ],
      ""
    );

    await mapAgentsStreamToAgentEvents(stream, (event) => events.push(event));
    const statusTexts = events
      .filter((e) => e.type === "status" && e.message.includes("Creating a.txt"))
      .map((e) => e.message);
    expect(statusTexts).toHaveLength(0);
    expect(events.some((e) => e.type === "tool_call_delta")).toBe(true);
  });

  it("emits status on agent handoff events", async () => {
    const events: AgentEvent[] = [];
    const activeAgents: string[] = [];
    const stream = createMockStream(
      [
        {
          type: "agent_updated_stream_event",
          agent: { name: "WidgetCreator" }
        } as RunStreamEvent,
        {
          type: "run_item_stream_event",
          name: "handoff_occurred",
          item: { agent: { name: "WidgetCreator" } }
        } as RunStreamEvent
      ],
      "done"
    );

    await mapAgentsStreamToAgentEvents(stream, (event) => events.push(event), {
      onActiveAgentChange: (name) => activeAgents.push(name)
    });
    expect(events.some((e) => e.type === "status" && e.message.includes("WidgetCreator"))).toBe(true);
    expect(activeAgents).toContain("WidgetCreator");
  });
});
