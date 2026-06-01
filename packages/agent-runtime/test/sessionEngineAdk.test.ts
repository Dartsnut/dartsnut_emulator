import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import { SessionEngine } from "../src/sessionEngine";
import { WorkspacePolicy } from "../src/workspacePolicy";
import type { CompletionProvider, CompletionResult, ChatMessage } from "../src/providerClient";

class FakeProvider implements CompletionProvider {
  private calls = 0;
  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "Writing file now.",
        toolCalls: [
          {
            id: "call_1",
            name: "write_file",
            argumentsJson: JSON.stringify({ path: "hello.txt", content: "hello from test" })
          }
        ]
      };
    }
    return { content: `Done after ${messages.length} messages.`, toolCalls: [] };
  }
}

function createEngine(workspaceRoot: string, provider?: CompletionProvider): SessionEngine {
  return new SessionEngine({
    provider,
    workspacePolicy: new WorkspacePolicy(workspaceRoot),
    skillPrompt: "system skill prompt",
    sessionTemplateMode: "widget-creator"
  });
}

describe("SessionEngine (OpenAI agent runtime)", () => {
  it("executes tool calls and emits final response", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-adk-engine-"));
    const engine = createEngine(workspace, new FakeProvider());
    const events: AgentEvent[] = [];

    const result = await engine.runPrompt("build widget", (event) => {
      events.push(event);
    });

    const content = fs.readFileSync(path.join(workspace, "hello.txt"), "utf-8");
    expect(content).toBe("hello from test");
    expect(result).toContain("Done after");
    expect(events.some((e) => e.type === "status" && e.message.includes("tool_call write_file"))).toBe(true);
    expect(events.some((e) => e.type === "final")).toBe(true);
  });

  it("throws stop message when aborted", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-adk-engine-abort-"));
    const engine = createEngine(workspace, new FakeProvider());
    const abort = new AbortController();
    abort.abort();
    await expect(engine.runPrompt("x", () => { }, abort.signal)).rejects.toThrow("Agent stopped.");
  });
});

