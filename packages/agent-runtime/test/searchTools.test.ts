import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentTools } from "../src/agentTools";
import { WorkspacePolicy } from "../src/workspacePolicy";
import type { DartsnutRunContext } from "../src/dartsnutRunContext";
import type { Tool } from "@openai/agents";

function ctx(partial: Partial<DartsnutRunContext>, workspacePath: string): DartsnutRunContext {
  return {
    workspacePath,
    templateMode: partial.templateMode ?? null,
    intakeReady: partial.intakeReady ?? false,
    artifacts: partial.artifacts ?? { confJson: false, mainPy: false, initialPassComplete: false },
    assetApplierMode: partial.assetApplierMode ?? false,
    skillsDir: partial.skillsDir ?? path.join(process.cwd(), "skills"),
    preferredUserLocale: partial.preferredUserLocale ?? null,
    projectType: partial.projectType,
    widgetSize: partial.widgetSize
  };
}

async function exec(tool: Tool | undefined, args: Record<string, unknown>): Promise<any> {
  if (!tool || tool.type !== "function") {
    throw new Error("tool is not a function tool");
  }
  const out = await (tool as any).invoke({ context: {} }, JSON.stringify(args));
  return JSON.parse(out);
}

function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.type === "function" && (t as any).name === name);
}

describe("intake gate on file mutations", () => {
  it("blocks write_file / replace_in_file / copy_asset_file until intake is ready", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-gate-"));
    const runContext = ctx({ intakeReady: false }, workspace);
    const tools = buildAgentTools({
      workspacePolicy: new WorkspacePolicy(workspace),
      profile: "full",
      getRunContext: () => runContext
    });
    const write = await exec(findTool(tools, "write_file"), { path: "main.py", content: "x=1\n" });
    expect(write.ok).toBe(false);
    expect(write.error).toMatch(/Record the project type/i);
    expect(fs.existsSync(path.join(workspace, "main.py"))).toBe(false);
  });

  it("allows writes once intake is ready", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-gate-"));
    const runContext = ctx({ intakeReady: true, projectType: "widget", widgetSize: "128x128" }, workspace);
    const tools = buildAgentTools({
      workspacePolicy: new WorkspacePolicy(workspace),
      profile: "full",
      getRunContext: () => runContext
    });
    const write = await exec(findTool(tools, "write_file"), { path: "conf.json", content: "{}\n" });
    expect(write.ok).toBe(true);
    expect(fs.existsSync(path.join(workspace, "conf.json"))).toBe(true);
  });

  it("allows writes when a conf.json already exists even if intake not re-run", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-gate-"));
    fs.writeFileSync(path.join(workspace, "conf.json"), "{}\n", "utf-8");
    const runContext = ctx(
      { intakeReady: false, artifacts: { confJson: true, mainPy: false, initialPassComplete: false } },
      workspace
    );
    const tools = buildAgentTools({
      workspacePolicy: new WorkspacePolicy(workspace),
      profile: "full",
      getRunContext: () => runContext
    });
    const write = await exec(findTool(tools, "write_file"), { path: "main.py", content: "x=1\n" });
    expect(write.ok).toBe(true);
  });

  it("does not gate asset-applier mode", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-gate-"));
    const runContext = ctx({ intakeReady: false, assetApplierMode: true }, workspace);
    const tools = buildAgentTools({
      workspacePolicy: new WorkspacePolicy(workspace),
      profile: "asset-applier",
      getRunContext: () => runContext
    });
    const write = await exec(findTool(tools, "write_file"), { path: "assets_loader.py", content: "x=1\n" });
    expect(write.ok).toBe(true);
  });
});

