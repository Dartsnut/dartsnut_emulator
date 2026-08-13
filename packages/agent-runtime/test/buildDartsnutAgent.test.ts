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
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace), supportsHostedTools: true },
      contextSnapshot: ctx
    });
    expect(agent.name).toBe(DARTSNUT_MAIN_AGENT_NAME);
    expect(agent.handoffs ?? []).toHaveLength(0);
  });

  it("exposes the full tool surface in creator mode", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace);
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace), supportsHostedTools: true },
      contextSnapshot: ctx
    });
    const toolNames = agent.tools.map((tool) => "name" in tool ? String(tool.name) : "");
    expect(toolNames).toContain("grep_files");
    expect(toolNames).toContain("glob_files");
    expect(toolNames).toContain("check_python");
    expect(toolNames).toContain("observe_emulator");
    expect(toolNames).toContain("control_emulator_input");
    expect(toolNames).toContain("run_emulator_scenario");
    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("code_interpreter");
  });

  it("uses the constrained asset-applier tool set in asset-applier mode", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace, { assetApplierMode: true, templateMode: "asset-applier" });
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx
    });
    const toolNames = agent.tools.map((tool) => "name" in tool ? String(tool.name) : "");
    expect(toolNames).toContain("grep_files");
    expect(toolNames).not.toContain("copy_asset_file");
    expect(toolNames).not.toContain("web_search");
    expect(toolNames).not.toContain("code_interpreter");
  });

  it("includes selected session locale and behavior-invariance policy in instructions", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace, { preferredUserLocale: "zh-Hant" });
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx,
      preferredUserLocale: "zh-Hant"
    });
    expect(agent.instructions).toContain("Session locale: zh-Hant");
    expect(agent.instructions).toContain("output-only");
    expect(agent.instructions).toContain("must not change behavior");
    expect(agent.instructions).toContain("routing");
    expect(agent.instructions).toContain("tool choice");
    expect(agent.instructions).toContain("project inference");
  });

  it("requires visual observation and input scenarios during emulator verification", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace);
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx
    });
    expect(agent.instructions).toContain("check_python");
    expect(agent.instructions).toContain("reload and observe the emulator");
    expect(agent.instructions).toContain("Exercise at least one input path");
  });

  it("routes game work to the game domain skill", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace, { templateMode: "game-creator" });
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx
    });
    expect(agent.instructions).toContain("dartsnut-game");
  });

  it("limits asset-applier skill routing", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace, { assetApplierMode: true, templateMode: "asset-applier" });
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx
    });
    expect(agent.instructions).not.toContain("- dartsnut-game");
    expect(agent.instructions).toContain("- dartsnut-assets");
  });

  it("proceeds on vague creative freedom and asks only for blocking ambiguity", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace);
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx
    });
    expect(agent.instructions).toContain("surprise me");
    expect(agent.instructions).toContain("Ask one concise natural-language question only");
    expect(agent.instructions).not.toContain("caveman");
  });
});
