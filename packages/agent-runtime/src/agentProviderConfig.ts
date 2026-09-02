import { createHash } from "node:crypto";
import { normalizeProviderBaseUrl } from "./providerConfig";

export type AgentEndpointKind = "openai" | "openai-compatible";

export interface AgentModelConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  endpointKind: AgentEndpointKind;
  /** Stable non-secret identity for response chains when transport credentials rotate per run. */
  chainScope?: string;
  /** Some compatible HTTP gateways only support response continuation over WebSocket. */
  supportsResponseContinuation?: boolean;
}

/** Stable, credential-scoped identity for server-managed response chains. */
export function agentModelChainKey(config: AgentModelConfig): string {
  const baseUrl = (config.baseUrl ?? "").trim().replace(/\/+$/, "");
  return createHash("sha256")
    .update(JSON.stringify({
      endpointKind: config.endpointKind,
      baseUrl,
      model: config.model.trim(),
      credentialScope: config.chainScope ?? config.apiKey ?? ""
    }))
    .digest("hex");
}

/** Normalizes provider settings into a runtime model config. */
export function buildAgentModelConfig(input: {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): AgentModelConfig {
  const providerHost = (url: string | undefined): string | undefined => {
    if (!url) return "api.openai.com";
    try {
      return new URL(normalizeProviderBaseUrl(url)).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  };
  const isOpenAiFirstParty = (url: string | undefined): boolean => {
    return providerHost(url) === "api.openai.com";
  };

  const model = input.model;
  const baseUrl = input.baseUrl;
  const apiKey = input.apiKey;
  return {
    model,
    baseUrl,
    apiKey,
    fetchImpl: input.fetchImpl,
    endpointKind: isOpenAiFirstParty(baseUrl) ? "openai" : "openai-compatible",
    supportsResponseContinuation: providerHost(baseUrl) !== "poloai.top"
  };
}
