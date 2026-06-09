import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  refreshDartsnutRunContext,
  seedDartsnutRunContext
} from "../src/dartsnutRunContext";

describe("dartsnutRunContext workspace hydration", () => {
  it("treats existing scaffold as intake-ready on follow-up prompts", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-ctx-"));
    fs.writeFileSync(
      path.join(workspace, "conf.json"),
      JSON.stringify({ type: "widget", size: [128, 128] })
    );
    fs.writeFileSync(path.join(workspace, "main.py"), "print('ok')\n");

    const ctx = seedDartsnutRunContext({
      workspacePath: workspace,
      skillsDir: path.join(process.cwd(), "skills"),
      intakeState: {}
    });

    expect(ctx.intakeReady).toBe(true);
    expect(ctx.projectType).toBe("widget");
    expect(ctx.widgetSize).toBe("128x128");
    expect(ctx.artifacts.initialPassComplete).toBe(true);
  });

  it("refresh does not wipe workspace routing when host intake state is empty", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-ctx-refresh-"));
    fs.writeFileSync(
      path.join(workspace, "conf.json"),
      JSON.stringify({ type: "widget", size: [128, 128] })
    );
    fs.writeFileSync(path.join(workspace, "main.py"), "print('ok')\n");

    const ctx = seedDartsnutRunContext({
      workspacePath: workspace,
      skillsDir: path.join(process.cwd(), "skills"),
      intakeState: {}
    });

    refreshDartsnutRunContext(ctx, () => false, {});

    expect(ctx.intakeReady).toBe(true);
    expect(ctx.projectType).toBe("widget");
    expect(ctx.widgetSize).toBe("128x128");
  });
});
