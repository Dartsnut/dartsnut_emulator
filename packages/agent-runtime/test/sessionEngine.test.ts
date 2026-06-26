import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import type { RunStreamEvent } from "@openai/agents";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { SessionEngine } from "../src/sessionEngine";
import { WorkspacePolicy } from "../src/workspacePolicy";
import { buildAgentModelConfig } from "../src/agentProviderConfig";
import { resetAgentsBootstrapForTests } from "../src/agentsBootstrap";
import { AgentSessionPersistence } from "../src/agentSessionPersistence";
import type { StreamedRunResult } from "@openai/agents";

function createMockStream(params: {
  events?: RunStreamEvent[];
  finalOutput?: string;
}): StreamedRunResult<any, any> {
  const events = params.events ?? [];
  const stream = {
    finalOutput: params.finalOutput,
    completed: Promise.resolve(),
    cancelled: false,
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    }
  };
  return stream as StreamedRunResult<any, any>;
}

function chatChunk(partial: Partial<ChatCompletionChunk>): RunStreamEvent {
  return {
    type: "raw_model_stream_event",
    source: "openai-chat-completions",
    data: {
      type: "model",
      event: partial as ChatCompletionChunk,
      providerData: { rawModelEventSource: "openai-chat-completions" }
    }
  } as RunStreamEvent;
}

function toolCalled(name: string, callId: string, args: Record<string, unknown>): RunStreamEvent {
  return {
    type: "run_item_stream_event",
    name: "tool_called",
    item: {
      type: "tool_call_item",
      rawItem: {
        type: "function_call",
        name,
        callId,
        arguments: JSON.stringify(args),
        status: "completed"
      }
    }
  } as RunStreamEvent;
}

function toolOutput(name: string, callId: string): RunStreamEvent {
  return {
    type: "run_item_stream_event",
    name: "tool_output",
    item: {
      type: "tool_call_output_item",
      rawItem: {
        type: "function_call_result",
        name,
        callId,
        status: "completed",
        output: JSON.stringify({ ok: true })
      }
    }
  } as RunStreamEvent;
}

