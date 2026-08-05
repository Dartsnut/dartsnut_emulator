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
let lastConfiguredProvider: OpenAIProvider | undefined;

// @openai/agents registers an OpenAI trace exporter on import. Third-party keys
// (MiMo, etc.) are not valid for https://api.openai.com/v1/traces/ingest.
setTracingDisabled(true);
setTraceProcessors([]);

/**
 * Process-wide OpenAI Agents SDK bootstrap for Responses-compatible gateways.
 *
 * Rebinds both the default OpenAI client and the default model provider when base URL or API
 * key changes. The SDK's global OpenAIProvider caches its first client; updating the client
 * alone is not enough after switching LLM providers in the desktop selector.
 */
export function configureAgentsSdk(config: AgentModelConfig, options?: { force?: boolean }): OpenAIProvider {
  if (!config.model || !config.apiKey) {
    throw new Error("Provider config missing: model and apiKey are required.");
  }
  const baseUrl = normalizeProviderBaseUrl(config.baseUrl ?? "");
  const cacheKey = `${baseUrl}\0${config.apiKey}`;
  if (!options?.force && configuredKey === cacheKey && lastConfiguredProvider) {
    return lastConfiguredProvider;
  }
  const timeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS) || 180_000;
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: baseUrl,
    timeout: timeoutMs,
    maxRetries: 0,
    fetch: config.fetchImpl
  });
  const provider = new OpenAIProvider({
    openAIClient: client,
    useResponses: true,
    useResponsesWebSocket: false,
    cacheResponsesWebSocketModels: false
  });
  setDefaultOpenAIClient(client);
  setOpenAIAPI("responses");
  setDefaultModelProvider(provider);
  configuredKey = cacheKey;
  lastConfiguredClient = client;
  lastConfiguredProvider = provider;
  return provider;
}

/** Test helper — last OpenAI client passed to the SDK bootstrap. */
export function getLastConfiguredOpenAIClientForTests(): OpenAI | undefined {
  return lastConfiguredClient;
}

/** Test helper — last model provider bound to the configured OpenAI client. */
export function getLastConfiguredModelProviderForTests(): OpenAIProvider | undefined {
  return lastConfiguredProvider;
}

/** Test helper — reset bootstrap cache between cases. */
export function resetAgentsBootstrapForTests(): void {
  configuredKey = undefined;
  lastConfiguredClient = undefined;
  lastConfiguredProvider = undefined;
}
