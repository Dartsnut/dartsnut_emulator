import type { LlmProviderId, UserDefineProviderSettings } from "./providerConfig";

export interface AdkModelConfig {
  provider: LlmProviderId;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * Normalizes existing provider settings into an ADK-friendly model config.
 * This keeps desktop provider UX unchanged while runtime internals migrate.
 */
export function buildAdkModelConfig(input: {
  activeProvider: LlmProviderId;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  userDefine?: UserDefineProviderSettings;
}): AdkModelConfig {
  if (input.activeProvider === "user-define") {
    return {
      provider: input.activeProvider,
      model: input.userDefine?.model?.trim() || input.model,
      baseUrl: input.userDefine?.baseUrl?.trim() || input.baseUrl,
      apiKey: input.userDefine?.apiKey?.trim() || input.apiKey
    };
  }
  return {
    provider: input.activeProvider,
    model: input.model,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey
  };
}

