import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import type { ChatMessage, CompletionOptions, CompletionProvider, CompletionResult } from "../src/providerClient";
import {
  CREATOR_INCOMPLETE_NUDGE_USER_MESSAGE,
  CREATOR_STALL_NUDGE_USER_MESSAGE
} from "../src/creatorTurnGuard";
import { SessionEngine } from "../src/sessionEngine";
import { WorkspacePolicy } from "../src/workspacePolicy";
import { AgentSessionPersistence } from "../src/agentSessionPersistence";

function textOnly(content: string): CompletionResult {
  return { content, toolCalls: [] };
}

class FakeProvider {
  private call = 0;

  async complete(): Promise<CompletionResult> {
    this.call += 1;
    if (this.call === 1) {
      return textOnly(
        JSON.stringify({
          response: "Creating file now.",
          actions: [
            {
              tool: "write_file",
              path: "hello.txt",
              content: "hello dartsnut"
            }
          ]
        })
      );
    }
    return textOnly(
      JSON.stringify({
        response: "Created hello.txt successfully.",
        actions: []
      })
    );
  }
}

class FinalOnlyProvider {
  async complete(): Promise<CompletionResult> {
    return textOnly(
      JSON.stringify({
        response: "Done without tool actions.",
        actions: []
      })
    );
  }
}

class CreateFileAliasProvider {
  private call = 0;

  async complete(): Promise<CompletionResult> {
    this.call += 1;
    if (this.call === 1) {
      return textOnly(
        JSON.stringify({
          response: "Creating file with alias.",
          actions: [
            {
              tool: "create_file",
              path: "alias.txt",
              text: "alias content"
            }
          ]
        })
      );
    }
    return textOnly(
      JSON.stringify({
        response: "Created alias.txt successfully.",
        actions: []
      })
    );
  }
}

class MultiEnvelopeProvider {
  private call = 0;

  async complete(): Promise<CompletionResult> {
    this.call += 1;
    if (this.call === 1) {
      return textOnly(
        '{"response":"first envelope","actions":[{"tool":"write_file","path":"one.txt","content":"1"}]}' +
          "\n\n" +
          '{"response":"second envelope","actions":[{"tool":"write_file","path":"two.txt","content":"2"}]}'
      );
    }
    return textOnly(
      JSON.stringify({
        response: "All files written.",
        actions: []
      })
    );
  }
}

class CopyAssetProvider {
  private call = 0;

  async complete(): Promise<CompletionResult> {
    this.call += 1;
    if (this.call === 1) {
      return textOnly(
        JSON.stringify({
          response: "Copying font asset.",
          actions: [
            {
              tool: "copy_asset_file",
              source: "font.pil",
              path: "fonts/font.pil"
            }
          ]
        })
      );
    }
    return textOnly(
      JSON.stringify({
        response: "Copied font asset.",
        actions: []
      })
    );
  }
}

class XmlToolCallProvider {
  private call = 0;

  async complete(): Promise<CompletionResult> {
    this.call += 1;
    if (this.call === 1) {
      return textOnly(
        [
          "I'll create a G-Shock style digital time widget. Let me first check the workspace.",
          "<tool_call>",
          "<function=list_files>",
          "<parameter=path>.</parameter>",
          "</function>",
          "</tool_call>"
        ].join("\n")
      );
    }
    if (this.call === 2) {
      return textOnly(
        [
          "<tool_call>",
          "<function=write_file>",
          "<parameter=path>note.txt</parameter>",
          "<parameter=content>",
          "line one",
          "line two",
          "</parameter>",
          "</function>",
          "</tool_call>"
        ].join("\n")
      );
    }
    return textOnly(
      JSON.stringify({
        response: "Done with XML tool calls.",
        actions: []
      })
    );
  }
}

class ReplaceInFileProvider {
  private call = 0;

  async complete(): Promise<CompletionResult> {
    this.call += 1;
    if (this.call === 1) {
      return textOnly(
        JSON.stringify({
          response: "Updating greeting with replace action.",
          actions: [
            {
              tool: "replace_in_file",
              path: "hello.txt",
              find: "hello dartsnut",
              replace: "hello faster dartsnut"
            }
          ]
        })
      );
    }
    return textOnly(
      JSON.stringify({
        response: "Updated greeting.",
        actions: []
      })
    );
  }
}

