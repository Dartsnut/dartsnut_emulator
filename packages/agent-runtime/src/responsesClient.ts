import OpenAI from "openai";
import type { AgentModelConfig } from "./agentProviderConfig";
import { normalizeProviderBaseUrl } from "./providerConfig";

/** Creates the single Responses API client used by agent and utility requests. */
export function createResponsesClient(config: AgentModelConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: normalizeProviderBaseUrl(config.baseUrl ?? ""),
    timeout: Number(process.env.OPENAI_REQUEST_TIMEOUT_MS) || 180_000,
    maxRetries: 0,
    fetch: config.fetchImpl
  });
}
