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
  /** Hosted OpenAI tools require explicit provider support on compatible gateways. */
  supportsHostedTools?: boolean;
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
    endpointKind: isOpenAiFirstParty(baseUrl) ? "openai" : "openai-compatible",
    supportsHostedTools: isOpenAiFirstParty(baseUrl)
  };
}
