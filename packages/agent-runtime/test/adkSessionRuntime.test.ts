import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import { AdkSessionRuntime } from "../src/adkSessionRuntime";
import { buildModificationWorkflowPrompt } from "../src/modificationWorkflow";

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

describe("buildModificationWorkflowPrompt", () => {
  it("includes karpathy surgical constraints", () => {
    const prompt = buildModificationWorkflowPrompt({
      userPrompt: "make the background blue"
    });
    expect(prompt).toContain("karpathy-guidelines");
    expect(prompt).toContain("replace_in_file");
    expect(prompt).toContain("make the background blue");
  });
});

describe("AdkSessionRuntime", () => {
  it("uses modification workflow when conf.json and main.py exist", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-adk-mod-"));
    fs.writeFileSync(path.join(workspace, "conf.json"), '{"type":"widget","size":[128,128]}', "utf-8");
    fs.writeFileSync(path.join(workspace, "main.py"), "print('hi')\n", "utf-8");
    const spy = createEngineSpy();
    const runtime = new AdkSessionRuntime({
      workspacePath: workspace,
      engine: spy.engine as never
    });
    await runtime.runPrompt("hello", () => { });
    expect(spy.prompts).toHaveLength(1);
    expect(spy.prompts[0]).toContain("karpathy-guidelines");
    expect(spy.prompts[0]).toContain("hello");
  });

  it("runs creation only for empty workspace", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-adk-create-"));
    const spy = createEngineSpy();
    const runtime = new AdkSessionRuntime({
      workspacePath: workspace,
      engine: spy.engine as never
    });
    await runtime.runPrompt("create widget", () => { });
    expect(spy.prompts).toEqual(["create widget"]);
  });

  it("does not hand off to modification after creation scaffold", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-adk-create-"));
    const spy = createEngineSpy();
    let call = 0;
    const engine = {
      async runPrompt(prompt: string, _onEvent: (event: AgentEvent) => void): Promise<string> {
        call += 1;
        spy.prompts.push(prompt);
        if (call === 1) {
          fs.writeFileSync(path.join(workspace, "conf.json"), '{"type":"widget","size":[128,128]}', "utf-8");
          fs.writeFileSync(path.join(workspace, "main.py"), "print('hi')\n", "utf-8");
          return "Widget runs cleanly in the emulator.";
        }
        return "Should not run.";
      },
      lastRunStoppedOnCleanEmulator: () => true
    };
    const runtime = new AdkSessionRuntime({
      workspacePath: workspace,
      engine: engine as never
    });
    const result = await runtime.runPrompt("cute breathing widget", () => { });
    expect(spy.prompts).toHaveLength(1);
    expect(spy.prompts[0]).toBe("cute breathing widget");
    expect(result).toContain("Widget runs cleanly in the emulator.");
  });
});
