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
});
