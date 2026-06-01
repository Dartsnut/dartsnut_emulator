import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import {
  AGENT_STOPPED_MESSAGE,
  type ChatMessage,
  type CompletionOptions,
  type CompletionProvider,
  type CompletionResult
} from "../src/providerClient";
import { SessionEngine } from "../src/sessionEngine";
import { AGENT_CREATION_INTAKE_TOOL_SCHEMAS } from "../src/toolSchemas";
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

class ClaudeFunctionCallsXmlProvider {
  async complete(): Promise<CompletionResult> {
    return textOnly(
      [
        "I'll set up your widget project.",
        "<function_calls>",
        '<invoke name="dartsnut_ask_question">',
        '<parameter name="question_id">widget_display_size</parameter>',
        "</invoke>",
        "</function_calls>",
        "<function_calls>",
        '<invoke name="dartsnut_project_intake">',
        '<parameter name="action">set_project_type</parameter>',
        '<parameter name="project_type">widget</parameter>',
        "</invoke>",
        "</function_calls>"
      ].join("\n")
    );
  }
}

/** Same XML order as live Claude intake: ask_question before set_widget_size in one turn. */
class ClaudeIntakeBatchOrderProvider {
  async complete(): Promise<CompletionResult> {
    return textOnly(
      [
        "<function_calls>",
        '<invoke name="dartsnut_project_intake">',
        '<parameter name="action">set_project_type</parameter>',
        '<parameter name="project_type">widget</parameter>',
        "</invoke>",
        "</function_calls>",
        "<function_calls>",
        '<invoke name="dartsnut_ask_question">',
        '<parameter name="question_id">widget_display_size</parameter>',
        "</invoke>",
        "</function_calls>",
        "<function_calls>",
        '<invoke name="dartsnut_project_intake">',
        '<parameter name="action">set_widget_size</parameter>',
        '<parameter name="widget_size">128x128</parameter>',
        "</invoke>",
        "</function_calls>",
        "<function_calls>",
        '<invoke name="dartsnut_project_intake">',
        '<parameter name="action">read_workspace_conf</parameter>',
        "</invoke>",
        "</function_calls>"
      ].join("\n")
    );
  }
}

class IntakeGuardNativeProvider {
  call = 0;
  sawBlockedWrite = false;

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.call += 1;
    if (this.call === 2) {
      const blocked = messages
        .filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool")
        .some((m) => m.content.includes("intake_required"));
      this.sawBlockedWrite = blocked;
    }
    if (this.call === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "wf_blocked",
            name: "write_file",
            argumentsJson: JSON.stringify({ path: "main.py", content: "print('blocked')" })
          }
        ]
      };
    }
    if (this.call === 2) {
      return {
        content: "",
        toolCalls: [
          { id: "ask_pt", name: "dartsnut_ask_question", argumentsJson: JSON.stringify({ question_id: "project_type" }) }
        ]
      };
    }
    if (this.call === 3) {
      return {
        content: "",
        toolCalls: [
          {
            id: "set_pt",
            name: "dartsnut_project_intake",
            argumentsJson: JSON.stringify({ action: "set_project_type", project_type: "widget" })
          }
        ]
      };
    }
    if (this.call === 4) {
      return {
        content: "",
        toolCalls: [
          { id: "ask_sz", name: "dartsnut_ask_question", argumentsJson: JSON.stringify({ question_id: "widget_display_size" }) }
        ]
      };
    }
    if (this.call === 5) {
      return {
        content: "",
        toolCalls: [
          {
            id: "set_sz",
            name: "dartsnut_project_intake",
            argumentsJson: JSON.stringify({ action: "set_widget_size", widget_size: "128x128" })
          }
        ]
      };
    }
    if (this.call === 6) {
      return {
        content: "",
        toolCalls: [
          {
            id: "read_conf",
            name: "dartsnut_project_intake",
            argumentsJson: JSON.stringify({ action: "read_workspace_conf" })
          }
        ]
      };
    }
    if (this.call === 7) {
      return {
        content: "",
        toolCalls: [
          {
            id: "wf_ok",
            name: "write_file",
            argumentsJson: JSON.stringify({ path: "main.py", content: "print('ok')" })
          }
        ]
      };
    }
    return { content: "Done.", toolCalls: [] };
  }
}

