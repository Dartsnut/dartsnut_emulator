import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findEnvFile,
  loadProviderConfig,
  mergeUserDefineWithEnvDefaults,
  normalizeProviderBaseUrl,
  readUserDefineDefaultsFromEnv,
  resolveProviderConfig,
  resolveUserDefineConfig,
  validateProviderConfig
} from "../src/providerConfig";

describe("normalizeProviderBaseUrl", () => {
  it("appends /v1 for bare origins", () => {
    expect(normalizeProviderBaseUrl("https://api.example.com")).toBe("https://api.example.com/v1");
    expect(normalizeProviderBaseUrl("https://api.example.com/")).toBe("https://api.example.com/v1");
  });

  it("preserves existing /v1 base", () => {
    expect(normalizeProviderBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
  });
});

describe("validateProviderConfig", () => {
  it("fails when config fields are missing", () => {
    const result = validateProviderConfig({
      baseUrl: "",
      apiKey: "",
      model: ""
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("API key");
  });

  it("passes when baseUrl is empty but key and model exist", () => {
    const result = validateProviderConfig({
      baseUrl: "",
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
    fs.writeFileSync(path.join(root, ".env"), "GPT_API_KEY=local");

    expect(findEnvFile(root)).toBe(path.join(root, ".env"));
  });

  it("falls back to parent directory .env", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-"));
    const child = path.join(root, "apps", "desktop");
    tempDirs.push(root);
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "GPT_API_KEY=parent");

    expect(findEnvFile(child)).toBe(path.join(root, ".env"));
  });

  it("prefers DARTSNUT_REPO_ROOT .env over cwd chain and resources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-"));
    const resourcesDir = path.join(root, "resources");
    tempDirs.push(root);
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "GPT_API_KEY=repo");
    fs.writeFileSync(path.join(resourcesDir, ".env"), "GPT_API_KEY=packaged");
    const originalRepoRoot = process.env.DARTSNUT_REPO_ROOT;
    process.env.DARTSNUT_REPO_ROOT = root;
    Object.defineProperty(process, "resourcesPath", {
      value: resourcesDir,
      configurable: true
    });
    try {
      expect(findEnvFile(path.join(root, "app"))).toBe(path.join(root, ".env"));
    } finally {
      if (originalRepoRoot === undefined) {
        delete process.env.DARTSNUT_REPO_ROOT;
      } else {
        process.env.DARTSNUT_REPO_ROOT = originalRepoRoot;
      }
    }
  });
});

describe("readUserDefineDefaultsFromEnv", () => {
  const envBackup: Record<string, string | undefined> = {};
  const tempDirs: string[] = [];
  let originalRepoRoot: string | undefined;
  let originalCwd: string;

  const keys = [
    "GPT_BASE_URL",
    "GPT_API_KEY",
    "GPT_MODEL",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL"
  ];

  afterEach(() => {
    for (const key of keys) {
      if (envBackup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envBackup[key];
      }
    }
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
    if (originalRepoRoot === undefined) {
      delete process.env.DARTSNUT_REPO_ROOT;
    } else {
      process.env.DARTSNUT_REPO_ROOT = originalRepoRoot;
    }
    process.chdir(originalCwd);
  });

  function saveEnv() {
    originalCwd = process.cwd();
    originalRepoRoot = process.env.DARTSNUT_REPO_ROOT;
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-env-"));
    tempDirs.push(isolatedRoot);
    process.env.DARTSNUT_REPO_ROOT = isolatedRoot;
    process.chdir(isolatedRoot);
    for (const key of keys) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  }

  it("reads GPT_* env values", () => {
    saveEnv();
    process.env.GPT_BASE_URL = "https://gpt.example.com/v1";
    process.env.GPT_API_KEY = "gpt-key";
    process.env.GPT_MODEL = "gpt-model";
    expect(readUserDefineDefaultsFromEnv()).toEqual({
      baseUrl: "https://gpt.example.com/v1",
      apiKey: "gpt-key",
      model: "gpt-model"
    });
  });

  it("falls back to OPENAI_* when GPT_* are unset", () => {
    saveEnv();
    process.env.OPENAI_BASE_URL = "https://legacy.example.com/v1";
    process.env.OPENAI_API_KEY = "legacy-key";
    process.env.OPENAI_MODEL = "legacy-model";
    expect(readUserDefineDefaultsFromEnv()).toEqual({
      baseUrl: "https://legacy.example.com/v1",
      apiKey: "legacy-key",
      model: "legacy-model"
    });
  });
});

