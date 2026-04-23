import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function findEnvFile(cwd: string = process.cwd()): string | undefined {
  const candidates = [
    path.join(cwd, ".env"),
    path.join(cwd, "..", ".env"),
    path.join(cwd, "..", "..", ".env")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function loadEnvFromDisk() {
  const envPath = findEnvFile();
  if (!envPath) {
    return;
  }
  dotenv.config({ path: envPath });
}

export function loadProviderConfig(): ProviderConfig {
  loadEnvFromDisk();
  return {
    baseUrl: process.env.OPENAI_BASE_URL ?? "",
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL ?? "mimo-v2.5-pro"
  };
}

export function validateProviderConfig(config: ProviderConfig): {
  ok: boolean;
  error?: string;
} {
  if (!config.baseUrl) {
    return { ok: false, error: "OPENAI_BASE_URL is not set." };
  }
  if (!config.apiKey) {
    return { ok: false, error: "OPENAI_API_KEY is not set." };
  }
  if (!config.model) {
    return { ok: false, error: "OPENAI_MODEL is not set." };
  }
  return { ok: true };
}
