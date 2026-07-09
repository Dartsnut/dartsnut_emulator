import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/providerClient";
import { AGENT_STOPPED_MESSAGE, ProviderClient } from "../src/providerClient";

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

  it("uses stream:false when no stream callbacks are provided, even with tool history", async () => {
    const { fetchImpl, captured } = makeFetchMock({
      choices: [{ message: { content: "done", tool_calls: [] } }]
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

    const result = await client.complete(messages);
    expect(captured.body.stream).toBe(false);
    expect(result.usedHttpStream).toBe(false);
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

  it("uses stream:true with tool history when onReasoningChunk is set", async () => {
    const encoder = new TextEncoder();
    const sse =
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}\n\n' + "data: [DONE]\n\n";
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
            function: { name: "get_dartsnut_skill", arguments: '{"skill_id":"dartsnut-skill"}' }
          }
        ]
      },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true,"content":"skill text"}' }
    ];

    const onReasoningChunk = vi.fn();
    await client.complete(messages, { onReasoningChunk });
    expect(captured.body.stream).toBe(true);
    expect(onReasoningChunk).toHaveBeenCalled();
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

  it("invokes onToolCallProgress as tool_calls argument JSON streams in", async () => {
    const encoder = new TextEncoder();
    const sseLines = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "write_file", arguments: '{"path":"a.txt"' }
                }
              ]
            }
          }
        ]
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ',"content":"hel' } }]
            }
          }
        ]
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'lo"}' } }]
            }
          }
        ]
      }
    ];
    const sse =
      sseLines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("") + "data: [DONE]\n\n";
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
    const onToolCallProgress = vi.fn();
    const result = await client.complete([{ role: "user", content: "go" }], {
      onChunk: vi.fn(),
      onToolCallProgress
    });
    expect(onToolCallProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
    const last = onToolCallProgress.mock.calls.at(-1)?.[0];
    expect(last?.[0]?.name).toBe("write_file");
    expect(last?.[0]?.argumentsJson).toBe('{"path":"a.txt","content":"hello"}');
    expect(result.toolCalls[0]?.argumentsJson).toBe('{"path":"a.txt","content":"hello"}');
  });

  it("keeps unindexed streamed tool calls with different ids separate", async () => {
    const encoder = new TextEncoder();
    const sseLines = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_conf",
                  function: { name: "write_file", arguments: '{"path":"conf.json","content":"{}"}' }
                }
              ]
            }
          }
        ]
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_main",
                  function: { name: "write_file", arguments: '{"path":"main.py","content":"print(' }
                }
              ]
            }
          }
        ]
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_main",
                  function: { arguments: '\\"ok\\")"}' }
                }
              ]
            }
          }
        ]
      }
    ];
    const sse =
      sseLines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("") + "data: [DONE]\n\n";
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
    const onToolCallProgress = vi.fn();
    const result = await client.complete([{ role: "user", content: "go" }], {
      onChunk: vi.fn(),
      onToolCallProgress
    });

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toMatchObject({ id: "call_conf", argumentsJson: '{"path":"conf.json","content":"{}"}' });
    expect(result.toolCalls[1]).toMatchObject({ id: "call_main", argumentsJson: '{"path":"main.py","content":"print(\\"ok\\")"}' });
    const lastProgress = onToolCallProgress.mock.calls.at(-1)?.[0];
    expect(lastProgress[1]).toMatchObject({ id: "call_main", argumentsJson: '{"path":"main.py","content":"print(\\"ok\\")"}' });
  });

  it("keeps unindexed streamed tool calls separate when ids are missing", async () => {
    const encoder = new TextEncoder();
    const sseLines = [
      { choices: [{ index: 0, delta: { tool_calls: [{ function: { name: "get_dartsnut_skill", arguments: '{"skill_id":"caveman"}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ function: { name: "dartsnut_project_intake", arguments: '{"action":"set_project_type"}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ function: { name: "dartsnut_ask_question", arguments: '{"question_id":"widget_display_size"}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ function: { name: "glob_files", arguments: '{"pattern":"*","max_results":100}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ function: { name: "write_file", arguments: '{"content":"{}","path":"conf.json"}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ function: { name: "write_file", arguments: '{"content":"print(' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '\\"ok\\")","path":"main.py"}' } }] } }] }
    ];
    const sse =
      sseLines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("") + "data: [DONE]\n\n";
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
    const onToolCallProgress = vi.fn();
    const result = await client.complete([{ role: "user", content: "go" }], {
      onChunk: vi.fn(),
      onToolCallProgress
    });

    const writeCalls = result.toolCalls.filter((call) => call.name === "write_file");
    expect(writeCalls).toHaveLength(2);
    expect(writeCalls[0].argumentsJson).toBe('{"content":"{}","path":"conf.json"}');
    expect(writeCalls[1].argumentsJson).toBe('{"content":"print(\\"ok\\")","path":"main.py"}');
    expect(writeCalls[1].argumentsJson.includes("conf.json")).toBe(false);
    const lastProgress = onToolCallProgress.mock.calls.at(-1)?.[0];
    const progressWriteCalls = lastProgress.filter((call: { name: string }) => call.name === "write_file");
    expect(progressWriteCalls.at(-1)?.argumentsJson).toBe('{"content":"print(\\"ok\\")","path":"main.py"}');
  });

  it("aborts an in-flight streaming completion when abortSignal fires", async () => {
    const abort = new AbortController();
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          return;
        }
        if (signal.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          },
          { once: true }
        );
      });
    }) as unknown as typeof fetch;

    const client = new ProviderClient({
      baseUrl: "https://example.test/v1",
      apiKey: "key",
      model: "test-model",
      fetchImpl
    });

    const promise = client.complete([{ role: "user", content: "hi" }], {
      onChunk: vi.fn(),
      abortSignal: abort.signal
    });
    const rejection = expect(promise).rejects.toThrow(AGENT_STOPPED_MESSAGE);
    abort.abort();
    await rejection;
  });
});
