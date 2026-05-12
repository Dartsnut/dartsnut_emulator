import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import type { ChatMessage, CompletionOptions, CompletionResult } from "../src/providerClient";
import { SessionEngine } from "../src/sessionEngine";
import { WorkspacePolicy } from "../src/workspacePolicy";

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
        allowedIds: ["dartsnut-skill", "asset-pipeline"]
      }
    });

    const response = await engine.runPrompt("try load display mapping", () => {});
    expect(response).toContain("Noted denial.");
  });
});