class HashSuffixCopyProvider {
  private call = 0;

  async complete(): Promise<CompletionResult> {
    this.call += 1;
    if (this.call === 1) {
      return textOnly(
        JSON.stringify({
          response: "Copy with hash-style names.",
          actions: [
            {
              tool: "copy_asset_file",
              source: "font-deadbeef.pil",
              path: "fonts/font-cafebabe.pil"
            }
          ]
        })
      );
    }
    return textOnly(
      JSON.stringify({
        response: "Copied with canonical file names.",
        actions: []
      })
    );
  }
}

class StreamingNativeWriteProvider {
  async complete(_messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult> {
    const args = '{"path":"widget.py","content":"print(';
    options?.onToolCallProgress?.([
      { id: "call_stream", name: "write_file", argumentsJson: args }
    ]);
    options?.onToolCallProgress?.([
      {
        id: "call_stream",
        name: "write_file",
        argumentsJson: `${args}'hi')"}`
      }
    ]);
    return {
      content: "",
      toolCalls: [
        {
          id: "call_stream",
          name: "write_file",
          argumentsJson: JSON.stringify({ path: "widget.py", content: "print('hi')" })
        }
      ],
      usedHttpStream: true
    };
  }
}

class StreamingNativeReplaceInFileProvider {
  async complete(_messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult> {
    const args = '{"path":"main.py","find":"old","replace":"new';
    options?.onToolCallProgress?.([
      { id: "call_replace", name: "replace_in_file", argumentsJson: args }
    ]);
    options?.onToolCallProgress?.([
      {
        id: "call_replace",
        name: "replace_in_file",
        argumentsJson: `${args}"}`
      }
    ]);
    return {
      content: "",
      toolCalls: [
        {
          id: "call_replace",
          name: "replace_in_file",
          argumentsJson: JSON.stringify({ path: "main.py", find: "old", replace: "new" })
        }
      ],
      usedHttpStream: true
    };
  }
}

/** Models providers that buffer tool_calls until the HTTP stream ends (no incremental args). */
class AtomicNativeWriteWithContentProvider {
  async complete(_messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult> {
    options?.onChunk?.("Planning the widget layout.");
    options?.onToolCallProgress?.([
      {
        id: "call_atomic",
        name: "write_file",
        argumentsJson: JSON.stringify({ path: "widget.py", content: "print('atomic')" })
      }
    ]);
    return {
      content: "Planning the widget layout.",
      toolCalls: [
        {
          id: "call_atomic",
          name: "write_file",
          argumentsJson: JSON.stringify({ path: "widget.py", content: "print('atomic')" })
        }
      ],
      usedHttpStream: true
    };
  }
}

class NativeToolCallProvider {
  private call = 0;
  public readonly receivedMessages: ChatMessage[][] = [];

  async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult> {
    this.call += 1;
    this.receivedMessages.push(messages.map((m) => ({ ...m }) as ChatMessage));
    expect(options?.tools).toBeDefined();
    expect(options?.tools?.some((t) => t.function.name === "write_file")).toBe(true);
    if (this.call === 1) {
      return {
        content: "Creating widget.",
        toolCalls: [
          {
            id: "call_alpha",
            name: "write_file",
            argumentsJson: JSON.stringify({ path: "widget.py", content: "print('hi')" })
          }
        ]
      };
    }
    return { content: "All done with native tools.", toolCalls: [] };
  }
}

class MixedValidityNativeProvider {
  private call = 0;

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.call += 1;
    if (this.call === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "call_bad",
            name: "write_file",
            argumentsJson: "{not json"
          },
          {
            id: "call_good",
            name: "write_file",
            argumentsJson: JSON.stringify({ path: "ok.txt", content: "kept" })
          }
        ]
      };
    }
    const errorEcho = messages
      .filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool")
      .find((m) => m.tool_call_id === "call_bad");
    expect(errorEcho?.content).toContain('"ok":false');
    return { content: "Recovered from bad call.", toolCalls: [] };
  }
}

