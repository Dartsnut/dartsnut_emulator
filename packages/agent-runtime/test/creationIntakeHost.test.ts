import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collapseConsecutiveToolNames,
  normalizeHostIntakeActions
} from "./helpers/breathingWidgetProviderE2e";
import {
  createIntakeHostHandlers,
  executeIntakeHostTool,
  isIntakeStateReady,
  parseConfWidgetSize,
  readWorkspaceConfIntakeSnapshot
} from "../src/creationIntakeHost";

describe("creationIntakeHost", () => {
  it("parseConfWidgetSize maps [128, 128] to 128x128", () => {
    expect(parseConfWidgetSize([128, 128])).toBe("128x128");
    expect(parseConfWidgetSize([99, 99])).toBeUndefined();
  });

  it("executeIntakeHostTool records project type and widget size when user text is explicit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-intake-host-"));
    const state = {};
    const prompt = "Create a cute breathing widget at 128x128";
    await executeIntakeHostTool(
      { action: "set_project_type", project_type: "widget" },
      state,
      root,
      { lastUserPrompt: prompt }
    );
    await executeIntakeHostTool(
      { action: "set_widget_size", widget_size: "128x128" },
      state,
      root,
      { lastUserPrompt: prompt }
    );
    expect(state.projectType).toBe("widget");
    expect(state.widgetSize).toBe("128x128");
    const snapshot = readWorkspaceConfIntakeSnapshot(root, state);
    expect(snapshot.conf_status).toBe("missing");
  });

  it("rejects guessed widget size for vague prompts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-intake-vague-"));
    const state = { projectType: "widget" as const, projectTypeUserConfirmed: true };
    const res = await executeIntakeHostTool(
      { action: "set_widget_size", widget_size: "128x128" },
      state,
      root,
      { lastUserPrompt: "surprise me" }
    );
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(false);
    expect(state.widgetSize).toBeUndefined();
  });

  it("normalizeHostIntakeActions inserts set_widget_size before read_workspace_conf", () => {
    expect(
      normalizeHostIntakeActions(["set_project_type", "read_workspace_conf"])
    ).toEqual(["set_project_type", "set_widget_size", "read_workspace_conf"]);
  });

  it("collapseConsecutiveToolNames merges repeated skill loads", () => {
    expect(
      collapseConsecutiveToolNames([
        "get_dartsnut_skill",
        "get_dartsnut_skill",
        "write_file"
      ])
    ).toEqual(["get_dartsnut_skill", "write_file"]);
  });

  it("isIntakeStateReady is true for widget with size", () => {
    expect(isIntakeStateReady({ projectType: "widget", widgetSize: "128x128" })).toBe(true);
    expect(isIntakeStateReady({ projectType: "widget" })).toBe(false);
  });

  it("createIntakeHostHandlers simulates widget size chip answer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-intake-handlers-"));
    const hostActions: string[] = [];
    const asks: string[] = [];
    const handlers = createIntakeHostHandlers({
      workspaceRoot: root,
      lastUserPrompt: "I want a widget",
      onHostIntakeAction: (a) => hostActions.push(a),
      onAskQuestionInvoked: (q) => asks.push(q),
      resolveAskQuestion: async (questionId, state) => {
        if (questionId === "widget_display_size") {
          state.projectType = "widget";
          state.projectTypeUserConfirmed = true;
          state.widgetSize = "128x128";
          state.widgetSizeUserConfirmed = true;
          return JSON.stringify({ ok: true, recorded: { widgetSize: "128x128" } });
        }
        return JSON.stringify({ ok: false });
      }
    });
    await handlers.hostIntakeToolHandler({ action: "set_project_type", project_type: "widget" });
    await handlers.hostAskQuestionHandler({ question_id: "widget_display_size" });
    expect(asks).toEqual(["widget_display_size"]);
    expect(handlers.state.widgetSize).toBe("128x128");
    expect(hostActions).toEqual(["set_project_type"]);
  });
});
