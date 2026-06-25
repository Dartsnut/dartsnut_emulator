import { describe, expect, it } from "vitest";
import { buildAgentTools } from "../src/agentTools";
import { WorkspacePolicy } from "../src/workspacePolicy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function toolNames(workspace: string, profile: "full" | "asset-applier"): string[] {
  const tools = buildAgentTools({
    workspacePolicy: new WorkspacePolicy(workspace),
    profile
  });
  return tools.map((t) => (t.type === "function" ? (t as { name: string }).name : ""));
}

describe("buildAgentTools profiles", () => {
  it("full profile exposes search, file, skill, emulator, check_python and intake tools", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-tools-"));
    const names = toolNames(workspace, "full");
    for (const expected of [
      "list_files",
      "grep_files",
      "glob_files",
      "read_file",
      "write_file",
      "replace_in_file",
      "get_dartsnut_skill",
      "reload_emulator",
      "get_emulator_logs",
      "check_python",
      "dartsnut_project_intake",
      "dartsnut_ask_question",
      "dartsnut_machine_mcp"
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("asset-applier profile keeps search + file tools but drops copy_asset_file and intake", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-tools-"));
    const names = toolNames(workspace, "asset-applier");
    expect(names).toContain("grep_files");
    expect(names).toContain("glob_files");
    expect(names).toContain("write_file");
    expect(names).toContain("check_python");
    expect(names).not.toContain("copy_asset_file");
    expect(names).not.toContain("dartsnut_project_intake");
    expect(names).not.toContain("dartsnut_ask_question");
    expect(names).not.toContain("dartsnut_machine_mcp");
  });
});
