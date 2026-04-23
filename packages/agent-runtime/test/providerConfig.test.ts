import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findEnvFile, validateProviderConfig } from "../src/providerConfig";

describe("validateProviderConfig", () => {
  it("fails when config fields are missing", () => {
    const result = validateProviderConfig({
      baseUrl: "",
      apiKey: "",
      model: ""
    });
    expect(result.ok).toBe(false);
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

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
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
});