class IntakeAskBeforeSetProvider {
  call = 0;
  sawBlockedSetProjectType = false;

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.call += 1;
    if (this.call === 2) {
      const blocked = messages
        .filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool")
        .some((m) => m.content.includes("before set_project_type"));
      this.sawBlockedSetProjectType = blocked;
    }
    if (this.call === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "set_pt_first",
            name: "dartsnut_project_intake",
            argumentsJson: JSON.stringify({ action: "set_project_type", project_type: "game" })
          }
        ]
      };
    }
    if (this.call === 2) {
      return {
        content: "",
        toolCalls: [
          {
            id: "ask_pt_then",
            name: "dartsnut_ask_question",
            argumentsJson: JSON.stringify({ question_id: "project_type" })
          }
        ]
      };
    }
    if (this.call === 3) {
      return {
        content: "",
        toolCalls: [
          {
            id: "set_pt_after",
            name: "dartsnut_project_intake",
            argumentsJson: JSON.stringify({ action: "set_project_type", project_type: "game" })
          }
        ]
      };
    }
    if (this.call === 4) {
      return {
        content: "",
        toolCalls: [
          {
            id: "read_conf",
            name: "dartsnut_project_intake",
            argumentsJson: JSON.stringify({ action: "read_workspace_conf" })
          }
        ]
      };
    }
    if (this.call === 5) {
      return {
        content: "",
        toolCalls: [
          {
            id: "write_ok",
            name: "write_file",
            argumentsJson: JSON.stringify({ path: "main.py", content: "print('game')" })
          }
        ]
      };
    }
    return { content: "Done.", toolCalls: [] };
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

class StreamingNativeWriteHelloProvider {
  async complete(_messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult> {
    const args = '{"path":"hello.txt","content":"aft';
    options?.onToolCallProgress?.([
      { id: "call_hello", name: "write_file", argumentsJson: args }
    ]);
    options?.onToolCallProgress?.([
      {
        id: "call_hello",
        name: "write_file",
        argumentsJson: `${args}er"}`
      }
    ]);
    return {
      content: "",
      toolCalls: [
        {
          id: "call_hello",
          name: "write_file",
          argumentsJson: JSON.stringify({ path: "hello.txt", content: "after" })
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

class GetEmulatorLogsNativeProvider {
  private call = 0;
  public readonly receivedMessages: ChatMessage[][] = [];

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.call += 1;
    this.receivedMessages.push(messages.map((m) => ({ ...m }) as ChatMessage));
    if (this.call === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "call_logs",
            name: "get_emulator_logs",
            argumentsJson: JSON.stringify({ max_lines: 12 })
          }
        ]
      };
    }
    return { content: "Emulator logs look clean.", toolCalls: [] };
  }
}

class CreatorCleanVerifyProvider {
  private call = 0;

  async complete(): Promise<CompletionResult> {
    this.call += 1;
    if (this.call === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "wf_conf",
            name: "write_file",
            argumentsJson: JSON.stringify({
              path: "conf.json",
              content: '{"type":"widget","size":[128,128]}'
            })
          },
          {
            id: "wf_main",
            name: "write_file",
            argumentsJson: JSON.stringify({ path: "main.py", content: "print('ok')\n" })
          }
        ]
      };
    }
    if (this.call === 2) {
      return {
        content: "",
        toolCalls: [
          {
            id: "call_reload",
            name: "reload_emulator",
            argumentsJson: "{}"
          },
          {
            id: "call_logs",
            name: "get_emulator_logs",
            argumentsJson: JSON.stringify({ max_lines: 12 })
          }
        ]
      };
    }
    return {
      content: "",
      toolCalls: [
        {
          id: "call_replace",
          name: "replace_in_file",
          argumentsJson: JSON.stringify({
            path: "main.py",
            old_string: "print('ok')",
            new_string: "print('still going')"
          })
        }
      ]
    };
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

