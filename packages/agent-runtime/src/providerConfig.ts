import type { ProviderSettings, CustomProviderSettings } from "@dartsnut/shared-ipc";

export type { ProviderSettings, CustomProviderSettings };

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** When set (e.g. in tests), passed to the OpenAI SDK as `fetch` instead of real HTTP. */
  fetchImpl?: typeof fetch;
}

export interface LoadProviderConfigInput {
  providerSettings?: ProviderSettings;
  fetchImpl?: typeof fetch;
}

/**
 * Ensure base URL joins SDK paths like `/responses` as `.../v1/responses`.
 * A bare origin (`https://host`) would otherwise hit `https://host/responses` and often 404.
 */
export function normalizeProviderBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  try {
    const u = new URL(trimmed);
    if (u.pathname === "" || u.pathname === "/") {
      u.pathname = "/v1";
    }
    return u.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

export function resolveCustomProviderConfig(custom?: CustomProviderSettings): ProviderConfig {
  const values = custom ?? { baseUrl: "", apiKey: "", model: "" };
  return {
    baseUrl: normalizeProviderBaseUrl(values.baseUrl),
    apiKey: values.apiKey.trim(),
    model: values.model.trim()
  };
}

export function resolveProviderSettingsConfig(providerSettings?: ProviderSettings): ProviderConfig {
  if (providerSettings?.activeProvider === "dartsnut-llm") {
    // Dartsnut LLM is configured only by the authenticated desktop API bridge.
    // The shared runtime must never load or retain the upstream provider credentials.
    return { baseUrl: "", apiKey: "", model: "" };
  }
  return resolveCustomProviderConfig(providerSettings?.custom);
}

export function loadProviderConfig(input: LoadProviderConfigInput = {}): ProviderConfig {
  return {
    ...resolveProviderSettingsConfig(input.providerSettings),
    fetchImpl: input.fetchImpl
  };
}

export function validateProviderConfig(config: ProviderConfig): {
  ok: boolean;
  error?: string;
} {
  if (!config.baseUrl) {
    return { ok: false, error: "Provider endpoint is not set." };
  }
  if (!config.apiKey) {
    return { ok: false, error: "API key is not set." };
  }
  if (!config.model) {
    return { ok: false, error: "Model is not set." };
  }
  return { ok: true };
}