class SkillLoadThenWriteProvider {
  private call = 0;
  public readonly receivedMessages: ChatMessage[][] = [];

  async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult> {
    this.call += 1;
    this.receivedMessages.push(messages.map((m) => ({ ...m }) as ChatMessage));
    if (this.call === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "skill_1",
            name: "get_dartsnut_skill",
            argumentsJson: JSON.stringify({ skill_id: "dartsnut-skill" })
          }
        ]
      };
    }
    if (this.call === 2) {
      const toolMsg = messages.find((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool");
      expect(toolMsg?.content).toContain("pydartsnut");
      return {
        content: "",
        toolCalls: [
          {
            id: "wf_1",
            name: "write_file",
            argumentsJson: JSON.stringify({ path: "x.txt", content: "ok" })
          }
        ]
      };
    }
    return { content: "Done.", toolCalls: [] };
  }
}

class LoadDeniedSkillProvider {
  private call = 0;

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.call += 1;
    if (this.call === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "c1",
            name: "get_dartsnut_skill",
            argumentsJson: JSON.stringify({ skill_id: "dartsnut-display-mapping" })
          }
        ]
      };
    }
    const toolMsgs = messages.filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool");
    expect(toolMsgs[toolMsgs.length - 1]?.content).toContain('"ok":false');
    return { content: "Noted denial.", toolCalls: [] };
  }
}

