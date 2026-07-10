import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDartsnutAgent, DARTSNUT_MAIN_AGENT_NAME } from "../src/agents/buildDartsnutAgents";
import { WorkspacePolicy } from "../src/workspacePolicy";
import { seedDartsnutRunContext } from "../src/dartsnutRunContext";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

function makeContext(workspace: string, overrides: Parameters<typeof seedDartsnutRunContext>[0] extends infer T ? Partial<T> : never = {}) {
  return seedDartsnutRunContext({
    workspacePath: workspace,
    skillsDir: SKILLS_DIR,
    ...overrides
  });
}

describe("buildDartsnutAgent", () => {
  it("builds a single agent with no handoffs", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace);
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx,
      getRunContext: () => ctx
    });
    expect(agent.name).toBe(DARTSNUT_MAIN_AGENT_NAME);
    expect(agent.handoffs ?? []).toHaveLength(0);
  });

  it("exposes the full tool surface in creator mode", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace);
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx,
      getRunContext: () => ctx
    });
    const toolNames = agent.tools.map((t) => (t.type === "function" ? (t as { name: string }).name : ""));
    expect(toolNames).toContain("grep_files");
    expect(toolNames).toContain("glob_files");
    expect(toolNames).toContain("check_python");
    expect(toolNames).toContain("observe_emulator");
    expect(toolNames).toContain("control_emulator_input");
    expect(toolNames).toContain("run_emulator_scenario");
    expect(toolNames).toContain("dartsnut_project_intake");
  });

  it("uses the constrained asset-applier tool set in asset-applier mode", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace, { assetApplierMode: true, templateMode: "asset-applier" });
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx,
      getRunContext: () => ctx
    });
    const toolNames = agent.tools.map((t) => (t.type === "function" ? (t as { name: string }).name : ""));
    expect(toolNames).toContain("grep_files");
    expect(toolNames).not.toContain("dartsnut_project_intake");
    expect(toolNames).not.toContain("copy_asset_file");
  });

  it("includes selected session locale and behavior-invariance policy in instructions", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace, { preferredUserLocale: "zh-Hant" });
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx,
      preferredUserLocale: "zh-Hant",
      getRunContext: () => ctx
    });
    expect(agent.instructions).toContain("Session locale: zh-Hant");
    expect(agent.instructions).toContain("output-only");
    expect(agent.instructions).toContain("must not change behavior");
    expect(agent.instructions).toContain("routing");
    expect(agent.instructions).toContain("tool choice");
    expect(agent.instructions).toContain("intake");
  });

  it("requires visual observation and input scenarios during emulator verification", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace);
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx,
      getRunContext: () => ctx
    });
    expect(agent.instructions).toContain("observe_emulator");
    expect(agent.instructions).toContain("run_emulator_scenario");
    expect(agent.instructions).toContain("nonblank");
  });

  it("introduces supported machine buttons when building games", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace, { templateMode: "game-creator" });
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx,
      getRunContext: () => ctx
    });
    expect(agent.instructions).toContain("Supported machine buttons");
    expect(agent.instructions).toContain("`A`, `B`, `UP`, `DOWN`, `LEFT`, `RIGHT`");
    expect(agent.instructions).toContain("get_button_events()");
    expect(agent.instructions).toContain("`btn_a`");
    expect(agent.instructions).toContain("button_events.get(\"btn_a\")");
  });

  it("does not introduce game button guidance in asset-applier mode", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace, { assetApplierMode: true, templateMode: "asset-applier" });
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx,
      getRunContext: () => ctx
    });
    expect(agent.instructions).not.toContain("Supported machine buttons");
  });

  it("requires caveman communication mode", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace);
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx,
      getRunContext: () => ctx
    });
    expect(agent.instructions).toContain("Always use **`caveman`** communication mode");
    expect(agent.instructions).toContain("Load **`caveman`** first");
  });
});
