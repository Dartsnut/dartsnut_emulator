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

  it("keeps unindexed tool call deltas with different ids separate", async () => {
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
                        id: "call_conf",
                        function: { name: "write_file", arguments: "{\"path\":\"conf.json\",\"content\":\"{}\"}" }
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
                        id: "call_main",
                        function: { name: "write_file", arguments: "{\"path\":\"main.py\",\"content\":\"print(" }
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
                        id: "call_main",
                        function: { arguments: "\\\"ok\\\")\"}" }
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

    expect(deltas.some((event) => event.callId === "call_conf" && event.path === "conf.json")).toBe(true);
    expect(deltas.some((event) => event.callId === "call_main" && event.path === "main.py")).toBe(true);
    expect(
      deltas.some(
        (event) =>
          event.callId === "call_main" &&
          event.argumentsJson.includes("conf.json") &&
          event.argumentsJson.includes("main.py")
      )
    ).toBe(false);
  });

  it("keeps unindexed streamed tool calls separate when ids are missing", async () => {
    const events: AgentEvent[] = [];
    const rawToolCalls = [
      { function: { name: "get_dartsnut_skill", arguments: "{\"skill_id\":\"caveman\"}" } },
      { function: { name: "dartsnut_project_intake", arguments: "{\"action\":\"set_project_type\"}" } },
      { function: { name: "dartsnut_ask_question", arguments: "{\"question_id\":\"widget_display_size\"}" } },
      { function: { name: "glob_files", arguments: "{\"pattern\":\"*\",\"max_results\":100}" } },
      { function: { name: "write_file", arguments: "{\"content\":\"{}\",\"path\":\"conf.json\"}" } },
      { function: { name: "write_file", arguments: "{\"content\":\"print(" } },
      { function: { arguments: "\\\"ok\\\")\",\"path\":\"main.py\"}" } }
    ];
    const stream = createMockStream(
      rawToolCalls.map(
        (toolCall) =>
          ({
            type: "raw_model_stream_event",
            source: "openai-chat-completions",
            data: {
              type: "model",
              event: {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [toolCall]
                    }
                  }
                ]
              } as ChatCompletionChunk,
              providerData: { rawModelEventSource: "openai-chat-completions" }
            }
          }) as RunStreamEvent
      ),
      ""
    );

    await mapAgentsStreamToAgentEvents(stream, (event) => events.push(event));
    const deltas = events.filter((e) => e.type === "tool_call_delta");

    expect(deltas.some((event) => event.path === "conf.json")).toBe(true);
    expect(deltas.some((event) => event.path === "main.py")).toBe(true);
    expect(
      deltas.some(
        (event) =>
          event.path === "conf.json" &&
          event.argumentsJson.includes("main.py") &&
          event.argumentsJson.includes("get_dartsnut_skill")
      )
    ).toBe(false);
  });

  it("resets indexed tool call accumulation when a new model response starts", async () => {
    const events: AgentEvent[] = [];
    const stream = createMockStream(
      [
        {
          type: "raw_model_stream_event",
          source: "openai-chat-completions",
          data: {
            type: "model",
            event: {
              id: "chatcmpl_skill",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { name: "get_dartsnut_skill", arguments: "{\"skill_id\":\"creator-incremental\"}" }
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
              id: "chatcmpl_file",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_main",
                        function: { name: "write_file", arguments: "{\"path\":\"main.py\",\"content\":\"print(" }
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
              id: "chatcmpl_file",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_main",
                        function: { arguments: "\\\"ok\\\")\"}" }
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
    const mainDeltas = events.filter((e) => e.type === "tool_call_delta" && e.callId === "call_main");

    expect(mainDeltas.at(-1)).toMatchObject({
      type: "tool_call_delta",
      path: "main.py",
      argumentsJson: "{\"path\":\"main.py\",\"content\":\"print(\\\"ok\\\")\"}"
    });
    expect(mainDeltas.some((event) => event.argumentsJson.includes("creator-incremental"))).toBe(false);
  });

  it("does not re-emit stale file deltas when later raw chunks update other tools", async () => {
    const events: AgentEvent[] = [];
    const stream = createMockStream(
      [
        {
          type: "raw_model_stream_event",
          source: "openai-chat-completions",
          data: {
            type: "model",
            event: {
              id: "chatcmpl_file",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_main",
                        function: { name: "write_file", arguments: "{\"path\":\"main.py\",\"content\":\"x\"}" }
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
              id: "chatcmpl_file",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 1,
                        id: "call_skill",
                        function: { name: "get_dartsnut_skill", arguments: "{\"skill_id\":\"conf-contract\"}" }
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
    const fileDeltas = events.filter((e) => e.type === "tool_call_delta" && e.callId === "call_main");

    expect(fileDeltas).toHaveLength(1);
  });

  it("emits progressive file previews when a large write arrives in one chunk", async () => {
    const events: AgentEvent[] = [];
    const content = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
    const stream = createMockStream(
      [
        {
          type: "raw_model_stream_event",
          source: "openai-chat-completions",
          data: {
            type: "model",
            event: {
              id: "chatcmpl_big_file",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_big",
                        function: {
                          name: "write_file",
                          arguments: JSON.stringify({ path: "main.py", content })
                        }
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

    await mapAgentsStreamToAgentEvents(stream, (event) => events.push(event), {
      filePreviewPacingMs: 0
    });
    const deltas = events.filter((e) => e.type === "tool_call_delta" && e.callId === "call_big");
    const lineCounts = deltas.map((event) => {
      const parsed = JSON.parse(event.argumentsJson) as { content: string };
      return parsed.content.split(/\r?\n/).length;
    });

    expect(deltas.length).toBeGreaterThan(1);
    expect(lineCounts.at(0)).toBeLessThan(80);
    expect(lineCounts.at(-1)).toBe(80);
    expect([...lineCounts].sort((a, b) => a - b)).toEqual(lineCounts);
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

  it("uses the file object from concatenated tool_called args for result status", async () => {
    const events: AgentEvent[] = [];
    const stream = createMockStream(
      [
        {
          type: "run_item_stream_event",
          name: "tool_called",
          item: {
            rawItem: {
              name: "write_file",
              callId: "call_main",
              arguments: "{\"skill_id\":\"creator-incremental\"}{\"path\":\"main.py\",\"content\":\"one\\ntwo\"}"
            }
          }
        } as RunStreamEvent,
        {
          type: "run_item_stream_event",
          name: "tool_output",
          item: {
            rawItem: {
              name: "write_file",
              callId: "call_main",
              arguments: "{\"skill_id\":\"creator-incremental\"}{\"path\":\"main.py\",\"content\":\"one\\ntwo\"}"
            }
          }
        } as RunStreamEvent
      ],
      ""
    );

    await mapAgentsStreamToAgentEvents(stream, (event) => events.push(event));
    const resultStatuses = events.filter((e) => e.type === "status" && e.message.includes("Created"));

    expect(resultStatuses.at(-1)?.message).toContain("Created main.py.");
    expect(resultStatuses.at(-1)?.message).toContain("\"filePath\":\"main.py\"");
    expect(resultStatuses.at(-1)?.message).toContain("\"added\":2");
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

  it("aggregates token usage from raw model stream events", async () => {
    const events: AgentEvent[] = [];
    const usageUpdates: Array<{ runUsage: { inputTokens: number; outputTokens: number; totalTokens: number } }> = [];
    const stream = createMockStream(
      [
        {
          type: "raw_model_stream_event",
          source: "openai-chat-completions",
          data: {
            type: "model",
            event: {
              choices: [{ index: 0, delta: { content: "Hello" } }],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
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
              choices: [],
              usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }
            } as ChatCompletionChunk,
            providerData: { rawModelEventSource: "openai-chat-completions" }
          }
        } as RunStreamEvent
      ],
      "Hello"
    );

    const result = await mapAgentsStreamToAgentEvents(stream, (event) => events.push(event), {
      onTokenUsage: (runUsage) => {
        usageUpdates.push({ runUsage });
      }
    });

    expect(result.tokenUsage).toEqual({ inputTokens: 8, outputTokens: 6, totalTokens: 14 });
    expect(usageUpdates).toEqual([
      { runUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      { runUsage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 } }
    ]);
  });
});
