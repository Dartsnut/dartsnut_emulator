import { describe, expect, it } from "vitest";
import {
  configureAgentsSdk,
  getLastConfiguredModelProviderForTests,
  getLastConfiguredOpenAIClientForTests,
  resetAgentsBootstrapForTests
} from "../src/agentsBootstrap";

describe("configureAgentsSdk", () => {
  it("rebinds the OpenAI client when base URL changes", () => {
    resetAgentsBootstrapForTests();
    configureAgentsSdk({
      model: "model-a",
      apiKey: "key-shared",
      baseUrl: "https://gateway-a.example.com/v1"
    });
    const clientA = getLastConfiguredOpenAIClientForTests();
    const providerA = getLastConfiguredModelProviderForTests();

    configureAgentsSdk({
      model: "model-b",
      apiKey: "key-shared",
      baseUrl: "https://gateway-b.example.com/v1"
    });
    const clientB = getLastConfiguredOpenAIClientForTests();
    const providerB = getLastConfiguredModelProviderForTests();

    expect(clientB).not.toBe(clientA);
    expect(providerB).not.toBe(providerA);
    expect(clientB?.baseURL).toBe("https://gateway-b.example.com/v1");
  });

  it("skips rebinding when base URL and API key are unchanged", () => {
    resetAgentsBootstrapForTests();
    configureAgentsSdk({
      model: "model-a",
      apiKey: "key-shared",
      baseUrl: "https://gateway-a.example.com/v1"
    });
    const clientA = getLastConfiguredOpenAIClientForTests();

    configureAgentsSdk({
      model: "model-b",
      apiKey: "key-shared",
      baseUrl: "https://gateway-a.example.com/v1"
    });
    const clientB = getLastConfiguredOpenAIClientForTests();

    expect(clientB).toBe(clientA);
  });

  it("returns the provider bound to the current client", () => {
    resetAgentsBootstrapForTests();
    const provider = configureAgentsSdk({
      model: "model-a",
      apiKey: "key-shared",
      baseUrl: "https://gateway-a.example.com/v1"
    });

    expect(provider).toBe(getLastConfiguredModelProviderForTests());
    expect(configureAgentsSdk({
      model: "model-b",
      apiKey: "key-shared",
      baseUrl: "https://gateway-a.example.com/v1"
    })).toBe(provider);
  });

  it("rebinds when forced even if base URL and API key are unchanged", () => {
    resetAgentsBootstrapForTests();
    configureAgentsSdk({
      model: "model-a",
      apiKey: "key-shared",
      baseUrl: "https://gateway-a.example.com/v1"
    });
    const clientA = getLastConfiguredOpenAIClientForTests();

    configureAgentsSdk(
      {
        model: "model-a",
        apiKey: "key-shared",
        baseUrl: "https://gateway-a.example.com/v1"
      },
      { force: true }
    );
    const clientB = getLastConfiguredOpenAIClientForTests();

    expect(clientB).not.toBe(clientA);
  });

  it("sends Responses input and never Chat Completions messages", async () => {
    resetAgentsBootstrapForTests();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      const response = {
        id: "resp_test",
        object: "response",
        created_at: 0,
        status: "completed",
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        model: "model-a",
        output: [],
        output_text: "",
        parallel_tool_calls: false,
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      };
      return new Response(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    };
    const provider = configureAgentsSdk({
      model: "model-a",
      apiKey: "key-shared",
      baseUrl: "https://gateway.example.com/v1",
      fetchImpl
    });
    const model = await provider.getModel("model-a");
    for await (const _event of model.getStreamedResponse({
      input: [{ type: "message", role: "user", content: "hello" }],
      modelSettings: {},
      tools: [],
      outputType: { type: "text" },
      handoffs: [],
      tracing: false
    } as never)) {
      // Drain SDK stream.
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://gateway.example.com/v1/responses");
    expect(calls[0]?.body.input).toEqual([{ role: "user", content: "hello" }]);
    expect(calls[0]?.body).not.toHaveProperty("messages");
  });
});
