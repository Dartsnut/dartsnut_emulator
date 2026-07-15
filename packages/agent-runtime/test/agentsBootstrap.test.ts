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
});
