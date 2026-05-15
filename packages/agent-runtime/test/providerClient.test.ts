import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/providerClient";
import { ProviderClient } from "../src/providerClient";

interface CapturedRequest {
  body: {
    messages: Array<Record<string, unknown>>;
    tools?: unknown;
    tool_choice?: unknown;
    stream?: boolean;
  };
}

function makeFetchMock(response: unknown): { fetchImpl: typeof fetch; captured: CapturedRequest } {
  const captured: CapturedRequest = { body: { messages: [] } };
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    captured.body = body;
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

describe("ProviderClient wire format", () => {
  it("uses stream:true when onChunk is set and there is no tool history", async () => {
    const { fetchImpl, captured } = makeFetchMock({
      choices: [{ message: { content: "done", tool_calls: [] } }]
    });
    const client = new ProviderClient({
      baseUrl: "https://example.test/v1",
      apiKey: "key",
      model: "test-model",
      fetchImpl
    });

    const result = await client.complete([{ role: "user", content: "hi" }], {
      onChunk: vi.fn()
    });

    expect(captured.body.stream).toBe(true);
    expect(result.usedHttpStream).toBe(true);
  });

  it("uses stream:true with tool history by default", async () => {
    const encoder = new TextEncoder();
    const sse =
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' + "data: [DONE]\n\n";
    const fetchImpl = vi.fn(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sse));
            controller.close();
          }
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    }) as unknown as typeof fetch;
    const captured: CapturedRequest = { body: { messages: [] } };
    const wrappedFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      captured.body = body;
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;

    const client = new ProviderClient({
      baseUrl: "https://example.test/v1",
      apiKey: "key",
      model: "test-model",
      fetchImpl: wrappedFetch
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "list_files", arguments: "{}" }
          }
        ]
      },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' }
    ];

    await client.complete(messages, { onChunk: vi.fn() });
    expect(captured.body.stream).toBe(true);
  });

  it("uses stream:false with tool history when AGENT_DISABLE_STREAM_WITH_TOOL_HISTORY=1", async () => {
    const prev = process.env.AGENT_DISABLE_STREAM_WITH_TOOL_HISTORY;
    process.env.AGENT_DISABLE_STREAM_WITH_TOOL_HISTORY = "1";
    const onChunk = vi.fn();
    const { fetchImpl, captured } = makeFetchMock({
      choices: [{ message: { content: "Pick a size.", tool_calls: [] } }]
    });
    const client = new ProviderClient({
      baseUrl: "https://example.test/v1",
      apiKey: "key",
      model: "test-model",
      fetchImpl
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "list_files", arguments: "{}" }
          }
        ]
      },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' }
    ];

    try {
      const result = await client.complete(messages, { onChunk });
      expect(captured.body.stream).toBe(false);
      expect(onChunk).toHaveBeenCalledTimes(1);
      expect(onChunk).toHaveBeenCalledWith("Pick a size.");
      expect(result.content).toBe("Pick a size.");
      expect(result.usedHttpStream).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_DISABLE_STREAM_WITH_TOOL_HISTORY;
      } else {
        process.env.AGENT_DISABLE_STREAM_WITH_TOOL_HISTORY = prev;
      }
    }
  });

  it("preserves assistant messages on the wire (no content rewriting)", async () => {
    const { fetchImpl, captured } = makeFetchMock({
      choices: [{ message: { content: "done" } }]
    });
    const client = new ProviderClient({
      baseUrl: "https://example.test/v1",
      apiKey: "key",
      model: "test-model",
      fetchImpl
    });

    await client.complete([
      {
        role: "assistant",
        content: "Inspecting workspace.",
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "list_files", arguments: "{}" }
          }
        ]
      }
    ]);

    const sent = captured.body.messages;
    expect(sent[0].content).toBe("Inspecting workspace.");
  });

  it("maps assistant reasoningContent to wire reasoning_content (MiMo thinking echo-back)", async () => {
    const { fetchImpl, captured } = makeFetchMock({
      choices: [{ message: { content: "ok", tool_calls: [] } }]
    });
    const client = new ProviderClient({
      baseUrl: "https://example.test/v1",
      apiKey: "key",
      model: "test-model",
      fetchImpl
    });

    await client.complete([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "dartsnut_project_intake", arguments: "{}" } }
        ],
        reasoningContent: "thinking blob from prior turn"
      }
    ]);

    const assistant = captured.body.messages[1] as Record<string, unknown>;
    expect(assistant.reasoning_content).toBe("thinking blob from prior turn");
  });

  it("parses native tool_calls from a non-streaming response", async () => {
    const { fetchImpl } = makeFetchMock({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_xyz",
                type: "function",
                function: { name: "write_file", arguments: '{"path":"a.txt","content":"hi"}' }
              }
            ]
          }
        }
      ]
    });
    const client = new ProviderClient({
      baseUrl: "https://example.test/v1",
      apiKey: "key",
      model: "test-model",
      fetchImpl
    });

    const result = await client.complete([{ role: "user", content: "go" }]);
    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: "call_xyz",
      name: "write_file",
      argumentsJson: '{"path":"a.txt","content":"hi"}'
    });
  });

  it("returns reasoningContent from a non-streaming assistant message when present", async () => {
    const { fetchImpl } = makeFetchMock({
      choices: [
        {
          message: {
            content: "Visible reply.",
            reasoning_content: "Hidden reasoning.",
            tool_calls: []
          }
        }
      ]
    });
    const client = new ProviderClient({
      baseUrl: "https://example.test/v1",
      apiKey: "key",
      model: "test-model",
      fetchImpl
    });

    const result = await client.complete([{ role: "user", content: "x" }]);
    expect(result.content).toBe("Visible reply.");
    expect(result.reasoningContent).toBe("Hidden reasoning.");
    expect(result.usedHttpStream).toBe(false);
  });

  it("invokes onReasoningChunk once with full reasoning on non-streaming response when callback is set", async () => {
    const prev = process.env.AGENT_DISABLE_STREAM_WITH_TOOL_HISTORY;
    process.env.AGENT_DISABLE_STREAM_WITH_TOOL_HISTORY = "1";
    const { fetchImpl } = makeFetchMock({
      choices: [
        {
          message: {
            content: "Hi",
            reasoning_content: "Step A. Step B.",
            tool_calls: []
          }
        }
      ]
    });
    const client = new ProviderClient({
      baseUrl: "https://example.test/v1",
      apiKey: "key",
      model: "test-model",
      fetchImpl
    });
    const onReasoningChunk = vi.fn();
    const messages: ChatMessage[] = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "list_files", arguments: "{}" } }]
      },
      { role: "tool", tool_call_id: "c1", content: "{}" }
    ];
    try {
      await client.complete(messages, { onReasoningChunk });
      expect(onReasoningChunk).toHaveBeenCalledTimes(1);
      expect(onReasoningChunk).toHaveBeenCalledWith("Step A. Step B.");
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_DISABLE_STREAM_WITH_TOOL_HISTORY;
      } else {
        process.env.AGENT_DISABLE_STREAM_WITH_TOOL_HISTORY = prev;
      }
    }
  });

  it("streams reasoning_content deltas through onReasoningChunk when streaming", async () => {
    const encoder = new TextEncoder();
    const sse =
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"one"}}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":" two"}}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{}}]}\n\n' +
      "data: [DONE]\n\n";
    const fetchImpl = vi.fn(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sse));
            controller.close();
          }
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    }) as unknown as typeof fetch;

    const client = new ProviderClient({
      baseUrl: "https://example.test/v1",
      apiKey: "key",
      model: "test-model",
      fetchImpl
    });
    const onChunk = vi.fn();
    const onReasoningChunk = vi.fn();
    const result = await client.complete([{ role: "user", content: "x" }], { onChunk, onReasoningChunk });
    expect(onReasoningChunk.mock.calls.map((c) => c[0]).join("")).toBe("one two");
    expect(result.reasoningContent).toBe("one two");
    expect(result.usedHttpStream).toBe(true);
  });

  it("reads reasoning deltas from delta.reasoning when reasoning_content is absent", async () => {
    const encoder = new TextEncoder();
    const sse =
      'data: {"choices":[{"index":0,"delta":{"reasoning":"alpha"}}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"reasoning":"beta"}}]}\n\n' +
      "data: [DONE]\n\n";
    const fetchImpl = vi.fn(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sse));
            controller.close();
          }
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    }) as unknown as typeof fetch;

    const client = new ProviderClient({
      baseUrl: "https://example.test/v1",
      apiKey: "key",
      model: "test-model",
      fetchImpl
    });
    const onReasoningChunk = vi.fn();
    const result = await client.complete([{ role: "user", content: "x" }], {
      onChunk: vi.fn(),
      onReasoningChunk
    });
    expect(onReasoningChunk.mock.calls.map((c) => c[0]).join("")).toBe("alphabeta");
    expect(result.reasoningContent).toBe("alphabeta");
  });
});
