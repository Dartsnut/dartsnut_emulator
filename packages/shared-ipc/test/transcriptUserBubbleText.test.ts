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

  it("extracts the user line from post-intake host instructions", () => {
    const body = [
      "Creation **intake just finished**: …",
      "",
      "User request: 给我点儿惊喜"
    ].join("\n");
    const full = ["## Workspace metadata", "", "User request:", body].join("\n");
    expect(transcriptUserBubbleText(full)).toBe("给我点儿惊喜");
  });

  it("returns null when post-intake block has no original message", () => {
    const body = ["Creation **intake just finished**: …", "", "User request: (none recorded before intake)"].join(
      "\n"
    );
    const full = ["## Workspace metadata", "", "User request:", body].join("\n");
    expect(transcriptUserBubbleText(full)).toBeNull();
  });
});
