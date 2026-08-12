import { describe, expect, it, vi } from "vitest";
import type { AgentModelConfig } from "@dartsnut/agent-runtime";
import {
  buildChatTitlePrompt,
  fallbackChatTitle,
  generateChatTitle,
  sanitizeGeneratedChatTitle
} from "./chatTitle";

describe("chat title generation", () => {
  it("builds a simple prompt from only the first user message", () => {
    const prompt = buildChatTitlePrompt("Fix project switching");
    expect(prompt).toContain("Fix project switching");
    expect(prompt).toContain("3 to 7 words");
    expect(prompt).not.toContain("workspace context");
    expect(buildChatTitlePrompt(`start-${"x".repeat(5_000)}-end`)).not.toContain("-end");
  });

  it("sanitizes multiline, quoted, and Chinese titles", () => {
    expect(sanitizeGeneratedChatTitle("\n\"Fix project switching.\"\nignored", "fallback")).toBe("Fix project switching");
    expect(sanitizeGeneratedChatTitle("“修复项目切换。”", "fallback")).toBe("修复项目切换");
    expect(sanitizeGeneratedChatTitle("", "  fallback   title  ")).toBe("fallback title");
    expect(fallbackChatTitle("x".repeat(100))).toHaveLength(80);
  });

  it("calls Responses API without tools or storage", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body).sort()).toEqual(["input", "max_output_tokens", "model", "store", "tools"]);
      expect(body.tools).toEqual([]);
      expect(body.store).toBe(false);
      expect(body.max_output_tokens).toBe(64);
      expect(body.input).toContain("Fix project switching");
      return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "Project Switch Fix" }] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const config: AgentModelConfig = {
      model: "test-model",
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      endpointKind: "openai-compatible",
      fetchImpl
    };

    await expect(generateChatTitle(config, "Fix project switching")).resolves.toBe("Project Switch Fix");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses the first-message fallback when the provider fails", async () => {
    const config: AgentModelConfig = {
      model: "test-model",
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      endpointKind: "openai-compatible",
      fetchImpl: vi.fn(async () => new Response("failed", { status: 500 })) as unknown as typeof fetch
    };

    await expect(generateChatTitle(config, "  Fix   project switching  ")).resolves.toBe("Fix project switching");
  });
});
