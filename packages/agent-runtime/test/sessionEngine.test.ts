import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import type { RunStreamEvent } from "@openai/agents";
import { promptRequestsHostedTools, SessionEngine } from "../src/sessionEngine";
import { WorkspacePolicy } from "../src/workspacePolicy";
import { agentModelChainKey, buildAgentModelConfig } from "../src/agentProviderConfig";
import { resetAgentsBootstrapForTests } from "../src/agentsBootstrap";
import { AgentSessionPersistence } from "../src/agentSessionPersistence";
import type { StreamedRunResult } from "@openai/agents";
import { EMPTY_MODEL_RESPONSE_MESSAGE } from "../src/modelInputGuard";

function createMockStream(params: {
  events?: RunStreamEvent[];
  finalOutput?: string;
  lastResponseId?: string;
  usage?: Record<string, number>;
  iterationError?: unknown;
}): StreamedRunResult<any, any> {
  const events = params.events ?? [];
  const stream = {
    finalOutput: params.finalOutput,
    lastResponseId: params.lastResponseId,
    state: { usage: params.usage ?? {} },
    completed: Promise.resolve(),
    cancelled: false,
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
      if (params.iterationError) throw params.iterationError;
    }
  };
  return stream as StreamedRunResult<any, any>;
}

function responseEvent(event: Record<string, unknown>): RunStreamEvent {
  return {
    type: "raw_model_stream_event",
    source: "openai-responses",
    data: {
      type: "model",
      event,
      providerData: { rawModelEventSource: "openai-responses" }
    }
  } as RunStreamEvent;
}

function textDelta(delta: string): RunStreamEvent {
  return responseEvent({ type: "response.output_text.delta", delta, item_id: "message_1", output_index: 0, content_index: 0, logprobs: [], sequence_number: 1 });
}

function terminalUsage(id: string, usage: Record<string, number>): RunStreamEvent {
  return responseEvent({ type: "response.completed", response: { id, usage }, sequence_number: 2 });
}

function toolCalled(name: string, callId: string, args: Record<string, unknown>): RunStreamEvent {
  const json = {
    type: "tool_call_item",
    rawItem: {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify(args),
      status: "completed"
    }
  };
  return {
    type: "run_item_stream_event",
    name: "tool_called",
    item: { ...json, toJSON: () => json }
  } as RunStreamEvent;
}

function toolOutput(name: string, callId: string): RunStreamEvent {
  const json = {
    type: "tool_call_output_item",
    rawItem: {
      type: "function_call_result",
      name,
      callId,
      status: "completed",
      output: JSON.stringify({ ok: true })
    }
  };
  return {
    type: "run_item_stream_event",
    name: "tool_output",
    item: { ...json, toJSON: () => json }
  } as RunStreamEvent;
}

