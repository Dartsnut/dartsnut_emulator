import { describe, expect, it } from "vitest";
import {
  hasSubstantiveCreatorUserRequest,
  shouldInjectCreatorIncompleteNudge
} from "../src/creatorTurnGuard";
import type { ChatMessage } from "../src/providerClient";

describe("shouldInjectCreatorIncompleteNudge", () => {
  it("returns true for widget-creator with substantive prompt and missing artifacts", () => {
    expect(
      shouldInjectCreatorIncompleteNudge({
        templateMode: "widget-creator",
        artifacts: { confJson: false, mainPy: false },
        filesWrittenThisTurn: 0,
        initialPrompt: ["TEMPLATE", "", "User request:", "Trajectory smoothing"].join("\n"),
        messages: [],
        systemSlots: 0,
        nudgeCount: 0
      })
    ).toBe(true);
  });

  it("returns false when conf.json and main.py exist", () => {
    expect(
      shouldInjectCreatorIncompleteNudge({
        templateMode: "widget-creator",
        artifacts: { confJson: true, mainPy: true },
        filesWrittenThisTurn: 0,
        initialPrompt: "Trajectory smoothing",
        messages: [],
        systemSlots: 0,
        nudgeCount: 0
      })
    ).toBe(false);
  });

  it("returns false after max nudges", () => {
    expect(
      shouldInjectCreatorIncompleteNudge({
        templateMode: "widget-creator",
        artifacts: { confJson: false, mainPy: false },
        filesWrittenThisTurn: 0,
        initialPrompt: "Trajectory smoothing",
        messages: [],
        systemSlots: 0,
        nudgeCount: 4
      })
    ).toBe(false);
  });
});

describe("hasSubstantiveCreatorUserRequest", () => {
  it("detects routed follow-up user lines", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: ["TEMPLATE", "", "User request:", "Trajectory smoothing"].join("\n") }
    ];
    expect(hasSubstantiveCreatorUserRequest("", messages, 0)).toBe(true);
  });
});
