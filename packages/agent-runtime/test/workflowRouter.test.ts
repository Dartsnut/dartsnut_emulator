import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decideWorkflowRoute } from "../src/workflowRouter";

describe("workflow router", () => {
  it("routes empty workspace to creation", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-router-empty-"));
    const route = decideWorkflowRoute(workspace);
    expect(route.kind).toBe("creation");
    expect(route.initialPassComplete).toBe(false);
  });

  it("routes workspace with only session metadata to creation", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-router-meta-"));
    fs.mkdirSync(path.join(workspace, ".dartsnut", "agent-session"), { recursive: true });
    const route = decideWorkflowRoute(workspace);
    expect(route.kind).toBe("creation");
    expect(route.initialPassComplete).toBe(false);
  });

  it("routes workspace with conf.json and main.py to modification", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-router-mod-"));
    fs.writeFileSync(path.join(workspace, "conf.json"), '{"type":"widget","size":[128,128]}', "utf-8");
    fs.writeFileSync(path.join(workspace, "main.py"), "print('hi')\n", "utf-8");
    const route = decideWorkflowRoute(workspace);
    expect(route.kind).toBe("modification");
    expect(route.initialPassComplete).toBe(true);
  });

  it("routes workspace with only main.py to creation", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-router-partial-"));
    fs.writeFileSync(path.join(workspace, "main.py"), "print('hi')\n", "utf-8");
    const route = decideWorkflowRoute(workspace);
    expect(route.kind).toBe("creation");
    expect(route.mainPyExists).toBe(true);
    expect(route.confExists).toBe(false);
  });
});
