import type { LlmProviderId, UserDefineProviderSettings } from "./providerConfig";
import { normalizeProviderBaseUrl } from "./providerConfig";

export type AgentEndpointKind = "openai" | "openai-compatible";

export interface AgentModelConfig {
  provider: LlmProviderId;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  endpointKind: AgentEndpointKind;
}

/**
 * Normalizes provider settings into a runtime model config for OpenAI-based agents.
 */
export function buildAgentModelConfig(input: {
  activeProvider: LlmProviderId;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  userDefine?: UserDefineProviderSettings;
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

  if (input.activeProvider === "user-define") {
    const model = input.userDefine?.model?.trim() || input.model;
    const baseUrl = input.userDefine?.baseUrl?.trim() || input.baseUrl;
    const apiKey = input.userDefine?.apiKey?.trim() || input.apiKey;
    return {
      provider: input.activeProvider,
      model,
      baseUrl,
      apiKey,
      endpointKind: isOpenAiFirstParty(baseUrl) ? "openai" : "openai-compatible"
    };
  }
  const baseUrl = input.baseUrl;
  return {
    provider: input.activeProvider,
    model: input.model,
    baseUrl,
    apiKey: input.apiKey,
    endpointKind: isOpenAiFirstParty(baseUrl) ? "openai" : "openai-compatible"
  };
}

/** @deprecated temporary alias kept while runtime names are migrating. */
export type AdkModelConfig = AgentModelConfig;
/** @deprecated temporary alias kept while runtime names are migrating. */
export const buildAdkModelConfig = buildAgentModelConfig;

