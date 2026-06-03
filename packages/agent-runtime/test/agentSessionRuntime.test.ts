import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import { AgentSessionRuntime } from "../src/sessionRuntime";

function createEngineSpy() {
  const prompts: string[] = [];
  return {
    prompts,
    engine: {
      async runPrompt(prompt: string, _onEvent: (event: AgentEvent) => void): Promise<string> {
        prompts.push(prompt);
        return "done";
      },
      lastRunStoppedOnCleanEmulator: () => false
    }
  };
}

describe("AgentSessionRuntime", () => {
  it("delegates prompts to SessionEngine without imperative routing", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-mod-"));
    fs.writeFileSync(path.join(workspace, "conf.json"), '{"type":"widget","size":[128,128]}', "utf-8");
    fs.writeFileSync(path.join(workspace, "main.py"), "print('hi')\n", "utf-8");
    const spy = createEngineSpy();
    const runtime = new AgentSessionRuntime({
      workspacePath: workspace,
      engine: spy.engine as never
    });
    await runtime.runPrompt("hello", () => {});
    expect(spy.prompts).toEqual(["hello"]);
  });

  it("passes creation prompts unchanged", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-create-"));
    const spy = createEngineSpy();
    const runtime = new AgentSessionRuntime({
      workspacePath: workspace,
      engine: spy.engine as never
    });
    await runtime.runPrompt("create widget", () => {});
    expect(spy.prompts).toEqual(["create widget"]);
  });
});
