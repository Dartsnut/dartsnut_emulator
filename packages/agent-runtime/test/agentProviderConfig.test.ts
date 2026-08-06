import { describe, expect, it } from "vitest";
import { agentModelChainKey, buildAgentModelConfig } from "../src/agentProviderConfig";

describe("Responses provider config", () => {
  it("uses Responses-compatible routing for every model name", () => {
    expect(buildAgentModelConfig({
      model: "custom-model",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "key"
    }).endpointKind).toBe("openai-compatible");
    expect(buildAgentModelConfig({
      model: "gpt-4.1",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key"
    }).endpointKind).toBe("openai");
  });

  it("scopes chains by provider, model, and credential without exposing credential", () => {
    const base = {
      model: "model-a",
      endpointKind: "openai-compatible" as const,
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "secret-key"
    };
    const key = agentModelChainKey(base);
    expect(key).toHaveLength(64);
    expect(key).not.toContain("secret-key");
    expect(agentModelChainKey({ ...base, model: "model-b" })).not.toBe(key);
    expect(agentModelChainKey({ ...base, apiKey: "rotated", chainScope: "account-1" })).toBe(
      agentModelChainKey({ ...base, apiKey: "another", chainScope: "account-1" })
    );
  });
});
