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
      contextSnapshot: ctx
    });
    expect(agent.name).toBe(DARTSNUT_MAIN_AGENT_NAME);
    expect(agent.handoffs ?? []).toHaveLength(0);
    expect(agent.modelSettings?.retry).toMatchObject({
      maxRetries: 5,
      backoff: { initialDelayMs: 1_000, maxDelayMs: 16_000, multiplier: 2, jitter: false }
    });
  });

  it("exposes the full tool surface in creator mode", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace);
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx
    });
    const toolNames = agent.tools.map((tool) => "name" in tool ? String(tool.name) : "");
    expect(toolNames).toContain("grep_files");
    expect(toolNames).toContain("glob_files");
    expect(toolNames).toContain("check_python");
    expect(toolNames).toContain("observe_emulator");
    expect(toolNames).toContain("control_emulator_input");
    expect(toolNames).toContain("run_emulator_scenario");
    expect(toolNames).toContain("pixellab_generate");
    expect(toolNames).not.toContain("web_search");
    expect(toolNames).not.toContain("code_interpreter");
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
    expect(toolNames).not.toContain("pixellab_generate");
  });

  it("includes static current-message language guidance", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace);
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx
    });
    expect(agent.instructions).toContain(
      "Respond in the language used by the user in their current message when possible."
    );
    expect(agent.instructions).not.toContain("Session locale");
    expect(agent.instructions).not.toContain("zh-Hans");
    expect(agent.instructions).not.toContain("zh-Hant");
  });

  it("adds selected persona behavior while preserving Export baseline", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace);
    const child = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx,
      agentProfileId: "child-curious"
    });
    const exportAgent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: ctx,
      agentProfileId: "export"
    });
    expect(child.instructions).toContain("Speak to a child");
    expect(child.instructions).toContain("always ask exactly one clear, child-friendly design question");
    expect(child.instructions).toContain("call the `ask_user_question` tool");
    expect(child.instructions).toContain("do not start building yet");
    expect(child.instructions).toContain("two or three simple choices");
    expect(child.instructions).toContain("include stopping here as one of the choices");
    expect(child.instructions).toContain("Persona identity: Mia · Life Spark.");
    expect(child.instructions).not.toContain("pronouns:");
    expect(child.instructions).toContain("warm, expressive, colorful life-tech details");
    expect(child.instructions).not.toContain("Otherwise proceed without intake ceremony");
    expect(exportAgent.instructions).not.toContain("Speak to a child");
    expect(exportAgent.instructions).toContain("Ask one concise natural-language question only");
    expect(exportAgent.instructions).toContain("wait for the tool answer before continuing");
  });

  it("keeps creator question policies isolated by persona", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace);
    const build = (agentProfileId: "child-curious" | "teen-builder" | "adult-vibe") =>
      buildDartsnutAgent({
        model: "gpt-4.1-mini",
        toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
        contextSnapshot: ctx,
        agentProfileId
      }).instructions;

    expect(build("child-curious")).toContain("always ask exactly one clear, child-friendly design question");
    expect(build("teen-builder")).toContain("Ask fewer questions, expose important implementation decisions");
    expect(build("adult-vibe")).toContain("Ask questions only when ambiguity blocks progress");
    expect(build("teen-builder")).not.toContain("child-friendly design question");
    expect(build("adult-vibe")).not.toContain("child-friendly design question");
  });

  it("requires both child personas to ask before building a sparse idea", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const ctx = makeContext(workspace);
    for (const agentProfileId of ["child-curious", "child-creator"] as const) {
      const agent = buildDartsnutAgent({
        model: "gpt-4.1-mini",
        toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
        contextSnapshot: ctx,
        agentProfileId
      });
      expect(agent.instructions).toContain("This child question policy overrides");
      expect(agent.instructions).toContain("`let's make a clock`");
      expect(agent.instructions).toContain("wait for the child's answer");
      expect(agent.instructions).toContain("exactly one easy next-step question");
    }
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

  it("teaches creator agent when to use PixelLab", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-"));
    const agent = buildDartsnutAgent({
      model: "gpt-4.1-mini",
      toolsBase: { workspacePolicy: new WorkspacePolicy(workspace) },
      contextSnapshot: makeContext(workspace)
    });
    expect(agent.instructions).toContain("pixellab_generate");
    expect(agent.instructions).toContain("sprites, characters, objects, tiles, icons, backgrounds, UI art");
    expect(agent.instructions).toContain("Draw visuals directly in code only for simple geometric shapes and basic UI primitives");
    expect(agent.instructions).toContain("never approximate art-bearing assets with procedural or code-drawn graphics");
    expect(agent.instructions).toContain("PIXELLAB_PENDING");
    expect(agent.instructions).toContain("generation_id");
    expect(agent.instructions).not.toContain("Prefer existing bound assets or code-drawn graphics");
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
