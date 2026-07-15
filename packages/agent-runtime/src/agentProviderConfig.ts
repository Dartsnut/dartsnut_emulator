import { normalizeProviderBaseUrl } from "./providerConfig";

export type AgentEndpointKind = "openai" | "openai-compatible";

export interface AgentModelConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  endpointKind: AgentEndpointKind;
}

/**
 * Normalizes provider settings into a runtime model config for OpenAI-based agents.
 */
export function buildAgentModelConfig(input: {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): AgentModelConfig {
  const isOpenAiFirstParty = (url: string | undefined): boolean => {
    if (!url) {
      return true;
    }
    try {
      const normalized = new URL(normalizeProviderBaseUrl(url));
      return normalized.hostname === "api.openai.com";
    } catch {
      return false;
    }
  };

  const model = input.model;
  const baseUrl = input.baseUrl;
  const apiKey = input.apiKey;
  return {
    model,
    baseUrl,
    apiKey,
    fetchImpl: input.fetchImpl,
    endpointKind: isOpenAiFirstParty(baseUrl) ? "openai" : "openai-compatible"
  };
}
