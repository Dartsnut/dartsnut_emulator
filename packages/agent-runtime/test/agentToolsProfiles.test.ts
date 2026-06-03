import { describe, expect, it } from "vitest";
import { buildAgentTools } from "../src/agentTools";
import { WorkspacePolicy } from "../src/workspacePolicy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("buildAgentTools profiles", () => {
  it("intake profile excludes write_file", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-tools-"));
    const tools = buildAgentTools({
      workspacePolicy: new WorkspacePolicy(workspace),
      profile: "intake"
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("dartsnut_ask_question");
    expect(names).toContain("dartsnut_project_intake");
    expect(names).not.toContain("write_file");
  });

  it("orchestrator profile has no tools", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-tools-"));
    const tools = buildAgentTools({
      workspacePolicy: new WorkspacePolicy(workspace),
      profile: "orchestrator"
    });
    expect(tools).toHaveLength(0);
  });

  it("surgical profile excludes write_file", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-tools-"));
    const tools = buildAgentTools({
      workspacePolicy: new WorkspacePolicy(workspace),
      profile: "surgical"
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("replace_in_file");
    expect(names).not.toContain("write_file");
  });
});