describe("SessionEngine (@openai/agents)", () => {
  it("executes tool calls and emits final response", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-"));
    let calls = 0;
    const runFn: typeof import("@openai/agents").run = async (_agent, _input, _options) => {
      calls += 1;
      if (calls === 1) {
        await fsp.writeFile(path.join(workspace, "hello.txt"), "hello from test", "utf-8");
        return createMockStream({
          finalOutput: "Writing file now.",
          events: [
            chatChunk({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        function: { name: "write_file", arguments: "{\"path\":\"hello.txt\",\"content\":\"hello" }
                      }
                    ]
                  }
                }
              ]
            }),
            toolCalled("write_file", "call_1", { path: "hello.txt", content: "hello from test" }),
            toolOutput("write_file", "call_1")
          ]
        });
      }
      return createMockStream({
        finalOutput: "Done after tool loop.",
        events: [chatChunk({ choices: [{ index: 0, delta: { content: "Done after tool loop." } }] })]
      });
    };

    const engine = new SessionEngine({
      runFn,
      agentModelConfig: buildAgentModelConfig({
        model: "gpt-4.1-mini",
        apiKey: "test-key"
      }),
      workspacePolicy: new WorkspacePolicy(workspace),
      skillPrompt: "system skill prompt",
      sessionTemplateMode: "widget-creator"
    });
    const events: AgentEvent[] = [];
    const result = await engine.runPrompt("build widget", (event) => {
      events.push(event);
    });

    expect(fs.readFileSync(path.join(workspace, "hello.txt"), "utf-8")).toBe("hello from test");
    expect(result).toContain("Writing file now");
    expect(calls).toBe(1);
    const statusMessages = events.filter((e) => e.type === "status").map((e) => e.message);
    expect(statusMessages.some((m) => m.includes("Created hello.txt."))).toBe(true);
    const toolDeltas = events.filter((e) => e.type === "tool_call_delta");
    expect(toolDeltas.length).toBeGreaterThan(0);
    expect(toolDeltas[0]).toMatchObject({
      type: "tool_call_delta",
      callId: "call_1",
      toolName: "write_file",
      path: "hello.txt"
    });
    expect(events.some((e) => e.type === "final")).toBe(true);
  });

  it("runs modification agents once per user prompt (no host orchestrator re-loop)", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-mod-"));
    await fsp.writeFile(path.join(workspace, "conf.json"), "{}", "utf-8");
    await fsp.writeFile(path.join(workspace, "main.py"), "print('ok')\n", "utf-8");

    let runCalls = 0;
    const runFn: typeof import("@openai/agents").run = async () => {
      runCalls += 1;
      return createMockStream({
        finalOutput: "Aligned labels.",
        events: [
          {
            type: "agent_updated_stream_event",
            agent: { name: "WidgetModifier" }
          } as RunStreamEvent,
          toolCalled("read_file", "call_1", { path: "main.py" }),
          toolOutput("read_file", "call_1"),
          toolCalled("replace_in_file", "call_2", {
            path: "main.py",
            find: "old",
            replace: "new"
          }),
          toolOutput("replace_in_file", "call_2"),
          chatChunk({ choices: [{ index: 0, delta: { content: "Aligned labels." } }] })
        ]
      });
    };

    const engine = new SessionEngine({
      runFn,
      agentModelConfig: buildAgentModelConfig({
        model: "gpt-4.1-mini",
        apiKey: "test-key"
      }),
      workspacePolicy: new WorkspacePolicy(workspace),
      skillPrompt: "system skill prompt",
      runContextSeed: {
        projectType: "widget",
        widgetSize: "128x128",
        intakeReady: true
      }
    });

    const result = await engine.runPrompt("align the time label", () => {});
    expect(result).toContain("Aligned labels");
    expect(runCalls).toBe(1);
  });

  it("persists and emits token usage after a run", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-usage-"));
    const persistence = new AgentSessionPersistence(workspace);
    persistence.writeTokenUsageAtomic({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    const runFn: typeof import("@openai/agents").run = async () =>
      createMockStream({
        finalOutput: "Done.",
        events: [
          chatChunk({
            choices: [{ index: 0, delta: { content: "Done." } }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
          }),
          chatChunk({
            choices: [],
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
          })
        ]
      });

    const engine = new SessionEngine({
      runFn,
      agentModelConfig: buildAgentModelConfig({
        model: "gpt-4.1-mini",
        apiKey: "test-key"
      }),
      workspacePolicy: new WorkspacePolicy(workspace),
      skillPrompt: "system skill prompt",
      sessionPersistence: persistence
    });
    const events: AgentEvent[] = [];

    await engine.runPrompt("count usage", (event) => events.push(event));

    const usageEvents = events.filter((event) => event.type === "token_usage");
    expect(persistence.readTokenUsage()).toEqual({
      inputTokens: 17,
      outputTokens: 8,
      totalTokens: 25,
      lastRun: { inputTokens: 7, outputTokens: 4, totalTokens: 11 }
    });
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toMatchObject({
      type: "token_usage",
      runUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      sessionUsage: {
        inputTokens: 15,
        outputTokens: 7,
        totalTokens: 22,
        lastRun: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
      }
    });
    expect(usageEvents[1]).toMatchObject({
      type: "token_usage",
      runUsage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
      sessionUsage: {
        inputTokens: 17,
        outputTokens: 8,
        totalTokens: 25,
        lastRun: { inputTokens: 7, outputTokens: 4, totalTokens: 11 }
      }
    });
  });

  it("throws stop message when aborted", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-abort-"));
    const engine = new SessionEngine({
      runFn: async () => createMockStream({ finalOutput: "nope" }),
      agentModelConfig: buildAgentModelConfig({
        model: "gpt-4.1-mini",
        apiKey: "test-key"
      }),
      workspacePolicy: new WorkspacePolicy(workspace),
      skillPrompt: "system skill prompt"
    });
    const abort = new AbortController();
    abort.abort();
    await expect(engine.runPrompt("x", () => {}, abort.signal)).rejects.toThrow("Agent stopped.");
  });
});
