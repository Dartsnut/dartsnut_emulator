import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findEnvFile, resolveProviderConfig, validateProviderConfig } from "../src/providerConfig";

describe("validateProviderConfig", () => {
  it("fails when config fields are missing", () => {
    const result = validateProviderConfig({
      baseUrl: "",
      apiKey: "",
      model: ""
    });
    expect(result.ok).toBe(false);
  });

  it("passes when baseUrl is empty but key and model exist", () => {
    const result = validateProviderConfig({
      baseUrl: "",
      apiKey: "sk-test",
      model: "gpt-test"
    });
    expect(result.ok).toBe(true);
  });

  it("passes when all fields exist", () => {
    const result = validateProviderConfig({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-test"
    });
    expect(result.ok).toBe(true);
  });
});

describe("findEnvFile", () => {
  const tempDirs: string[] = [];
  const originalResourcesPath = process.resourcesPath;

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
    Object.defineProperty(process, "resourcesPath", {
      value: originalResourcesPath,
      configurable: true
    });
  });

  it("prefers .env in current working directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-"));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=local");

    expect(findEnvFile(root)).toBe(path.join(root, ".env"));
  });

  it("falls back to parent directory .env", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-"));
    const child = path.join(root, "apps", "desktop");
    tempDirs.push(root);
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=parent");

    expect(findEnvFile(child)).toBe(path.join(root, ".env"));
  });

  it("prefers packaged resources .env when available", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-"));
    const resourcesDir = path.join(root, "resources");
    tempDirs.push(root);
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, ".env"), "OPENAI_API_KEY=packaged");
    Object.defineProperty(process, "resourcesPath", {
      value: resourcesDir,
      configurable: true
    });

    expect(findEnvFile(path.join(root, "app"))).toBe(path.join(resourcesDir, ".env"));
  });
});

describe("resolveProviderConfig", () => {
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_MODEL;

  afterEach(() => {
    process.env.OPENAI_BASE_URL = originalBaseUrl;
    process.env.OPENAI_API_KEY = originalApiKey;
    process.env.OPENAI_MODEL = originalModel;
  });

  it("uses env values when override fields are missing", () => {
    process.env.OPENAI_BASE_URL = "https://env.example.com/v1";
    process.env.OPENAI_API_KEY = "env-key";
    process.env.OPENAI_MODEL = "env-model";
    const resolved = resolveProviderConfig({ model: "custom-model" });
    expect(resolved).toEqual({
      baseUrl: "https://env.example.com/v1",
      apiKey: "env-key",
      model: "custom-model"
    });
  });

  it("uses default OpenAI base URL when env base URL is missing", () => {
    delete process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = "env-key";
    process.env.OPENAI_MODEL = "env-model";
    const resolved = resolveProviderConfig({ model: "custom-model" });
    expect(resolved).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "env-key",
      model: "custom-model"
    });
  });

  it("uses override values when provided", () => {
    process.env.OPENAI_BASE_URL = "https://env.example.com/v1";
    process.env.OPENAI_API_KEY = "env-key";
    process.env.OPENAI_MODEL = "env-model";
    const resolved = resolveProviderConfig({
      baseUrl: "https://user.example.com/v1",
      apiKey: "user-key",
      model: "user-model"
    });
    expect(resolved).toEqual({
      baseUrl: "https://user.example.com/v1",
      apiKey: "user-key",
      model: "user-model"
    });
  });
});
