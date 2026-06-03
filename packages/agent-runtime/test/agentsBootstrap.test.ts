import { describe, expect, it } from "vitest";
import {
  configureAgentsSdk,
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

    configureAgentsSdk({
      model: "model-b",
      apiKey: "key-shared",
      baseUrl: "https://gateway-b.example.com/v1"
    });
    const clientB = getLastConfiguredOpenAIClientForTests();

    expect(clientB).not.toBe(clientA);
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
});
