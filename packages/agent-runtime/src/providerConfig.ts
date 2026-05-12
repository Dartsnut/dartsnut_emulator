import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** When set (e.g. in tests), passed to the OpenAI SDK as `fetch` instead of real HTTP. */
  fetchImpl?: typeof fetch;
}

export interface ProviderConfigOverrides {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
type ProcessWithResourcesPath = NodeJS.Process & { resourcesPath?: string };

/**
 * Ensure base URL joins SDK paths like `/chat/completions` as `.../v1/chat/completions`.
 * A bare origin (`https://host`) would otherwise hit `https://host/chat/completions` and often 404.
 */
export function normalizeProviderBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return DEFAULT_OPENAI_BASE_URL;
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

export function findEnvFile(cwd: string = process.cwd()): string | undefined {
  const candidates = [
    path.join(cwd, ".env"),
    path.join(cwd, "..", ".env"),
    path.join(cwd, "..", "..", ".env")
  ];
  const resourcesPath = (process as ProcessWithResourcesPath).resourcesPath;
  if (typeof resourcesPath === "string" && resourcesPath.trim()) {
    candidates.unshift(path.join(resourcesPath, ".env"));
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function loadEnvFromDisk() {
  const envPath = findEnvFile();
  if (!envPath) {
    return;
  }
  dotenv.config({ path: envPath });
}

export function resolveProviderConfig(overrides?: ProviderConfigOverrides): ProviderConfig {
  const baseConfig: ProviderConfig = {
    baseUrl: normalizeProviderBaseUrl(process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL),
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL ?? "mimo-v2.5-pro"
  };
  const mergedBase = overrides?.baseUrl?.trim() || baseConfig.baseUrl;
  return {
    baseUrl: normalizeProviderBaseUrl(mergedBase),
    apiKey: overrides?.apiKey?.trim() || baseConfig.apiKey,
    model: overrides?.model?.trim() || baseConfig.model,
    fetchImpl: overrides?.fetchImpl ?? baseConfig.fetchImpl
  };
}

export function loadProviderConfig(overrides?: ProviderConfigOverrides): ProviderConfig {
  loadEnvFromDisk();
  return resolveProviderConfig(overrides);
}

export function validateProviderConfig(config: ProviderConfig): {
  ok: boolean;
  error?: string;
} {
  if (!config.apiKey) {
    return { ok: false, error: "OPENAI_API_KEY is not set." };
  }
  if (!config.model) {
    return { ok: false, error: "OPENAI_MODEL is not set." };
  }
  return { ok: true };
}