describe("search + file tools", () => {
  async function seedWorkspace(): Promise<string> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-search-"));
    await fsp.writeFile(path.join(workspace, "main.py"), "import pydartsnut\nALPHA = 1\nalpha = 2\n", "utf-8");
    await fsp.writeFile(path.join(workspace, "conf.json"), '{"type":"widget"}\n', "utf-8");
    await fsp.mkdir(path.join(workspace, "fonts"), { recursive: true });
    await fsp.writeFile(path.join(workspace, "fonts", "tiny.py"), "FONT = 'tiny'\n", "utf-8");
    await fsp.mkdir(path.join(workspace, "node_modules"), { recursive: true });
    await fsp.writeFile(path.join(workspace, "node_modules", "skip.py"), "ALPHA = 999\n", "utf-8");
    return workspace;
  }

  function buildTools(workspace: string): Tool[] {
    return buildAgentTools({ workspacePolicy: new WorkspacePolicy(workspace), profile: "full" });
  }

  it("grep_files matches with line numbers and respects glob + case", async () => {
    const workspace = await seedWorkspace();
    const tools = buildTools(workspace);
    const res = await exec(findTool(tools, "grep_files"), { pattern: "ALPHA", glob: "**/*.py" });
    expect(res.ok).toBe(true);
    const paths = res.matches.map((m: any) => m.path);
    expect(paths).toContain("main.py");
    expect(paths).not.toContain("node_modules/skip.py");
    const mainMatch = res.matches.find((m: any) => m.path === "main.py");
    expect(mainMatch.line).toBe(2);

    const ci = await exec(findTool(tools, "grep_files"), { pattern: "alpha", ignore_case: true });
    const ciMain = ci.matches.filter((m: any) => m.path === "main.py");
    expect(ciMain.length).toBe(2);
  });

  it("grep_files honors max_results with truncation flag", async () => {
    const workspace = await seedWorkspace();
    const tools = buildTools(workspace);
    const res = await exec(findTool(tools, "grep_files"), { pattern: "alpha", ignore_case: true, max_results: 1 });
    expect(res.matches.length).toBe(1);
    expect(res.truncated).toBe(true);
  });

  it("glob_files lists matching paths and skips node_modules", async () => {
    const workspace = await seedWorkspace();
    const tools = buildTools(workspace);
    const res = await exec(findTool(tools, "glob_files"), { pattern: "**/*.py" });
    expect(res.ok).toBe(true);
    expect(res.files).toContain("main.py");
    expect(res.files).toContain("fonts/tiny.py");
    expect(res.files).not.toContain("node_modules/skip.py");
  });

  it("read_file returns whole file by default and numbered slice with offset/limit", async () => {
    const workspace = await seedWorkspace();
    const tools = buildTools(workspace);
    const whole = await exec(findTool(tools, "read_file"), { path: "main.py" });
    expect(whole.content).toContain("import pydartsnut");
    expect(whole.startLine).toBeUndefined();

    const ranged = await exec(findTool(tools, "read_file"), { path: "main.py", offset: 2, limit: 1 });
    expect(ranged.content).toBe("2\tALPHA = 1");
    expect(ranged.startLine).toBe(2);
    expect(ranged.lineCount).toBe(4);
  });

  it("replace_in_file errors on ambiguous match unless replace_all", async () => {
    const workspace = await seedWorkspace();
    await fsp.writeFile(path.join(workspace, "dup.py"), "x = 1\nx = 1\n", "utf-8");
    const tools = buildTools(workspace);

    const ambiguous = await exec(findTool(tools, "replace_in_file"), {
      path: "dup.py",
      find: "x = 1",
      replace: "x = 2"
    });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toMatch(/matches 2 times/);

    const all = await exec(findTool(tools, "replace_in_file"), {
      path: "dup.py",
      find: "x = 1",
      replace: "x = 2",
      replace_all: true
    });
    expect(all.ok).toBe(true);
    expect(all.replaced).toBe(2);
    expect(fs.readFileSync(path.join(workspace, "dup.py"), "utf-8")).toBe("x = 2\nx = 2\n");
  });

  it("check_python delegates to the host handler", async () => {
    const workspace = await seedWorkspace();
    let received: { paths?: string[] } | undefined;
    const tools = buildAgentTools({
      workspacePolicy: new WorkspacePolicy(workspace),
      profile: "full",
      hostCheckPythonHandler: async (args) => {
        received = args;
        return JSON.stringify({ ok: true, errors: [] });
      }
    });
    const res = await exec(findTool(tools, "check_python"), { paths: ["main.py"] });
    expect(res.ok).toBe(true);
    expect(received?.paths).toEqual(["main.py"]);
  });
});
