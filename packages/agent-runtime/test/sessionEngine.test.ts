import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import { SessionEngine } from "../src/sessionEngine";
import { WorkspacePolicy } from "../src/workspacePolicy";

class FakeProvider {
  private call = 0;

  async complete(): Promise<string> {
    this.call += 1;
    if (this.call === 1) {
      return JSON.stringify({
        response: "Creating file now.",
        actions: [
          {
            tool: "write_file",
            path: "hello.txt",
            content: "hello dartsnut"
          }
        ]
      });
    }
    return JSON.stringify({
      response: "Created hello.txt successfully.",
      actions: []
    });
  }
}

class FinalOnlyProvider {
  async complete(): Promise<string> {
    return JSON.stringify({
      response: "Done without tool actions.",
      actions: []
    });
  }
}

class CreateFileAliasProvider {
  private call = 0;

  async complete(): Promise<string> {
    this.call += 1;
    if (this.call === 1) {
      return JSON.stringify({
        response: "Creating file with alias.",
        actions: [
          {
            tool: "create_file",
            path: "alias.txt",
            text: "alias content"
          }
        ]
      });
    }
    return JSON.stringify({
      response: "Created alias.txt successfully.",
      actions: []
    });
  }
}

class MultiEnvelopeProvider {
  private call = 0;

  async complete(): Promise<string> {
    this.call += 1;
    if (this.call === 1) {
      return (
        '{"response":"first envelope","actions":[{"tool":"write_file","path":"one.txt","content":"1"}]}' +
        "\n\n" +
        '{"response":"second envelope","actions":[{"tool":"write_file","path":"two.txt","content":"2"}]}'
      );
    }
    return JSON.stringify({
      response: "All files written.",
      actions: []
    });
  }
}

class HashSuffixCopyProvider {
  private call = 0;

  async complete(): Promise<string> {
    this.call += 1;
    if (this.call === 1) {
      return JSON.stringify({
        response: "Copy with hash-style names.",
        actions: [
          {
            tool: "copy_asset_file",
            source: "font-deadbeef.pil",
            path: "fonts/font-cafebabe.pil"
          }
        ]
      });
    }
    return JSON.stringify({
      response: "Copied with canonical file names.",
      actions: []
    });
  }
}

class CopyAssetProvider {
  private call = 0;

  async complete(): Promise<string> {
    this.call += 1;
    if (this.call === 1) {
      return JSON.stringify({
        response: "Copying font asset.",
        actions: [
          {
            tool: "copy_asset_file",
            source: "font.pil",
            path: "fonts/font.pil"
          }
        ]
      });
    }
    return JSON.stringify({
      response: "Copied font asset.",
      actions: []
    });
  }
}

class ReplaceInFileProvider {
  private call = 0;

  async complete(): Promise<string> {
    this.call += 1;
    if (this.call === 1) {
      return JSON.stringify({
        response: "Updating greeting with replace action.",
        actions: [
          {
            tool: "replace_in_file",
            path: "hello.txt",
            find: "hello dartsnut",
            replace: "hello faster dartsnut"
          }
        ]
      });
    }
    return JSON.stringify({
      response: "Updated greeting.",
      actions: []
    });
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
});