describe("SessionEngine (@openai/agents)", () => {
  it("enables hosted tools only for explicit hosted-tool requests", () => {
    expect(promptRequestsHostedTools("Build a Pong game")).toBe(false);
    expect(promptRequestsHostedTools("Search the web for current weather APIs")).toBe(true);
    expect(promptRequestsHostedTools("Use code interpreter for data analysis")).toBe(true);
  });

  it("does not send hosted tools for ordinary project prompts", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-hosted-tools-"));
    let names: string[] = [];
    const engine = new SessionEngine({
      runFn: async (agent) => {
        names = agent.tools.map((tool) => "name" in tool ? String(tool.name) : "");
        return createMockStream({ finalOutput: "Done." });
      },
      agentModelConfig: {
        ...buildAgentModelConfig({ model: "gpt-4.1-mini", apiKey: "test-key" }),
        supportsHostedTools: true
      },
      workspacePolicy: new WorkspacePolicy(workspace)
    });

    await engine.runPrompt("Build a Pong game", () => {});
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("code_interpreter");
  });
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
            responseEvent({ type: "response.output_item.added", output_index: 0, sequence_number: 1, item: { id: "item_1", type: "function_call", call_id: "call_1", name: "write_file", arguments: "", status: "in_progress" } }),
            responseEvent({ type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 0, sequence_number: 2, delta: "{\"path\":\"hello.txt\",\"content\":\"hello" }),
            toolCalled("write_file", "call_1", { path: "hello.txt", content: "hello from test" }),
            toolOutput("write_file", "call_1")
          ]
        });
      }
      return createMockStream({
        finalOutput: "Done after tool loop.",
        events: [textDelta("Done after tool loop.")]
      });
    };

    const engine = new SessionEngine({
      runFn,
      agentModelConfig: buildAgentModelConfig({
        model: "gpt-4.1-mini",
        apiKey: "test-key"
      }),
      workspacePolicy: new WorkspacePolicy(workspace),
      sessionTemplateMode: "widget-creator"
    });
    const events: AgentEvent[] = [];
    const result = await engine.runPrompt("build widget", (event) => {
      events.push(event);
    });

    expect(fs.readFileSync(path.join(workspace, "hello.txt"), "utf-8")).toBe("hello from test");
    expect(result).toContain("Writing file now");
    expect(calls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "run_item_stream_event",
      name: "tool_called"
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      message: expect.stringContaining("Created hello.txt")
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "raw_model_stream_event" }));
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
            agent: { name: "WidgetModifier", toJSON: () => ({ name: "WidgetModifier" }) }
          } as RunStreamEvent,
          toolCalled("read_file", "call_1", { path: "main.py" }),
          toolOutput("read_file", "call_1"),
          toolCalled("replace_in_file", "call_2", {
            path: "main.py",
            find: "old",
            replace: "new"
          }),
          toolOutput("replace_in_file", "call_2"),
          textDelta("Aligned labels.")
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
        widgetSize: "128x128"
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
        usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
        events: [
          textDelta("Done."),
          terminalUsage("resp_1", { input_tokens: 7, output_tokens: 4, total_tokens: 11 })
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
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
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

  it("persists completed response ID and chains next prompt", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-chain-"));
    const persistence = new AgentSessionPersistence(workspace);
    const seenPreviousIds: Array<string | undefined> = [];
    const runFn: typeof import("@openai/agents").run = async (_agent, _input, options) => {
      seenPreviousIds.push(options?.previousResponseId);
      const id = seenPreviousIds.length === 1 ? "resp_first" : "resp_second";
      return createMockStream({
        finalOutput: "Done.",
        lastResponseId: id,
        events: [textDelta("Done."), terminalUsage(id, { input_tokens: 1, output_tokens: 1, total_tokens: 2 })]
      });
    };
    const modelConfig = buildAgentModelConfig({ model: "gpt-4.1-mini", apiKey: "test-key" });
    const makeEngine = () => new SessionEngine({
      runFn,
      agentModelConfig: modelConfig,
      workspacePolicy: new WorkspacePolicy(workspace),
      skillPrompt: "system skill prompt",
      sessionPersistence: persistence
    });

    await makeEngine().runPrompt("first", () => {});
    await makeEngine().runPrompt("second", () => {});

    expect(seenPreviousIds).toEqual([undefined, "resp_first"]);
  });

  it("invalidates a persisted Responses chain when model settings change", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-chain-switch-"));
    const persistence = new AgentSessionPersistence(workspace);
    const seenPreviousIds: Array<string | undefined> = [];
    const runFn: typeof import("@openai/agents").run = async (_agent, _input, options) => {
      seenPreviousIds.push(options?.previousResponseId);
      const id = seenPreviousIds.length === 1 ? "resp_first" : "resp_second";
      return createMockStream({
        finalOutput: "Done.",
        lastResponseId: id,
        events: [textDelta("Done."), terminalUsage(id, { input_tokens: 1, output_tokens: 1, total_tokens: 2 })]
      });
    };
    const makeEngine = (model: string) => new SessionEngine({
      runFn,
      agentModelConfig: buildAgentModelConfig({ model, apiKey: "test-key" }),
      workspacePolicy: new WorkspacePolicy(workspace),
      skillPrompt: "system skill prompt",
      sessionPersistence: persistence
    });

    await makeEngine("gpt-4.1-mini").runPrompt("first", () => {});
    await makeEngine("gpt-4.1").runPrompt("second", () => {});

    expect(seenPreviousIds).toEqual([undefined, undefined]);
  });

  it("retries once without continuation when a persisted response ID is unavailable", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-chain-retry-"));
    const persistence = new AgentSessionPersistence(workspace);
    const modelConfig = buildAgentModelConfig({ model: "gpt-4.1-mini", apiKey: "test-key" });
    persistence.writeModelChainResponseIdAtomic(agentModelChainKey(modelConfig), "resp_stale");
    const seenPreviousIds: Array<string | undefined> = [];
    const runFn: typeof import("@openai/agents").run = async (_agent, _input, options) => {
      seenPreviousIds.push(options?.previousResponseId);
      if (options?.previousResponseId) {
        throw Object.assign(new Error("400 Previous model response is unavailable."), {
          code: "INVALID_PREVIOUS_RESPONSE"
        });
      }
      return createMockStream({ finalOutput: "Recovered.", lastResponseId: "resp_fresh" });
    };
    const engine = new SessionEngine({
      runFn,
      agentModelConfig: modelConfig,
      workspacePolicy: new WorkspacePolicy(workspace),
      sessionPersistence: persistence
    });

    await expect(engine.runPrompt("continue", () => {})).resolves.toBe("Recovered.");
    expect(seenPreviousIds).toEqual(["resp_stale", undefined]);
    expect(persistence.readModelChainResponseId(agentModelChainKey(modelConfig))).toBe("resp_fresh");
  });

  it("retries a continuation rejection raised during stream iteration before events escape", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-chain-stream-retry-"));
    const persistence = new AgentSessionPersistence(workspace);
    const modelConfig = buildAgentModelConfig({ model: "gpt-4.1-mini", apiKey: "test-key" });
    persistence.writeModelChainResponseIdAtomic(agentModelChainKey(modelConfig), "resp_stale");
    const seenPreviousIds: Array<string | undefined> = [];
    const runFn: typeof import("@openai/agents").run = async (_agent, _input, options) => {
      seenPreviousIds.push(options?.previousResponseId);
      if (options?.previousResponseId) {
        return createMockStream({
          iterationError: Object.assign(new Error("previous_response_id is only supported on Responses WebSocket v2"), {
            status: 400
          })
        });
      }
      return createMockStream({ finalOutput: "Recovered.", lastResponseId: "resp_fresh" });
    };
    const engine = new SessionEngine({
      runFn,
      agentModelConfig: modelConfig,
      workspacePolicy: new WorkspacePolicy(workspace),
      sessionPersistence: persistence
    });
    const events: AgentEvent[] = [];

    await expect(engine.runPrompt("continue", (event) => events.push(event))).resolves.toBe("Recovered.");
    expect(seenPreviousIds).toEqual(["resp_stale", undefined]);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(persistence.readModelChainResponseId(agentModelChainKey(modelConfig))).toBe("resp_fresh");
  });

  it("does not replay a continuation request after a streamed event escapes", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-chain-no-replay-"));
    const persistence = new AgentSessionPersistence(workspace);
    const modelConfig = buildAgentModelConfig({ model: "gpt-4.1-mini", apiKey: "test-key" });
    persistence.writeModelChainResponseIdAtomic(agentModelChainKey(modelConfig), "resp_stale");
    let calls = 0;
    const engine = new SessionEngine({
      runFn: async () => {
        calls += 1;
        return createMockStream({
          events: [textDelta("partial")],
          iterationError: new Error("previous_response_id is only supported on Responses WebSocket v2")
        });
      },
      agentModelConfig: modelConfig,
      workspacePolicy: new WorkspacePolicy(workspace),
      sessionPersistence: persistence
    });

    await expect(engine.runPrompt("continue", () => {})).rejects.toThrow("previous_response_id");
    expect(calls).toBe(1);
  });

  it("does not use a persisted response chain when provider continuation is unsupported", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-chain-disabled-"));
    const persistence = new AgentSessionPersistence(workspace);
    const modelConfig = {
      ...buildAgentModelConfig({ model: "custom-model", baseUrl: "https://poloai.top/v1", apiKey: "test-key" }),
      supportsResponseContinuation: false
    };
    persistence.writeModelChainResponseIdAtomic(agentModelChainKey(modelConfig), "resp_stale");
    const seenPreviousIds: Array<string | undefined> = [];
    const engine = new SessionEngine({
      runFn: async (_agent, _input, options) => {
        seenPreviousIds.push(options?.previousResponseId);
        return createMockStream({ finalOutput: "Done.", lastResponseId: "resp_unused" });
      },
      agentModelConfig: modelConfig,
      workspacePolicy: new WorkspacePolicy(workspace),
      sessionPersistence: persistence
    });

    await expect(engine.runPrompt("continue", () => {})).resolves.toBe("Done.");
    expect(seenPreviousIds).toEqual([undefined]);
    expect(persistence.readModelChainResponseId(agentModelChainKey(modelConfig))).toBeNull();
  });

  it("reports an empty final response as an error instead of a successful placeholder", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-empty-"));
    const diagnostics: Array<{ message: string; meta: Record<string, unknown> }> = [];
    const engine = new SessionEngine({
      runFn: async () => createMockStream({ finalOutput: "" }),
      agentModelConfig: buildAgentModelConfig({
        model: "gpt-4.1-mini",
        apiKey: "test-key"
      }),
      workspacePolicy: new WorkspacePolicy(workspace),
      skillPrompt: "system skill prompt",
      onDiagnostic: (message, meta) => diagnostics.push({ message, meta })
    });
    const events: AgentEvent[] = [];

    await expect(engine.runPrompt("x", (event) => events.push(event))).rejects.toThrow(EMPTY_MODEL_RESPONSE_MESSAGE);

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "final")).toBe(false);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      message: "agent stream completed without assistant text",
      meta: expect.objectContaining({
        failure: "empty_mapped_output",
        hadPreviousResponseId: false
      })
    }));
  });

  it("recovers normalized streamed text when repeated-input guard stops the SDK loop", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-stream-recovery-"));
    const diagnostics: Array<{ message: string; meta: Record<string, unknown> }> = [];
    const events: AgentEvent[] = [];
    const stream = {
      finalOutput: undefined,
      state: { usage: {} },
      completed: Promise.resolve(),
      cancelled: false,
      async *[Symbol.asyncIterator]() {
        yield responseEvent({ type: "response.output_text.delta", delta: "raw duplicate", sequence_number: 1 });
        yield {
          type: "raw_model_stream_event",
          source: "openai-responses",
          data: { type: "response_started" }
        } as RunStreamEvent;
        yield {
          type: "raw_model_stream_event",
          source: "openai-responses",
          data: { type: "output_text_delta", delta: "Project summary." }
        } as RunStreamEvent;
        throw new Error(EMPTY_MODEL_RESPONSE_MESSAGE);
      }
    } as StreamedRunResult<any, any>;
    const engine = new SessionEngine({
      runFn: async () => stream,
      agentModelConfig: buildAgentModelConfig({ model: "gpt-4.1-mini", apiKey: "test-key" }),
      workspacePolicy: new WorkspacePolicy(workspace),
      onDiagnostic: (message, meta) => diagnostics.push({ message, meta })
    });

    const result = await engine.runPrompt("summarize", (event) => events.push(event));

    expect(result).toBe("Project summary.");
    expect(events).toContainEqual(expect.objectContaining({ type: "final", content: "Project summary." }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      message: "agent recovered streamed assistant text after loop guard",
      meta: expect.objectContaining({ recovery: "streamed_text_fallback", finalChars: 16 })
    }));
  });

  it("reports privacy-safe SDK lifecycle diagnostics", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-diagnostics-"));
    const diagnostics: Array<{ message: string; meta: Record<string, unknown> }> = [];
    const engine = new SessionEngine({
      runFn: async () => createMockStream({
        finalOutput: "Done.",
        lastResponseId: "resp_private",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        events: [textDelta("private streamed text"), toolCalled("read_file", "call_private", { path: "private.txt" })]
      }),
      agentModelConfig: buildAgentModelConfig({ model: "gpt-4.1-mini", apiKey: "test-key" }),
      workspacePolicy: new WorkspacePolicy(workspace),
      onDiagnostic: (message, meta) => diagnostics.push({ message, meta })
    });

    await engine.runPrompt("private prompt", () => {});

    expect(diagnostics).toContainEqual(expect.objectContaining({
      message: "agent SDK run configured",
      meta: expect.objectContaining({
        model: "gpt-4.1-mini",
        hasPreviousResponseId: false,
        promptChars: 14
      })
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      message: "agent SDK stream opened",
      meta: expect.objectContaining({ retriedWithoutContinuation: false })
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      message: "agent SDK run completed",
      meta: expect.objectContaining({
        finalChars: 5,
        lastResponseIdPresent: true,
        rawModelEvents: 1,
        runItemEvents: 1,
        responseEventTypes: { "response.output_text.delta": 1 },
        runItemNames: { tool_called: 1 }
      })
    }));
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private streamed text");
    expect(serialized).not.toContain("private.txt");
    expect(serialized).not.toContain("resp_private");
  });

  it("throws stop message when aborted", async () => {
    resetAgentsBootstrapForTests();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-engine-abort-"));
    const diagnostics: Array<{ message: string; meta: Record<string, unknown> }> = [];
    const engine = new SessionEngine({
      runFn: async () => createMockStream({ finalOutput: "nope" }),
      agentModelConfig: buildAgentModelConfig({
        model: "gpt-4.1-mini",
        apiKey: "test-key"
      }),
      workspacePolicy: new WorkspacePolicy(workspace),
      skillPrompt: "system skill prompt",
      onDiagnostic: (message, meta) => diagnostics.push({ message, meta })
    });
    const abort = new AbortController();
    abort.abort("user_stop");
    await expect(engine.runPrompt("x", () => {}, abort.signal)).rejects.toThrow("Agent stopped.");
    expect(diagnostics).toEqual([]);
  });
});
