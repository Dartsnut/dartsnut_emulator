import crypto from "node:crypto";
import { normalizeProviderBaseUrl, type ProviderConfig } from "@dartsnut/agent-runtime";

export const DARTSNUT_MODEL_CONFIG_URL = "https://api.dartsnut.com/mobile/system/model";
export const DARTSNUT_MODEL_DECRYPTION_KEY_ENV = "DARTSNUT_MODEL_DECRYPTION_KEY";

const SALTED_MAGIC = "Salted__";

export interface RuntimeDartsnutLlmConfigOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

type RuntimeConfigState =
  | { status: "idle"; promise: null; config: null; error: null }
  | { status: "loading"; promise: Promise<ProviderConfig>; config: null; error: null }
  | { status: "ready"; promise: null; config: ProviderConfig; error: null }
  | { status: "failed"; promise: null; config: null; error: Error };

let runtimeState: RuntimeConfigState = {
  status: "idle",
  promise: null,
  config: null,
  error: null
};

function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function firstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function readPayloadValue(json: Record<string, unknown>): Record<string, unknown> | null {
  if (json.value === undefined || json.value === null) {
    return null;
  }
  if (typeof json.value === "object" && !Array.isArray(json.value)) {
    return json.value as Record<string, unknown>;
  }
  if (typeof json.value === "string" && json.value.trim()) {
    try {
      return ensureObject(JSON.parse(json.value), "Dartsnut LLM model payload value");
    } catch {
      throw new Error("Dartsnut LLM model payload value was not valid JSON.");
    }
  }
  throw new Error("Dartsnut LLM model payload value must be an object.");
}

export function readEncryptedDartsnutModelPayload(responseJson: unknown): string {
  const json = ensureObject(responseJson, "Dartsnut LLM model response");
  const encrypted = firstString(json, ["data", "encrypted", "ciphertext", "result"]);
  if (!encrypted) {
    throw new Error("Dartsnut LLM model response did not include encrypted data.");
  }
  return encrypted;
}

function evpBytesToKey(passphrase: Buffer, salt: Buffer, keyLength: number, ivLength: number): { key: Buffer; iv: Buffer } {
  const totalLength = keyLength + ivLength;
  const chunks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  while (Buffer.concat(chunks).length < totalLength) {
    previous = crypto
      .createHash("md5")
      .update(Buffer.concat([previous, passphrase, salt]))
      .digest();
    chunks.push(previous);
  }
  const derived = Buffer.concat(chunks);
  return {
    key: derived.subarray(0, keyLength),
    iv: derived.subarray(keyLength, totalLength)
  };
}

export function decryptCryptoJsAesPayload(encrypted: string, passphrase: string): string {
  const secret = passphrase.trim();
  if (!secret) {
    throw new Error(`${DARTSNUT_MODEL_DECRYPTION_KEY_ENV} is not set.`);
  }
  const raw = Buffer.from(encrypted.trim(), "base64");
  if (raw.length <= SALTED_MAGIC.length + 8 || raw.subarray(0, SALTED_MAGIC.length).toString("utf8") !== SALTED_MAGIC) {
    throw new Error("Dartsnut LLM model payload is not a CryptoJS salted AES string.");
  }
  const salt = raw.subarray(SALTED_MAGIC.length, SALTED_MAGIC.length + 8);
  const ciphertext = raw.subarray(SALTED_MAGIC.length + 8);
  const { key, iv } = evpBytesToKey(Buffer.from(secret, "utf8"), salt, 32, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  if (!decrypted.trim()) {
    throw new Error("Dartsnut LLM model payload decrypted to an empty value.");
  }
  return decrypted;
}

export function parseDartsnutModelConfig(decryptedJson: string): ProviderConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptedJson);
  } catch {
    throw new Error("Dartsnut LLM model payload was not valid JSON.");
  }
  const json = ensureObject(parsed, "Dartsnut LLM model payload");
  const value = readPayloadValue(json);
  const baseUrl = firstString(value ?? {}, ["url"]) || firstString(json, ["baseUrl", "base_url", "url"]);
  const apiKey = firstString(value ?? {}, ["key"]) || firstString(json, ["apiKey", "tokenKey", "token_key"]);
  const model = firstString(value ?? {}, ["name", "model"]) || firstString(json, ["model"]);
  if (!baseUrl) {
    throw new Error("Dartsnut LLM model payload did not include a URL.");
  }
  if (!apiKey) {
    throw new Error("Dartsnut LLM model payload did not include a token key.");
  }
  if (!model) {
    throw new Error("Dartsnut LLM model payload did not include a model.");
  }
  const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
  if (normalizedBaseUrl) {
    try {
      new URL(normalizedBaseUrl);
    } catch {
      throw new Error("Dartsnut LLM model payload included an invalid URL.");
    }
  }
  return {
    baseUrl: normalizedBaseUrl,
    apiKey,
    model
  };
}

export async function fetchDartsnutLlmConfig(options: RuntimeDartsnutLlmConfigOptions = {}): Promise<ProviderConfig> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(DARTSNUT_MODEL_CONFIG_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: "{}"
  });
  if (!response.ok) {
    throw new Error(`Dartsnut LLM model request failed with HTTP ${response.status}.`);
  }
  const encrypted = readEncryptedDartsnutModelPayload(await response.json());
  const decrypted = decryptCryptoJsAesPayload(encrypted, env[DARTSNUT_MODEL_DECRYPTION_KEY_ENV] ?? "");
  console.info("[provider] Decrypted Dartsnut LLM model payload:", decrypted);
  return parseDartsnutModelConfig(decrypted);
}

export function resetRuntimeDartsnutLlmConfigForTests(): void {
  runtimeState = {
    status: "idle",
    promise: null,
    config: null,
    error: null
  };
}

export function primeRuntimeDartsnutLlmConfig(options: RuntimeDartsnutLlmConfigOptions = {}): Promise<ProviderConfig> {
  if (runtimeState.status === "ready") {
    return Promise.resolve(runtimeState.config);
  }
  if (runtimeState.status === "loading") {
    return runtimeState.promise;
  }
  const promise = fetchDartsnutLlmConfig(options)
    .then((config) => {
      runtimeState = {
        status: "ready",
        promise: null,
        config,
        error: null
      };
      return config;
    })
    .catch((error: unknown) => {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      runtimeState = {
        status: "failed",
        promise: null,
        config: null,
        error: wrapped
      };
      throw wrapped;
    });
  runtimeState = {
    status: "loading",
    promise,
    config: null,
    error: null
  };
  return promise;
}

export async function ensureRuntimeDartsnutLlmConfig(options: RuntimeDartsnutLlmConfigOptions = {}): Promise<ProviderConfig> {
  if (runtimeState.status === "ready") {
    return runtimeState.config;
  }
  return primeRuntimeDartsnutLlmConfig(options);
}

export function readCachedRuntimeDartsnutLlmConfig(): ProviderConfig | null {
  return runtimeState.status === "ready" ? runtimeState.config : null;
}

export function readRuntimeDartsnutLlmConfigError(): Error | null {
  return runtimeState.status === "failed" ? runtimeState.error : null;
}
