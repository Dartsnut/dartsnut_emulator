import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ProviderConfigOverrides {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
type ProcessWithResourcesPath = NodeJS.Process & { resourcesPath?: string };

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
    baseUrl: process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL ?? "mimo-v2.5-pro"
  };
  return {
    baseUrl: overrides?.baseUrl?.trim() || baseConfig.baseUrl,
    apiKey: overrides?.apiKey?.trim() || baseConfig.apiKey,
    model: overrides?.model?.trim() || baseConfig.model
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
