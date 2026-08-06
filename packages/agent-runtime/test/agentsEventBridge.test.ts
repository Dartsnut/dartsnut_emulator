import { describe, expect, it } from "vitest";
import type { RunStreamEvent, StreamedRunResult } from "@openai/agents";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import { mapAgentsStreamToAgentEvents } from "../src/agentsEventBridge";

function createMockStream(events: RunStreamEvent[], finalOutput?: string): StreamedRunResult<any, any> {
  return {
    finalOutput,
    completed: Promise.resolve(),
    cancelled: false,
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    }
  } as StreamedRunResult<any, any>;
}

function responseEvent(event: Record<string, unknown>): RunStreamEvent {
  return {
    type: "raw_model_stream_event",
    source: "openai-responses",
    data: {
      type: "model",
      event: event as ResponseStreamEvent,
      providerData: { rawModelEventSource: "openai-responses" }
    }
  } as RunStreamEvent;
}

function functionCallAdded(itemId: string, callId: string, name: string): RunStreamEvent {
  return responseEvent({
    type: "response.output_item.added",
    output_index: 0,
    sequence_number: 1,
    item: {
      id: itemId,
      type: "function_call",
      call_id: callId,
      name,
      arguments: "",
      status: "in_progress"
    }
  });
}

function terminalEvent(
  type: "response.completed" | "response.failed" | "response.incomplete",
  id: string,
  usage?: Record<string, number>
): RunStreamEvent {
  return responseEvent({
    type,
    sequence_number: 99,
    response: { id, usage }
  });
}

describe("agentsEventBridge Responses events", () => {
  it("maps text and reasoning deltas", async () => {
    const events: AgentEvent[] = [];
    const stream = createMockStream([
      responseEvent({ type: "response.reasoning_summary_text.delta", delta: "think", item_id: "r1", output_index: 0, summary_index: 0, sequence_number: 1 }),
      responseEvent({ type: "response.output_text.delta", delta: "Hello", item_id: "m1", output_index: 0, content_index: 0, logprobs: [], sequence_number: 2 })
    ], "Hello");

    const result = await mapAgentsStreamToAgentEvents(stream, (event) => events.push(event));
    expect(result).toMatchObject({ finalText: "Hello", sawReasoning: true, stepReasoning: "think" });
    expect(events).toContainEqual(expect.objectContaining({ type: "stream", delta: "Hello" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "reasoning_stream", delta: "think" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "reasoning_done" }));
  });

  it("streams Responses function arguments into file previews", async () => {
    const events: AgentEvent[] = [];
    const stream = createMockStream([
      functionCallAdded("item_1", "call_1", "write_file"),
      responseEvent({ type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 0, sequence_number: 2, delta: "{\"path\":\"a.txt\"" }),
      responseEvent({ type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 0, sequence_number: 3, delta: ",\"content\":\"hello\"}" }),
      responseEvent({ type: "response.function_call_arguments.done", item_id: "item_1", output_index: 0, sequence_number: 4, name: "write_file", arguments: "{\"path\":\"a.txt\",\"content\":\"hello\"}" })
    ], "Done");

    await mapAgentsStreamToAgentEvents(stream, (event) => events.push(event));
    expect(events.filter((event) => event.type === "tool_call_delta").at(-1)).toMatchObject({
      callId: "call_1",
      toolName: "write_file",
      path: "a.txt",
      argumentsJson: "{\"path\":\"a.txt\",\"content\":\"hello\"}"
    });
  });

  it("emits progressive previews for one large function-arguments delta", async () => {
    const events: AgentEvent[] = [];
    const content = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
    const args = JSON.stringify({ path: "main.py", content });
    const stream = createMockStream([
      functionCallAdded("item_1", "call_1", "write_file"),
      responseEvent({ type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 0, sequence_number: 2, delta: args })
    ], "Done");

    await mapAgentsStreamToAgentEvents(stream, (event) => events.push(event), { filePreviewPacingMs: 0 });
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(JSON.parse(deltas.at(-1)!.argumentsJson).content.split("\n")).toHaveLength(80);
  });

  it.each(["response.completed", "response.failed", "response.incomplete"] as const)(
    "reads usage from %s once per response ID",
    async (terminalType) => {
      const usageUpdates: unknown[] = [];
      const stream = createMockStream([
        terminalEvent(terminalType, "resp_1", { input_tokens: 5, output_tokens: 2, total_tokens: 7 }),
        terminalEvent(terminalType, "resp_1", { input_tokens: 5, output_tokens: 2, total_tokens: 7 })
      ], "Done");

      const result = await mapAgentsStreamToAgentEvents(stream, () => {}, {
        onTokenUsage: (usage) => usageUpdates.push(usage)
      });
      expect(result.tokenUsage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
      expect(usageUpdates).toHaveLength(1);
    }
  );

  it("reads failed/incomplete usage from SDK response_done terminal records", async () => {
    const usageUpdates: unknown[] = [];
    const responseDone = {
      type: "raw_model_stream_event",
      data: {
        type: "response_done",
        response: {
          id: "resp_failed",
          output: [],
          usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
          providerData: { status: "failed" }
        }
      }
    } as RunStreamEvent;
    const result = await mapAgentsStreamToAgentEvents(createMockStream([responseDone], "Done"), () => {}, {
      onTokenUsage: (usage) => usageUpdates.push(usage)
    });
    expect(result.tokenUsage).toEqual({ inputTokens: 4, outputTokens: 3, totalTokens: 7 });
    expect(usageUpdates).toHaveLength(1);
  });

  it("ignores terminal events without usage", async () => {
    const result = await mapAgentsStreamToAgentEvents(
      createMockStream([terminalEvent("response.completed", "resp_no_usage")], "Done"),
      () => {}
    );
    expect(result.tokenUsage).toBeUndefined();
    expect(result.chainableResponseId).toBe("resp_no_usage");
  });

  it("keeps run-item tool status behavior", async () => {
    const events: AgentEvent[] = [];
    const stream = createMockStream([
      {
        type: "run_item_stream_event",
        name: "tool_called",
        item: {
          type: "tool_call_item",
          rawItem: { type: "function_call", name: "read_file", callId: "call_1", arguments: "{\"path\":\"main.py\"}", status: "completed" }
        }
      } as RunStreamEvent
    ], "Done");
    const result = await mapAgentsStreamToAgentEvents(stream, (event) => events.push(event));
    expect(result).toMatchObject({ sawToolCall: true, toolNames: ["read_file"] });
    expect(events).toContainEqual(expect.objectContaining({ type: "status", message: expect.stringContaining("main.py") }));
  });
});