describe("resolveUserDefineConfig", () => {
  it("resolves saved settings and normalizes base URL", () => {
    const resolved = resolveUserDefineConfig({
      baseUrl: "https://custom.example.com",
      apiKey: "user-key",
      model: "user-model"
    });
    expect(resolved).toEqual({
      baseUrl: "https://custom.example.com/v1",
      apiKey: "user-key",
      model: "user-model"
    });
  });

  it("fills empty fields from env defaults", () => {
    const originalRepoRoot = process.env.DARTSNUT_REPO_ROOT;
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-env-"));
    process.env.DARTSNUT_REPO_ROOT = isolatedRoot;
    const originalApiKey = process.env.GPT_API_KEY;
    process.env.GPT_API_KEY = "env-key";
    try {
      const resolved = resolveUserDefineConfig({
        baseUrl: "",
        apiKey: "",
        model: "saved-model"
      });
      expect(resolved.apiKey).toBe("env-key");
      expect(resolved.model).toBe("saved-model");
    } finally {
      process.env.GPT_API_KEY = originalApiKey;
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
      if (originalRepoRoot === undefined) {
        delete process.env.DARTSNUT_REPO_ROOT;
      } else {
        process.env.DARTSNUT_REPO_ROOT = originalRepoRoot;
      }
    }
  });
});

describe("mergeUserDefineWithEnvDefaults", () => {
  it("keeps saved values over env defaults", () => {
    const originalRepoRoot = process.env.DARTSNUT_REPO_ROOT;
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-env-"));
    process.env.DARTSNUT_REPO_ROOT = isolatedRoot;
    const originalApiKey = process.env.GPT_API_KEY;
    process.env.GPT_API_KEY = "env-key";
    try {
      expect(
        mergeUserDefineWithEnvDefaults({
          baseUrl: "https://saved.example.com/v1",
          apiKey: "saved-key",
          model: "saved-model"
        })
      ).toEqual({
        baseUrl: "https://saved.example.com/v1",
        apiKey: "saved-key",
        model: "saved-model"
      });
    } finally {
      process.env.GPT_API_KEY = originalApiKey;
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
      if (originalRepoRoot === undefined) {
        delete process.env.DARTSNUT_REPO_ROOT;
      } else {
        process.env.DARTSNUT_REPO_ROOT = originalRepoRoot;
      }
    }
  });
});

describe("resolveProviderConfig", () => {
  const originalBaseUrl = process.env.GPT_BASE_URL;
  const originalApiKey = process.env.GPT_API_KEY;
  const originalModel = process.env.GPT_MODEL;
  const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiModel = process.env.OPENAI_MODEL;
  let originalRepoRoot: string | undefined;
  let originalCwd: string;
  const tempDirs: string[] = [];

  afterEach(() => {
    process.env.GPT_BASE_URL = originalBaseUrl;
    process.env.GPT_API_KEY = originalApiKey;
    process.env.GPT_MODEL = originalModel;
    process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;
    process.env.OPENAI_API_KEY = originalOpenAiKey;
    process.env.OPENAI_MODEL = originalOpenAiModel;
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
    if (originalRepoRoot === undefined) {
      delete process.env.DARTSNUT_REPO_ROOT;
    } else {
      process.env.DARTSNUT_REPO_ROOT = originalRepoRoot;
    }
    process.chdir(originalCwd);
  });

  function isolateEnv() {
    originalCwd = process.cwd();
    originalRepoRoot = process.env.DARTSNUT_REPO_ROOT;
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-env-"));
    tempDirs.push(isolatedRoot);
    process.env.DARTSNUT_REPO_ROOT = isolatedRoot;
    process.chdir(isolatedRoot);
    delete process.env.GPT_BASE_URL;
    delete process.env.GPT_API_KEY;
    delete process.env.GPT_MODEL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
  }

  it("uses env values when override fields are missing", () => {
    isolateEnv();
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

  it("uses override values when provided", () => {
    isolateEnv();
    process.env.GPT_BASE_URL = "https://env.example.com/v1";
    process.env.GPT_API_KEY = "env-key";
    process.env.GPT_MODEL = "env-model";
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

describe("loadProviderConfig", () => {
  it("loads userDefine settings", () => {
    const resolved = loadProviderConfig({
      userDefine: { baseUrl: "", apiKey: "k", model: "m" }
    });
    expect(resolved.apiKey).toBe("k");
    expect(resolved.model).toBe("m");
  });
});
