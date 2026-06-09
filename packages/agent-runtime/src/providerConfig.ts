import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { UserDefineProviderSettings } from "@dartsnut/shared-ipc";

export type { UserDefineProviderSettings };

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

export interface LoadProviderConfigInput {
  userDefine?: UserDefineProviderSettings;
  fetchImpl?: typeof fetch;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_GPT_MODEL = "gpt-4.1-mini";

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
  const candidates: string[] = [];
  const repoRoot = process.env.DARTSNUT_REPO_ROOT?.trim();
  if (repoRoot) {
    candidates.push(path.join(repoRoot, ".env"));
  }
  candidates.push(
    path.join(cwd, ".env"),
    path.join(cwd, "..", ".env"),
    path.join(cwd, "..", "..", ".env"),
    path.join(cwd, "..", "..", "..", ".env")
  );
  const resourcesPath = (process as ProcessWithResourcesPath).resourcesPath;
  if (typeof resourcesPath === "string" && resourcesPath.trim()) {
    candidates.push(path.join(resourcesPath, ".env"));
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

function readEnvTriple(
  prefix: string,
  defaults?: { baseUrl?: string; model?: string }
): { baseUrl: string; apiKey: string; model: string } {
  const baseUrl = process.env[`${prefix}_BASE_URL`]?.trim() ?? defaults?.baseUrl ?? "";
  const apiKey = process.env[`${prefix}_API_KEY`]?.trim() ?? "";
  const model = process.env[`${prefix}_MODEL`]?.trim() ?? defaults?.model ?? "";
  return { baseUrl, apiKey, model };
}

/** Reads GPT_* with OPENAI_* fallback from the repo `.env` (not a selectable provider preset). */
export function readUserDefineDefaultsFromEnv(): UserDefineProviderSettings {
  loadEnvFromDisk();
  const gpt = readEnvTriple("GPT", {
    baseUrl: DEFAULT_OPENAI_BASE_URL,
    model: DEFAULT_GPT_MODEL
  });
  const hasGpt =
    Boolean(process.env.GPT_BASE_URL?.trim()) ||
    Boolean(process.env.GPT_API_KEY?.trim()) ||
    Boolean(process.env.GPT_MODEL?.trim());
  if (hasGpt) {
    return { baseUrl: gpt.baseUrl, apiKey: gpt.apiKey, model: gpt.model };
  }
  const legacy = readEnvTriple("OPENAI", {
    baseUrl: DEFAULT_OPENAI_BASE_URL,
    model: gpt.model || DEFAULT_GPT_MODEL
  });
  return {
    baseUrl: legacy.baseUrl || gpt.baseUrl,
    apiKey: legacy.apiKey || gpt.apiKey,
    model: legacy.model || gpt.model
  };
}

export function mergeUserDefineWithEnvDefaults(
  userDefine: UserDefineProviderSettings
): UserDefineProviderSettings {
  const envDefaults = readUserDefineDefaultsFromEnv();
  return {
    baseUrl: userDefine.baseUrl.trim() || envDefaults.baseUrl,
    apiKey: userDefine.apiKey.trim() || envDefaults.apiKey,
    model: userDefine.model.trim() || envDefaults.model
  };
}

export function resolveUserDefineConfig(userDefine?: UserDefineProviderSettings): ProviderConfig {
  const merged = mergeUserDefineWithEnvDefaults(
    userDefine ?? { baseUrl: "", apiKey: "", model: "" }
  );
  return {
    baseUrl: normalizeProviderBaseUrl(merged.baseUrl),
    apiKey: merged.apiKey,
    model: merged.model
  };
}

/** @deprecated Use {@link resolveUserDefineConfig}. */
export function resolveProviderConfig(overrides?: ProviderConfigOverrides): ProviderConfig {
  const base = resolveUserDefineConfig();
  const mergedBase = overrides?.baseUrl?.trim() || base.baseUrl;
  return {
    baseUrl: normalizeProviderBaseUrl(mergedBase),
    apiKey: overrides?.apiKey?.trim() || base.apiKey,
    model: overrides?.model?.trim() || base.model,
    fetchImpl: overrides?.fetchImpl
  };
}

export function loadProviderConfig(input?: LoadProviderConfigInput | ProviderConfigOverrides): ProviderConfig {
  if (input && "userDefine" in input) {
    return {
      ...resolveUserDefineConfig(input.userDefine),
      fetchImpl: input.fetchImpl
    };
  }
  return resolveProviderConfig(input);
}

export function validateProviderConfig(config: ProviderConfig): {
  ok: boolean;
  error?: string;
} {
  if (!config.apiKey) {
    return { ok: false, error: "API key is not set." };
  }
  if (!config.model) {
    return { ok: false, error: "Model is not set." };
  }
  return { ok: true };
}
