import OpenAI from "openai";
import {
  OpenAIProvider,
  setDefaultOpenAIClient,
  setOpenAIAPI,
  setDefaultModelProvider,
  setTraceProcessors,
  setTracingDisabled
} from "@openai/agents";
import type { AgentModelConfig } from "./agentProviderConfig";
import { normalizeProviderBaseUrl } from "./providerConfig";

let configuredKey: string | undefined;
let lastConfiguredClient: OpenAI | undefined;

// @openai/agents registers an OpenAI trace exporter on import. Third-party keys
// (MiMo, etc.) are not valid for https://api.openai.com/v1/traces/ingest.
setTracingDisabled(true);
setTraceProcessors([]);

/**
 * Process-wide OpenAI Agents SDK bootstrap for Chat Completions on OpenAI-compatible gateways.
 *
 * Rebinds both the default OpenAI client and the default model provider when base URL or API
 * key changes. The SDK's global OpenAIProvider caches its first client; updating the client
 * alone is not enough after switching LLM providers in the desktop selector.
 */
export function configureAgentsSdk(config: AgentModelConfig): void {
  if (!config.model || !config.apiKey) {
    throw new Error("Provider config missing: model and apiKey are required.");
  }
  const baseUrl = normalizeProviderBaseUrl(config.baseUrl ?? "https://api.openai.com/v1");
  const cacheKey = `${baseUrl}\0${config.apiKey}`;
  if (configuredKey === cacheKey) {
    return;
  }
  const timeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS) || 180_000;
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: baseUrl,
    timeout: timeoutMs,
    maxRetries: 0
  });
  setDefaultOpenAIClient(client);
  setOpenAIAPI("chat_completions");
  setDefaultModelProvider(
    new OpenAIProvider({
      openAIClient: client,
      cacheResponsesWebSocketModels: false
    })
  );
  configuredKey = cacheKey;
  lastConfiguredClient = client;
}

/** Test helper — last OpenAI client passed to the SDK bootstrap. */
export function getLastConfiguredOpenAIClientForTests(): OpenAI | undefined {
  return lastConfiguredClient;
}

/** Test helper — reset bootstrap cache between cases. */
export function resetAgentsBootstrapForTests(): void {
  configuredKey = undefined;
  lastConfiguredClient = undefined;
}