describe("SessionEngine tool loop", () => {
  it("executes write_file actions and returns final response", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new FakeProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    const response = await engine.runPrompt("create a file", (event) => events.push(event));
    const fileContent = fs.readFileSync(path.join(tempRoot, "hello.txt"), "utf-8");

    expect(response).toContain("Created hello.txt");
    expect(fileContent).toBe("hello dartsnut");
    expect(events.some((event) => event.type === "status")).toBe(true);
    expect(events.some((event) => event.type === "final")).toBe(true);
  });

  it("does not emit status events when no tool actions are needed", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new FinalOnlyProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    const response = await engine.runPrompt("say done", (event) => events.push(event));
    const statusEvents = events.filter((event) => event.type === "status");

    expect(response).toContain("Done without tool actions.");
    expect(statusEvents).toHaveLength(0);
    expect(events.some((event) => event.type === "final")).toBe(true);
  });

  it("supports create_file alias actions with text payload", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new CreateFileAliasProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    const response = await engine.runPrompt("create file", (event) => events.push(event));
    const fileContent = fs.readFileSync(path.join(tempRoot, "alias.txt"), "utf-8");

    expect(response).toContain("Created alias.txt");
    expect(fileContent).toBe("alias content");
    expect(events.some((event) => event.type === "status")).toBe(true);
  });

  it("merges and executes actions from concatenated JSON tool envelopes", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new MultiEnvelopeProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    const response = await engine.runPrompt("multi", (event) => events.push(event));
    expect(fs.readFileSync(path.join(tempRoot, "one.txt"), "utf-8")).toBe("1");
    expect(fs.readFileSync(path.join(tempRoot, "two.txt"), "utf-8")).toBe("2");
    expect(response).toContain("All files written.");
    expect(events.filter((event) => event.type === "status").length).toBeGreaterThan(0);
  });

  it("copies binary assets via copy_asset_file action", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-assets-"));
    fs.writeFileSync(path.join(assetsRoot, "font.pil"), Buffer.from([0x00, 0xff, 0x7f]));
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new CopyAssetProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant.",
      assetRoots: { widgetFonts: assetsRoot }
    });

    const response = await engine.runPrompt("copy a font", (event) => events.push(event));
    const copied = fs.readFileSync(path.join(tempRoot, "fonts", "font.pil"));

    expect(response).toContain("Copied font asset.");
    expect(Buffer.compare(copied, Buffer.from([0x00, 0xff, 0x7f]))).toBe(0);
    expect(events.some((event) => event.type === "status")).toBe(true);
  });

  it("strips -<8hex> hash suffixes when resolving copy_asset_file source and destination names", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-assets-"));
    fs.writeFileSync(path.join(assetsRoot, "font.pil"), Buffer.from([0x01, 0x02, 0x03]));
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new HashSuffixCopyProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant.",
      assetRoots: { widgetFonts: assetsRoot }
    });

    await engine.runPrompt("copy hashed font", (event) => events.push(event));
    const copied = fs.readFileSync(path.join(tempRoot, "fonts", "font.pil"));

    expect(Buffer.compare(copied, Buffer.from([0x01, 0x02, 0x03]))).toBe(0);
    expect(fs.existsSync(path.join(tempRoot, "fonts", "font-deadbeef.pil"))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, "fonts", "font-cafebabe.pil"))).toBe(false);
  });

  it("parses Anthropic-style <tool_call> XML drift as tool actions and strips it from response text", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new XmlToolCallProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    const response = await engine.runPrompt("create widget", (event) => events.push(event));
    const fileContent = fs.readFileSync(path.join(tempRoot, "note.txt"), "utf-8");

    expect(response).toContain("Done with XML tool calls.");
    expect(fileContent).toBe("line one\nline two");

    const finalEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: "final" }> => event.type === "final"
    );
    expect(finalEvents.length).toBeGreaterThan(0);
    for (const event of finalEvents) {
      expect(event.content).not.toContain("<tool_call>");
      expect(event.content).not.toContain("<function=");
      expect(event.content).not.toContain("<parameter=");
    }

    const statusMessages = events
      .filter((event): event is Extract<AgentEvent, { type: "status" }> => event.type === "status")
      .map((event) => event.message);
    expect(statusMessages).toContain("Ran list files in .");
    expect(statusMessages).toContain("Ran write file note.txt");
  });

  it("applies targeted replace_in_file actions for existing files", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    fs.writeFileSync(path.join(tempRoot, "hello.txt"), "hello dartsnut", "utf-8");
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new ReplaceInFileProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    const response = await engine.runPrompt("edit existing file", (event) => events.push(event));
    const fileContent = fs.readFileSync(path.join(tempRoot, "hello.txt"), "utf-8");

    expect(response).toContain("Updated greeting.");
    expect(fileContent).toBe("hello faster dartsnut");
    expect(events.some((event) => event.type === "status")).toBe(true);
  });

  it("streams write_file envelope during tool progress even when assistant content streamed first", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new AtomicNativeWriteWithContentProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    await engine.runPrompt("build widget", (event) => events.push(event));

    const streamEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: "stream" }> => event.type === "stream"
    );
    const combined = streamEvents.map((event) => event.delta).join("");
    expect(combined).toContain('"tool":"write_file"');
    expect(combined).toContain("widget.py");
    const progressBeforeFinal =
      streamEvents.length > 0 &&
      events.findIndex((e) => e.type === "final") > streamEvents.findIndex((e) => e.type === "stream");
    expect(progressBeforeFinal).toBe(true);
  });

  it("finalizes write_file preview in one final when live tool progress already streamed", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new AtomicNativeWriteWithContentProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    await engine.runPrompt("build widget", (event) => events.push(event));

    const streamEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: "stream" }> => event.type === "stream"
    );
    expect(streamEvents.length).toBeGreaterThan(0);
    const finals = events.filter(
      (event): event is Extract<AgentEvent, { type: "final" }> => event.type === "final"
    );
    expect(finals.some((event) => event.content === "")).toBe(false);
    const combinedFinal = finals.find(
      (event) =>
        event.content.includes("Planning the widget layout.") &&
        event.content.includes('"tool": "write_file"')
    );
    expect(combinedFinal).toBeDefined();
    expect(combinedFinal?.content).toContain("widget.py");
  });

  it("streams write_file envelope deltas during native tool argument progress", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new StreamingNativeWriteProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    await engine.runPrompt("build widget", (event) => events.push(event));

    const streamEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: "stream" }> => event.type === "stream"
    );
    expect(streamEvents.length).toBeGreaterThan(0);
    const combined = streamEvents.map((event) => event.delta).join("");
    expect(combined).toContain('"tool":"write_file"');
    expect(combined).toContain("widget.py");
    expect(combined).toContain("print(");
  });

  it("keeps replace_in_file preview content in the final envelope after live tool progress", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    fs.writeFileSync(path.join(tempRoot, "main.py"), "old", "utf-8");
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new StreamingNativeReplaceInFileProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    await engine.runPrompt("edit main.py", (event) => events.push(event));

    const finals = events.filter(
      (event): event is Extract<AgentEvent, { type: "final" }> => event.type === "final"
    );
    expect(finals.some((event) => event.content === "")).toBe(false);
    const envelopeFinal = finals.find((event) => event.content.includes('"tool": "replace_in_file"'));
    expect(envelopeFinal).toBeDefined();
    expect(envelopeFinal?.content).toContain('"find": "old"');
    expect(envelopeFinal?.content).toContain('"replace": "new"');
    expect(fs.readFileSync(path.join(tempRoot, "main.py"), "utf-8")).toBe("new");
  });

  it("executes native tool_calls and threads tool_call_id through the conversation", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const events: AgentEvent[] = [];
    const provider = new NativeToolCallProvider();
    const engine = new SessionEngine({
      provider,
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    const response = await engine.runPrompt("build widget", (event) => events.push(event));
    const fileContent = fs.readFileSync(path.join(tempRoot, "widget.py"), "utf-8");

    expect(response).toContain("All done with native tools.");
    expect(fileContent).toBe("print('hi')");

    const secondTurnMessages = provider.receivedMessages[1];
    expect(secondTurnMessages).toBeDefined();
    const assistantMessage = secondTurnMessages.find(
      (m): m is Extract<ChatMessage, { role: "assistant" }> => m.role === "assistant"
    );
    expect(assistantMessage?.tool_calls?.[0]?.id).toBe("call_alpha");
    expect(assistantMessage?.tool_calls?.[0]?.function.name).toBe("write_file");
    const toolMessage = secondTurnMessages.find(
      (m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool"
    );
    expect(toolMessage?.tool_call_id).toBe("call_alpha");
    expect(toolMessage?.content).toContain("widget.py");

    const finalEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: "final" }> => event.type === "final"
    );
    const envelopeFinal = finalEvents.find((event) => event.content.includes('"actions"'));
    expect(envelopeFinal).toBeDefined();
    expect(envelopeFinal!.content).toContain('"tool": "write_file"');
    expect(envelopeFinal!.content).toContain('"path": "widget.py"');
  });

  it("returns an error tool result for malformed tool_call arguments and continues", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new MixedValidityNativeProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    const response = await engine.runPrompt("mixed validity", (event) => events.push(event));
    expect(response).toContain("Recovered from bad call.");
    expect(fs.readFileSync(path.join(tempRoot, "ok.txt"), "utf-8")).toBe("kept");
  });

  it("runs flip-clock creator flow on fresh workspace: scaffold then stall recovery via tools", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const provider = new FlipClockPhasedBuildProvider();
    const engine = new SessionEngine({
      provider,
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a widget creator.",
      sessionTemplateMode: "widget-creator"
    });

    const prompt = ["TEMPLATE", "", "User request:", "create 128x128 flipping clock widget"].join("\n");
    const response = await engine.runPrompt(prompt, () => {});

    expect(provider.call).toBeGreaterThanOrEqual(4);
    expect(provider.agentStepsPosted).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, "conf.json"))).toBe(true);
    expect(fs.readFileSync(path.join(tempRoot, "main.py"), "utf-8")).toContain("flip");
    expect(response).toContain("Clock widget ready.");
  });

  it("injects creator stall nudge after scaffold when model dumps implementation in reasoning only", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    fs.writeFileSync(path.join(tempRoot, "conf.json"), '{"type":"widget","size":[128,128]}', "utf-8");
    fs.writeFileSync(path.join(tempRoot, "main.py"), PHASE2_STUB_MAIN_PY, "utf-8");
    const provider = new ReasoningOnlyAfterScaffoldProvider();
    const engine = new SessionEngine({
      provider,
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a widget creator.",
      sessionTemplateMode: "widget-creator"
    });

    const prompt = ["TEMPLATE", "", "User request:", "128x128 flipping clock widget"].join("\n");
    const response = await engine.runPrompt(prompt, () => {});

    expect(provider.call).toBeGreaterThanOrEqual(3);
    const stallSeen = provider.lastMessages.some(
      (m) => m.role === "user" && m.content.includes(CREATOR_STALL_NUDGE_USER_MESSAGE.slice(0, 32))
    );
    expect(stallSeen).toBe(true);
    expect(fs.readFileSync(path.join(tempRoot, "main.py"), "utf-8")).toContain("# clock");
    expect(response).toContain("Done with clock.");
  });

  it("injects creator incomplete nudge when widget-creator replies without project files", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const provider = new CreatorClarifyThenBuildProvider();
    const engine = new SessionEngine({
      provider,
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a widget creator.",
      sessionTemplateMode: "widget-creator"
    });

    const prompt = ["TEMPLATE", "", "User request:", "Trajectory smoothing"].join("\n");
    const response = await engine.runPrompt(prompt, () => {});

    expect(provider.call).toBe(3);
    expect(response).toContain("Done.");
    expect(fs.existsSync(path.join(tempRoot, "conf.json"))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, "main.py"))).toBe(true);
  });

  it("executes get_dartsnut_skill then write_file with skill content in thread", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const skillsDir = path.resolve(__dirname, "../skills");
    const provider = new SkillLoadThenWriteProvider();
    const engine = new SessionEngine({
      provider,
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "Use get_dartsnut_skill before editing files.",
      skillLibrary: {
        skillsDir,
        allowedIds: ["dartsnut-skill", "dartsnut-display-mapping", "asset-pipeline"]
      }
    });

    const response = await engine.runPrompt("scaffold", () => {});
    expect(fs.readFileSync(path.join(tempRoot, "x.txt"), "utf-8")).toBe("ok");
    expect(response).toContain("Done.");
    expect(provider.receivedMessages.length).toBeGreaterThanOrEqual(2);
  });

  it("returns ok false for get_dartsnut_skill when skill_id is not allowed", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const skillsDir = path.resolve(__dirname, "../skills");
    const engine = new SessionEngine({
      provider: new LoadDeniedSkillProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "Asset applier style: two skills only.",
      skillLibrary: {
        skillsDir,
        allowedIds: ["pydartsnut-core", "asset-pipeline", "dartsnut-skill"]
      }
    });

    const response = await engine.runPrompt("try load display mapping", () => {});
    expect(response).toContain("Noted denial.");
  });
});

