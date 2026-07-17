import { describe, expect, it } from "vitest";
import {
  loadProviderConfig,
  normalizeProviderBaseUrl,
  resolveCustomProviderConfig,
  resolveProviderSettingsConfig,
  validateProviderConfig
} from "../src/providerConfig";

describe("normalizeProviderBaseUrl", () => {
  it("appends /v1 for bare origins", () => {
    expect(normalizeProviderBaseUrl("https://api.example.com")).toBe("https://api.example.com/v1");
    expect(normalizeProviderBaseUrl("https://api.example.com/")).toBe("https://api.example.com/v1");
  });

  it("preserves existing paths", () => {
    expect(normalizeProviderBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
  });

  it("does not supply a hidden provider default", () => {
    expect(normalizeProviderBaseUrl("")).toBe("");
  });
});

describe("validateProviderConfig", () => {
  it("requires the complete custom tuple", () => {
    expect(validateProviderConfig({ baseUrl: "", apiKey: "key", model: "model" })).toEqual({
      ok: false,
      error: "Provider endpoint is not set."
    });
    expect(validateProviderConfig({ baseUrl: "https://api.example.com/v1", apiKey: "", model: "model" })).toEqual({
      ok: false,
      error: "API key is not set."
    });
    expect(validateProviderConfig({ baseUrl: "https://api.example.com/v1", apiKey: "key", model: "" })).toEqual({
      ok: false,
      error: "Model is not set."
    });
  });

  it("accepts a complete custom tuple", () => {
    expect(validateProviderConfig({
      baseUrl: "https://api.example.com/v1",
      apiKey: "key",
      model: "model"
    })).toEqual({ ok: true });
  });
});

describe("provider resolution", () => {
  it("resolves only the saved custom tuple", () => {
    expect(resolveCustomProviderConfig({
      baseUrl: " https://custom.example.com/ ",
      apiKey: " custom-key ",
      model: " custom-model "
    })).toEqual({
      baseUrl: "https://custom.example.com/v1",
      apiKey: "custom-key",
      model: "custom-model"
    });
  });

  it("does not read GPT, OPENAI, or XIAOMI environment tuples", () => {
    const names = [
      "GPT_BASE_URL", "GPT_API_KEY", "GPT_MODEL",
      "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL",
      "XIAOMI_BASE_URL", "XIAOMI_API_KEY", "XIAOMI_MODEL"
    ] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = `ignored-${name.toLowerCase()}`;
    try {
      expect(resolveProviderSettingsConfig({
        activeProvider: "custom",
        custom: { baseUrl: "", apiKey: "", model: "" }
      })).toEqual({ baseUrl: "", apiKey: "", model: "" });
      expect(resolveProviderSettingsConfig({
        activeProvider: "dartsnut-llm",
        custom: { baseUrl: "https://custom.example.com", apiKey: "custom-key", model: "custom-model" }
      })).toEqual({ baseUrl: "", apiKey: "", model: "" });
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("loads the active custom tuple and optional fetch implementation", () => {
    const fetchImpl = async () => new Response();
    expect(loadProviderConfig({
      providerSettings: {
        activeProvider: "custom",
        custom: { baseUrl: "https://custom.example.com", apiKey: "custom-key", model: "custom-model" }
      },
      fetchImpl
    })).toEqual({
      baseUrl: "https://custom.example.com/v1",
      apiKey: "custom-key",
      model: "custom-model",
      fetchImpl
    });
  });
});
