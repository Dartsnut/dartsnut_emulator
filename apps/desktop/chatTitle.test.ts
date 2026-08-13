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

  it("uses a no-tool Agents SDK run without storage", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "resp_title",
        object: "response",
        created_at: 0,
        status: "completed",
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        model: "test-model",
        output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Project Switch Fix", annotations: [] }] }],
        output_text: "Project Switch Fix",
        parallel_tool_calls: false,
        previous_response_id: null,
        prompt: null,
        reasoning: null,
        service_tier: "default",
        temperature: null,
        text: { format: { type: "text" } },
        tool_choice: "auto",
        tools: [],
        top_p: null,
        truncation: "disabled",
        usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 }
      }), { status: 200, headers: { "content-type": "application/json" } });
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
    expect(requestBody?.tools).toEqual([]);
    expect(requestBody?.store).toBe(false);
    expect(requestBody?.max_output_tokens).toBe(64);
    expect(JSON.stringify(requestBody?.input)).toContain("Fix project switching");
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
