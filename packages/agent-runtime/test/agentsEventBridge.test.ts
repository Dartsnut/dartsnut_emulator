import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import type { RunStreamEvent, StreamedRunResult } from "@openai/agents";
import { forwardAgentsStream, serializeAgentsStreamEvent } from "../src/agentsEventBridge";

function mockStream(events: RunStreamEvent[], options: {
  finalOutput?: unknown;
  lastResponseId?: string;
  usage?: Record<string, number>;
} = {}): StreamedRunResult<any, any> {
  return {
    finalOutput: options.finalOutput,
    lastResponseId: options.lastResponseId,
    state: { usage: options.usage ?? {} },
    completed: Promise.resolve(),
    cancelled: false,
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    }
  } as StreamedRunResult<any, any>;
}

describe("Agents SDK stream transport", () => {
  it("serializes raw model events without changing their data", () => {
    const data = { type: "model", event: { type: "response.output_text.delta", delta: "Hi" } };
    expect(serializeAgentsStreamEvent({
      type: "raw_model_stream_event",
      source: "openai-responses",
      data
    } as RunStreamEvent)).toEqual({
      type: "raw_model_stream_event",
      source: "openai-responses",
      data
    });
  });

  it("uses SDK JSON methods for run items and agents", () => {
    expect(serializeAgentsStreamEvent({
      type: "run_item_stream_event",
      name: "tool_called",
      item: { toJSON: () => ({ type: "tool_call_item", rawItem: { name: "read_file" } }) }
    } as RunStreamEvent)).toEqual({
      type: "run_item_stream_event",
      name: "tool_called",
      item: { type: "tool_call_item", rawItem: { name: "read_file" } }
    });
    expect(serializeAgentsStreamEvent({
      type: "agent_updated_stream_event",
      agent: { name: "WidgetAgent", toJSON: () => ({ name: "WidgetAgent" }) }
    } as RunStreamEvent)).toEqual({
      type: "agent_updated_stream_event",
      agent: { name: "WidgetAgent" }
    });
  });

  it("forwards SDK events and reads final result metadata", async () => {
    const events: AgentEvent[] = [];
    const result = await forwardAgentsStream(mockStream([], {
      finalOutput: "Done.",
      lastResponseId: "resp_1",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }
    }), (event) => events.push(event));
    expect(result).toEqual({
      finalText: "Done.",
      lastResponseId: "resp_1",
      tokenUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      diagnostics: {
        rawModelEvents: 0,
        runItemEvents: 0,
        agentUpdatedEvents: 0,
        responseEventTypes: {},
        runItemNames: {}
      }
    });
    expect(events).toEqual([]);
  });

  it("counts SDK event types without retaining event payloads", async () => {
    const raw = {
      type: "raw_model_stream_event",
      source: "openai-responses",
      data: { type: "model", event: { type: "response.output_text.delta", delta: "private text" } }
    } as RunStreamEvent;
    const runItem = {
      type: "run_item_stream_event",
      name: "tool_called",
      item: { toJSON: () => ({ type: "tool_call_item", rawItem: { arguments: "private args" } }) }
    } as RunStreamEvent;
    const result = await forwardAgentsStream(mockStream([raw, raw, runItem], { finalOutput: "Done." }), () => {});

    expect(result.diagnostics).toEqual({
      rawModelEvents: 2,
      runItemEvents: 1,
      agentUpdatedEvents: 0,
      responseEventTypes: { "response.output_text.delta": 2 },
      runItemNames: { tool_called: 1 }
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain("private");
  });

  it("emits and persists tool call timeline statuses", async () => {
    const emitted: AgentEvent[] = [];
    const persisted: Array<{ kind: string; text: string }> = [];
    const toolCall = {
      type: "run_item_stream_event",
      name: "tool_called",
      item: {
        rawItem: {
          name: "read_file",
          callId: "call_1",
          arguments: JSON.stringify({ path: "main.py" })
        },
        toJSON() { return this; }
      }
    } as RunStreamEvent;
    const toolOutput = {
      type: "run_item_stream_event",
      name: "tool_output",
      item: {
        rawItem: { name: "read_file", callId: "call_1" },
        toJSON() { return this; }
      }
    } as RunStreamEvent;

    await forwardAgentsStream(
      mockStream([toolCall, toolOutput], { finalOutput: "Done." }),
      (event) => emitted.push(event),
      undefined,
      undefined,
      { persistTranscript: (kind, text) => persisted.push({ kind, text }) }
    );

    const statuses = emitted.filter((event) => event.type === "status");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({
      type: "status",
      message: expect.stringContaining("Reading main.py")
    });
    expect(statuses[1]).toMatchObject({
      type: "status",
      message: expect.stringContaining("Read main.py")
    });
    expect(persisted).toHaveLength(2);
    expect(persisted.every((entry) => entry.kind === "tool_status")).toBe(true);
    expect(persisted[0]?.text).toContain('"phase":"call"');
    expect(persisted[1]?.text).toContain('"phase":"result"');
  });

  it("propagates stream validation failures", async () => {
    const diagnostics: unknown[] = [];
    const stream = {
      finalOutput: undefined,
      state: { usage: {} },
      completed: Promise.resolve(),
      async *[Symbol.asyncIterator]() {
        throw new Error("invalid SDK stream");
      }
    } as StreamedRunResult<any, any>;
    await expect(forwardAgentsStream(stream, () => {}, undefined, (value, text) => diagnostics.push({ value, text })))
      .rejects.toThrow("invalid SDK stream");
    expect(diagnostics).toEqual([{
      value: {
        rawModelEvents: 0,
        runItemEvents: 0,
        agentUpdatedEvents: 0,
        responseEventTypes: {},
        runItemNames: {}
      },
      text: ""
    }]);
  });

  it("retains normalized streamed text when iteration fails", async () => {
    let partialText = "";
    const stream = {
      finalOutput: undefined,
      state: { usage: {} },
      completed: Promise.resolve(),
      async *[Symbol.asyncIterator]() {
        yield {
          type: "raw_model_stream_event",
          data: { type: "response_started" }
        } as RunStreamEvent;
        yield {
          type: "raw_model_stream_event",
          data: { type: "output_text_delta", delta: "Earlier answer." }
        } as RunStreamEvent;
        yield {
          type: "raw_model_stream_event",
          data: { type: "response_done" }
        } as RunStreamEvent;
        yield {
          type: "raw_model_stream_event",
          data: { type: "response_started" }
        } as RunStreamEvent;
        yield {
          type: "raw_model_stream_event",
          data: { type: "output_text_delta", delta: "Recovered answer." }
        } as RunStreamEvent;
        throw new Error("loop guard");
      }
    } as StreamedRunResult<any, any>;

    await expect(forwardAgentsStream(stream, () => {}, undefined, (_diagnostics, text) => {
      partialText = text;
    })).rejects.toThrow("loop guard");
    expect(partialText).toBe("Recovered answer.");
  });
});
