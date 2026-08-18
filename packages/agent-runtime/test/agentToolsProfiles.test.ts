import { describe, expect, it } from "vitest";
import { buildAgentTools } from "../src/agentTools";
import { WorkspacePolicy } from "../src/workspacePolicy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function toolNames(workspace: string, profile: "full" | "asset-applier"): string[] {
  const tools = buildAgentTools({
    workspacePolicy: new WorkspacePolicy(workspace),
    profile,
    supportsHostedTools: profile === "full"
  });
  return tools.map((tool) => "name" in tool ? String(tool.name) : "");
}

describe("buildAgentTools profiles", () => {
  it("full profile exposes workspace, skill, emulator, and machine tools", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-tools-"));
    const names = toolNames(workspace, "full");
    for (const expected of [
      "list_files",
      "grep_files",
      "glob_files",
      "read_file",
      "write_file",
      "replace_in_file",
      "copy_chat_attachment",
      "get_dartsnut_skill",
      "reload_emulator",
      "get_emulator_logs",
      "observe_emulator",
      "control_emulator_input",
      "run_emulator_scenario",
      "check_python",
      "pixellab_generate",
      "dartsnut_machine_mcp",
      "ask_user_question",
      "web_search",
      "code_interpreter"
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("asset-applier profile keeps constrained search, file, and verification tools", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-tools-"));
    const names = toolNames(workspace, "asset-applier");
    expect(names).toContain("grep_files");
    expect(names).toContain("glob_files");
    expect(names).toContain("write_file");
    expect(names).toContain("check_python");
    expect(names).toContain("observe_emulator");
    expect(names).toContain("control_emulator_input");
    expect(names).toContain("run_emulator_scenario");
    expect(names).not.toContain("copy_asset_file");
    expect(names).not.toContain("copy_chat_attachment");
    expect(names).not.toContain("dartsnut_machine_mcp");
    expect(names).not.toContain("pixellab_generate");
    expect(names).not.toContain("ask_user_question");
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("code_interpreter");
  });
});