const PHASE2_STUB_MAIN_PY = `from PIL import Image

def main():
    frame = Image.new("RGB", (128, 128), (0, 0, 0))
`;

class FlipClockPhasedBuildProvider implements CompletionProvider {
  call = 0;
  agentStepsPosted = false;
  lastMessages: ChatMessage[] = [];

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.call += 1;
    this.lastMessages = messages;
    if (this.call === 1) {
      this.agentStepsPosted = true;
      return {
        content:
          "**Agent steps**\n1. conf.json\n2. reload\n3. stub main.py\n4. flip digits\n5. fonts if needed",
        toolCalls: [
          {
            id: "call_conf",
            name: "write_file",
            argumentsJson: JSON.stringify({
              path: "conf.json",
              content: '{"type":"widget","size":[128,128]}'
            })
          },
          {
            id: "call_reload",
            name: "reload_emulator",
            argumentsJson: "{}"
          }
        ]
      };
    }
    if (this.call === 2) {
      return {
        content: "Phase 2 done — stub main.py.",
        toolCalls: [
          {
            id: "call_main",
            name: "write_file",
            argumentsJson: JSON.stringify({ path: "main.py", content: PHASE2_STUB_MAIN_PY })
          }
        ]
      };
    }
    if (this.call === 3) {
      return {
        content: "",
        toolCalls: [],
        reasoningContent: "```python\n" + "# flip clock\n".repeat(500) + "\n```"
      };
    }
    if (this.call === 4) {
      const stallSeen = messages.some(
        (m) => m.role === "user" && m.content.includes(CREATOR_STALL_NUDGE_USER_MESSAGE.slice(0, 32))
      );
      expect(stallSeen).toBe(true);
      return {
        content: "Phase 3 — implementing flip clock in main.py.",
        toolCalls: [
          {
            id: "call_flip",
            name: "replace_in_file",
            argumentsJson: JSON.stringify({
              path: "main.py",
              find: "(0, 0, 0)",
              replace: "(0, 0, 0)\n# flip clock digits"
            })
          }
        ]
      };
    }
    return textOnly("Clock widget ready.");
  }
}

