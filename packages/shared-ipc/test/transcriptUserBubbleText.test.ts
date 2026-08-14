import { describe, expect, it } from "vitest";
import { transcriptUserBubbleText } from "../src/contracts";

describe("transcriptUserBubbleText", () => {
  it("returns plain prompts unchanged when not routed", () => {
    expect(transcriptUserBubbleText("  hello  ")).toBe("hello");
  });

  it("strips creator context before User request", () => {
    const full = [
      "## Workspace metadata",
      "",
      "Creation context:",
      '{"projectType":"widget"}',
      "",
      "User request:",
      "make a clock"
    ].join("\n");
    expect(transcriptUserBubbleText(full)).toBe("make a clock");
  });
});