  it("parses Claude <function_calls> XML for intake host tools", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const intakeCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const engine = new SessionEngine({
      provider: new ClaudeFunctionCallsXmlProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a creation intake assistant.",
      completionTools: AGENT_CREATION_INTAKE_TOOL_SCHEMAS,
      hostIntakeToolHandler: async (args) => {
        intakeCalls.push({ tool: "dartsnut_project_intake", args });
        return JSON.stringify({ ok: true });
      },
      hostAskQuestionHandler: async (args) => {
        intakeCalls.push({ tool: "dartsnut_ask_question", args });
        return JSON.stringify({ ok: true, question_id: args.question_id });
      }
    });

    await engine.runPrompt("new widget", () => { });

    expect(intakeCalls).toEqual(
      expect.arrayContaining([
        { tool: "dartsnut_ask_question", args: { question_id: "widget_display_size" } },
        {
          tool: "dartsnut_project_intake",
          args: { action: "set_project_type", project_type: "widget" }
        }
      ])
    );
  });

  it("runs blocking ask_question before set_widget_size when both are emitted in one turn", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const executionOrder: string[] = [];
    const engine = new SessionEngine({
      provider: new ClaudeIntakeBatchOrderProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a creation intake assistant.",
      completionTools: AGENT_CREATION_INTAKE_TOOL_SCHEMAS,
      hostIntakeToolHandler: async (args) => {
        executionOrder.push(`intake:${String(args.action)}`);
        return JSON.stringify({ ok: true });
      },
      hostAskQuestionHandler: async (args) => {
        executionOrder.push(`ask:${String(args.question_id)}`);
        return JSON.stringify({ ok: true, question_id: args.question_id });
      }
    });

    await engine.runPrompt("widget clock 128x128", () => { });

    const askIdx = executionOrder.indexOf("ask:widget_display_size");
    const sizeIdx = executionOrder.indexOf("intake:set_widget_size");
    expect(askIdx).toBeGreaterThanOrEqual(0);
    expect(sizeIdx).toBeGreaterThanOrEqual(0);
    expect(askIdx).toBeLessThan(sizeIdx);
  });

  it("blocks file writes until intake type/size/conf are resolved", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const provider = new IntakeGuardNativeProvider();
    const engine = new SessionEngine({
      provider,
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant.",
      hostAskQuestionHandler: async (args) => {
        if (args.question_id === "project_type") {
          return JSON.stringify({ ok: true, recorded: { projectType: "widget" } });
        }
        return JSON.stringify({ ok: true, recorded: { widgetSize: "128x128" } });
      },
      hostIntakeToolHandler: async (args) => {
        if (args.action === "read_workspace_conf") {
          return JSON.stringify({ ok: true, conf_status: "missing" });
        }
        return JSON.stringify({ ok: true });
      }
    });

    const response = await engine.runPrompt("make something cute", () => { });

    expect(response).toContain("Done.");
    expect(provider.sawBlockedWrite).toBe(true);
    expect(fs.readFileSync(path.join(tempRoot, "main.py"), "utf-8")).toBe("print('ok')");
  });

  it("blocks set_project_type until project_type question is asked", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const provider = new IntakeAskBeforeSetProvider();
    const engine = new SessionEngine({
      provider,
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant.",
      hostAskQuestionHandler: async () =>
        JSON.stringify({ ok: true, recorded: { projectType: "game" } }),
      hostIntakeToolHandler: async (args) => {
        if (args.action === "read_workspace_conf") {
          return JSON.stringify({ ok: true, conf_status: "missing" });
        }
        return JSON.stringify({ ok: true });
      }
    });

    const response = await engine.runPrompt("surprise me", () => { });

    expect(response).toContain("Done.");
    expect(provider.sawBlockedSetProjectType).toBe(true);
    expect(fs.readFileSync(path.join(tempRoot, "main.py"), "utf-8")).toBe("print('game')");
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

  it("finalizes write_file preview before tool execution when live tool progress streamed", async () => {
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
    const combinedStream = streamEvents.map((event) => event.delta).join("");
    expect(combinedStream).toContain("Planning the widget layout.");
    expect(combinedStream).toContain('"tool":"write_file"');
    expect(combinedStream).toContain("widget.py");

    const finals = events.filter(
      (event): event is Extract<AgentEvent, { type: "final" }> => event.type === "final"
    );
    const previewFinal = finals.find((event) => event.content === "");
    expect(previewFinal).toBeDefined();

    const firstStatusIdx = events.findIndex((event) => event.type === "status");
    const previewFinalIdx = events.findIndex((event) => event === previewFinal);
    expect(firstStatusIdx).toBeGreaterThan(previewFinalIdx);
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

  it("keeps replace_in_file preview in stream and finalizes before tool execution", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    fs.writeFileSync(path.join(tempRoot, "main.py"), "old", "utf-8");
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new StreamingNativeReplaceInFileProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    await engine.runPrompt("edit main.py", (event) => events.push(event));

    const combinedStream = events
      .filter((event): event is Extract<AgentEvent, { type: "stream" }> => event.type === "stream")
      .map((event) => event.delta)
      .join("");
    expect(combinedStream).toContain('"tool":"replace_in_file"');
    expect(combinedStream).toContain('"find":"old"');
    expect(combinedStream).toContain('"replace":"new"');

    const previewFinalIdx = events.findIndex(
      (event) => event.type === "final" && event.content === ""
    );
    const firstStatusIdx = events.findIndex((event) => event.type === "status");
    expect(previewFinalIdx).toBeGreaterThanOrEqual(0);
    expect(firstStatusIdx).toBeGreaterThan(previewFinalIdx);
    expect(fs.readFileSync(path.join(tempRoot, "main.py"), "utf-8")).toBe("new");
  });

  it("includes previousContent in live write_file envelope when file already exists", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    fs.writeFileSync(path.join(tempRoot, "hello.txt"), "before", "utf-8");
    const events: AgentEvent[] = [];
    const engine = new SessionEngine({
      provider: new StreamingNativeWriteHelloProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant."
    });

    await engine.runPrompt("update hello.txt", (event) => events.push(event));

    const streamDeltas = events
      .filter((event): event is Extract<AgentEvent, { type: "stream" }> => event.type === "stream")
      .map((event) => event.delta);
    const withPrevious = streamDeltas.filter((delta) => delta.includes('"previousContent":"before"'));
    expect(withPrevious.length).toBeGreaterThan(0);
    const lastWithPrevious = withPrevious.at(-1)!;
    expect(lastWithPrevious).toContain('"path":"hello.txt"');
    expect(lastWithPrevious).toContain('"content":"after"');
    const previousIdx = lastWithPrevious.indexOf('"previousContent"');
    const contentIdx = lastWithPrevious.indexOf('"content"');
    expect(previousIdx).toBeGreaterThanOrEqual(0);
    expect(previousIdx).toBeLessThan(contentIdx);
    expect(fs.readFileSync(path.join(tempRoot, "hello.txt"), "utf-8")).toBe("after");
  });

  it("executes get_emulator_logs via host handler with max_lines", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const events: AgentEvent[] = [];
    const provider = new GetEmulatorLogsNativeProvider();
    const mockPayload = JSON.stringify({
      ok: true,
      lines: [{ stream: "stdout", text: "widget started" }],
      emulator: { running: true, status: "Running" }
    });
    let receivedMaxLines: number | undefined;
    const engine = new SessionEngine({
      provider,
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a widget creator.",
      hostGetEmulatorLogsHandler: async (args) => {
        receivedMaxLines = args.max_lines;
        return mockPayload;
      }
    });

    const response = await engine.runPrompt("check emulator logs", (event) => events.push(event));

    expect(response).toContain("Emulator logs look clean.");
    expect(receivedMaxLines).toBe(12);

    const toolMessage = provider.receivedMessages[1]?.find(
      (m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool"
    );
    expect(toolMessage?.tool_call_id).toBe("call_logs");
    expect(toolMessage?.content).toContain("widget started");

    const statusMessages = events
      .filter((event): event is Extract<AgentEvent, { type: "status" }> => event.type === "status")
      .map((event) => event.message);
    expect(statusMessages.some((m) => m.toLowerCase().includes("emulator log"))).toBe(true);
  });

  it("stops creator flow after reload and clean emulator logs once scaffold exists", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const cleanLogs = JSON.stringify({
      ok: true,
      lines: [{ source: "stdout", text: "widget started" }],
      emulator: { running: true, status: "Running", lastError: null }
    });
    const engine = new SessionEngine({
      provider: new CreatorCleanVerifyProvider(),
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a widget creator.",
      sessionTemplateMode: "widget-creator",
      hostReloadEmulatorHandler: async () => JSON.stringify({ ok: true }),
      hostGetEmulatorLogsHandler: async () => cleanLogs
    });

    const response = await engine.runPrompt("build widget", () => {});

    expect(response).toContain("Widget runs cleanly in the emulator.");
    expect(engine.lastRunStoppedOnCleanEmulator()).toBe(true);
    expect(fs.readFileSync(path.join(tempRoot, "main.py"), "utf-8")).toBe("print('ok')\n");
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

    const streamedEnvelope = events
      .filter((event): event is Extract<AgentEvent, { type: "stream" }> => event.type === "stream")
      .map((event) => event.delta)
      .join("");
    expect(streamedEnvelope).toContain('"actions"');
    expect(streamedEnvelope).toContain('"tool":"write_file"');
    expect(streamedEnvelope).toContain('"path":"widget.py"');
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

  it("runs flip-clock creator flow with read then small replace per iteration", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const provider = new FlipClockPhasedBuildProvider();
    const engine = new SessionEngine({
      provider,
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a widget creator.",
      sessionTemplateMode: "widget-creator"
    });

    const prompt = ["TEMPLATE", "", "User request:", "create 128x128 flipping clock widget"].join("\n");
    const response = await engine.runPrompt(prompt, () => { });

    expect(provider.call).toBe(5);
    expect(provider.toolFirstTurn).toBe(true);
    expect(provider.readBeforeEdit).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, "conf.json"))).toBe(true);
    expect(fs.readFileSync(path.join(tempRoot, "main.py"), "utf-8")).toContain("flip");
    expect(response).toContain("Clock widget ready.");
  });

  it("does not inject host recovery messages when creator ends with reasoning only", async () => {
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
    await engine.runPrompt(prompt, () => { });

    expect(provider.call).toBe(1);
    const injectedRecovery = provider.lastMessages.filter(
      (m) =>
        m.role === "user" &&
        (m.content.includes("Phase 3+ is not implemented") ||
          m.content.includes("You replied without creating the required project files"))
    );
    expect(injectedRecovery).toHaveLength(0);
  });

  it("nudges creator to scaffold when the first reply has no tools and conf.json is missing", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const provider = new CreatorClarifyThenBuildProvider();
    const engine = new SessionEngine({
      provider,
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a widget creator.",
      sessionTemplateMode: "widget-creator"
    });

    const prompt = ["TEMPLATE", "", "User request:", "Trajectory smoothing"].join("\n");
    const response = await engine.runPrompt(prompt, () => { });

    expect(provider.call).toBe(3);
    expect(
      provider.lastMessages.some(
        (m) => m.role === "user" && m.content.includes("no conf.json yet")
      )
    ).toBe(true);
    expect(response).toContain("Done.");
    expect(fs.existsSync(path.join(tempRoot, "conf.json"))).toBe(true);
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

    const response = await engine.runPrompt("scaffold", () => { });
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

    const response = await engine.runPrompt("try load display mapping", () => { });
    expect(response).toContain("Noted denial.");
  });
});

