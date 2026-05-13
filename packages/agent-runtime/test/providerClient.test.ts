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

    await client.complete([{ role: "user", content: "hi" }], {
      onChunk: vi.fn()
    });

    expect(captured.body.stream).toBe(true);
  });

  it("uses stream:false when onChunk is set but a tool message is already in context", async () => {
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

    const result = await client.complete(messages, { onChunk });

    expect(captured.body.stream).toBe(false);
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith("Pick a size.");
    expect(result.content).toBe("Pick a size.");
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
  });
});