class ReasoningOnlyAfterScaffoldProvider implements CompletionProvider {
  call = 0;
  lastMessages: ChatMessage[] = [];

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.call += 1;
    this.lastMessages = messages;
    if (this.call === 1) {
      return {
        content: "",
        toolCalls: [],
        reasoningContent: "```python\n" + "flip_clock = True\n".repeat(400) + "\n```"
      };
    }
    if (this.call === 2) {
      const stallSeen = messages.some(
        (m) => m.role === "user" && m.content.includes(CREATOR_STALL_NUDGE_USER_MESSAGE.slice(0, 32))
      );
      expect(stallSeen).toBe(true);
      return {
        content: "Applying clock logic via tools.",
        toolCalls: [
          {
            id: "call_edit",
            name: "replace_in_file",
            argumentsJson: JSON.stringify({
              path: "main.py",
              find: "(0, 0, 0)",
              replace: "(0, 0, 0)  # clock"
            })
          }
        ]
      };
    }
    return textOnly("Done with clock.");
  }
}

class CreatorClarifyThenBuildProvider implements CompletionProvider {
  call = 0;
  lastMessages: ChatMessage[] = [];

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.call += 1;
    this.lastMessages = messages;
    if (this.call === 1) {
      return textOnly("Which visualization do you prefer?");
    }
    if (this.call === 2) {
      const nudgeSeen = messages.some(
        (m) => m.role === "user" && m.content.includes(CREATOR_INCOMPLETE_NUDGE_USER_MESSAGE.slice(0, 32))
      );
      expect(nudgeSeen).toBe(true);
      return {
        content: "Creating project files.",
        toolCalls: [
          {
            id: "call_conf",
            name: "write_file",
            argumentsJson: JSON.stringify({ path: "conf.json", content: "{}" })
          },
          {
            id: "call_main",
            name: "write_file",
            argumentsJson: JSON.stringify({ path: "main.py", content: "print('ok')" })
          }
        ]
      };
    }
    return textOnly("Done.");
  }
}

class CountingTextProvider implements CompletionProvider {
  calls = 0;
  lastMessages: ChatMessage[] = [];

  async complete(messages: ChatMessage[], _options?: CompletionOptions): Promise<CompletionResult> {
    this.calls += 1;
    this.lastMessages = messages;
    return textOnly(`Reply ${this.calls}`);
  }
}

describe("SessionEngine workspace persistence", () => {
  it("sends prior user turns on the next runPrompt when persistence is enabled", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-persist-"));
    const persistence = new AgentSessionPersistence(tempRoot);
    const provider = new CountingTextProvider();
    const engine = new SessionEngine({
      provider,
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant.",
      sessionPersistence: persistence,
      sessionTemplateMode: "game-creator",
      sessionSection: "game-creator"
    });

    await engine.runPrompt("first line", () => {});
    await engine.runPrompt("second line", () => {});

    const userLines = provider.lastMessages
      .filter((m): m is Extract<ChatMessage, { role: "user" }> => m.role === "user")
      .map((m) => m.content);
    expect(userLines.some((c) => c.includes("first line"))).toBe(true);
    expect(userLines.some((c) => c.includes("second line"))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, ".dartsnut", "agent-session", "conversation.json"))).toBe(true);
  });
});