const PHASE2_STUB_MAIN_PY = `from PIL import Image

def main():
    frame = Image.new("RGB", (128, 128), (0, 0, 0))
`;

class FlipClockPhasedBuildProvider implements CompletionProvider {
  call = 0;
  toolFirstTurn = false;
  readBeforeEdit = false;
  lastMessages: ChatMessage[] = [];

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.call += 1;
    this.lastMessages = messages;
    if (this.call === 1) {
      this.toolFirstTurn = true;
      return {
        content: "Scaffolding conf.json.",
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
        content: "Stub main.py.",
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
        content: "Reading main.py before edit.",
        toolCalls: [
          {
            id: "call_read",
            name: "read_file",
            argumentsJson: JSON.stringify({ path: "main.py" })
          }
        ]
      };
    }
    if (this.call === 4) {
      this.readBeforeEdit = true;
      return {
        content: "Small flip-clock edit.",
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
    return {
      content: "",
      toolCalls: [],
      reasoningContent: "```python\n" + "flip_clock = True\n".repeat(400) + "\n```"
    };
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
      return {
        content: "Scaffolding.",
        toolCalls: [
          {
            id: "w_conf",
            name: "write_file",
            argumentsJson: JSON.stringify({
              path: "conf.json",
              content:
                '{"id":"t","type":"widget","name":"T","author":"A","version":"1","description":"d","size":[128,128],"fields":[],"preview":[""]}'
            })
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

class BlockingUntilAbortProvider implements CompletionProvider {
  calls = 0;

  async complete(_messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult> {
    this.calls += 1;
    const signal = options?.abortSignal;
    await new Promise<CompletionResult>((_resolve, reject) => {
      if (!signal) {
        reject(new Error("expected abortSignal"));
        return;
      }
      if (signal.aborted) {
        reject(new Error(AGENT_STOPPED_MESSAGE));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          reject(new Error(AGENT_STOPPED_MESSAGE));
        },
        { once: true }
      );
    });
    return textOnly("never");
  }
}

describe("SessionEngine abort", () => {
  it("stops runPrompt when abortSignal fires during provider.complete", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-abort-"));
    const abort = new AbortController();
    const provider = new BlockingUntilAbortProvider();
    const engine = new SessionEngine({
      provider,
      workspacePolicy: new WorkspacePolicy(tempRoot),
      skillPrompt: "You are a coding assistant.",
      skipInitialWorkspaceResolve: true
    });

    const run = engine.runPrompt("stop me", () => { }, abort.signal);
    const rejection = expect(run).rejects.toThrow(AGENT_STOPPED_MESSAGE);
    abort.abort();
    await rejection;
    expect(provider.calls).toBe(1);
  });
});

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

    await engine.runPrompt("first line", () => { });
    await engine.runPrompt("second line", () => { });

    const userLines = provider.lastMessages
      .filter((m): m is Extract<ChatMessage, { role: "user" }> => m.role === "user")
      .map((m) => m.content);
    expect(userLines.some((c) => c.includes("first line"))).toBe(true);
    expect(userLines.some((c) => c.includes("second line"))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, ".dartsnut", "agent-session", "conversation.json"))).toBe(true);
  });
});
