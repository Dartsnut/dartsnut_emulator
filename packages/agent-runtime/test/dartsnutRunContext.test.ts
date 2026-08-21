import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  refreshDartsnutRunContext,
  seedDartsnutRunContext
} from "../src/dartsnutRunContext";

describe("dartsnutRunContext workspace hydration", () => {
  it("hydrates existing scaffold routing from conf.json", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-ctx-"));
    fs.writeFileSync(
      path.join(workspace, "conf.json"),
      JSON.stringify({ size: [128, 128], fields: [] })
    );
    fs.writeFileSync(path.join(workspace, "pyproject.toml"), '[project]\nname="demo"\nversion="1"\ndependencies=["pydartsnut"]\n');
    fs.writeFileSync(path.join(workspace, "main.py"), "print('ok')\n");

    const ctx = seedDartsnutRunContext({
      workspacePath: workspace,
      skillsDir: path.join(process.cwd(), "skills")
    });

    expect(ctx.projectType).toBe("widget");
    expect(ctx.widgetSize).toBe("128x128");
    expect(ctx.artifacts.initialPassComplete).toBe(true);
  });

  it("refresh preserves workspace routing", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-ctx-refresh-"));
    fs.writeFileSync(
      path.join(workspace, "conf.json"),
      JSON.stringify({ size: [128, 128], fields: [] })
    );
    fs.writeFileSync(path.join(workspace, "pyproject.toml"), '[project]\nname="demo"\nversion="1"\ndependencies=["pydartsnut"]\n');
    fs.writeFileSync(path.join(workspace, "main.py"), "print('ok')\n");

    const ctx = seedDartsnutRunContext({
      workspacePath: workspace,
      skillsDir: path.join(process.cwd(), "skills")
    });

    refreshDartsnutRunContext(ctx);

    expect(ctx.projectType).toBe("widget");
    expect(ctx.widgetSize).toBe("128x128");
  });
});
