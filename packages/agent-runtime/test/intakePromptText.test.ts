import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import * as sharedIpc from "@dartsnut/shared-ipc";

describe("intake prompt timeline text", () => {
  it("formats a visible project type prompt for the timeline", () => {
    expect("getIntakePromptTimelineText" in sharedIpc).toBe(true);
    const getIntakePromptTimelineText = (
      sharedIpc as typeof sharedIpc & {
        getIntakePromptTimelineText?: (event: AgentEvent) => string | null;
      }
    ).getIntakePromptTimelineText;

    expect(
      getIntakePromptTimelineText?.({
        type: "intake_project_type_prompt",
        at: 1,
        visible: true,
        options: ["game", "widget"]
      })
    ).toBe("Game or widget?");
  });

  it("omits hidden intake prompts from the timeline", () => {
    expect("getIntakePromptTimelineText" in sharedIpc).toBe(true);
    const getIntakePromptTimelineText = (
      sharedIpc as typeof sharedIpc & {
        getIntakePromptTimelineText?: (event: AgentEvent) => string | null;
      }
    ).getIntakePromptTimelineText;

    expect(
      getIntakePromptTimelineText?.({
        type: "intake_widget_size_prompt",
        at: 1,
        visible: false
      })
    ).toBeNull();
  });
});
