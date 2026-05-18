import { describe, expect, it } from "vitest";
import { transcriptUserBubbleText } from "../src/contracts";

describe("transcriptUserBubbleText", () => {
  it("returns plain prompts unchanged when not routed", () => {
    expect(transcriptUserBubbleText("  hello  ")).toBe("hello");
  });

  it("strips creator template and context before User request", () => {
    const full = [
      "You are the widget creator template for Dartsnut.",
      "",
      "Creation context:",
      '{"projectType":"widget"}',
      "",
      "User request:",
      "make a clock"
    ].join("\n");
    expect(transcriptUserBubbleText(full)).toBe("make a clock");
  });

  it("extracts only the composer line from post-intake host instructions", () => {
    const body = [
      "Creation **intake just finished**: …",
      "Original first message (use only if it already states what to build): 给我点儿惊喜"
    ].join("\n");
    const full = [`TEMPLATE`, "", "User request:", body].join("\n");
    expect(transcriptUserBubbleText(full)).toBe("给我点儿惊喜");
  });

  it("extracts build-now post-intake user request line", () => {
    const body = [
      "Creation **intake just finished**: …",
      "**Build now (mandatory):** …",
      "User's build request (implement now): create a smoothing widget for me"
    ].join("\n");
    const full = ["TEMPLATE", "", "User request:", body].join("\n");
    expect(transcriptUserBubbleText(full)).toBe("create a smoothing widget for me");
  });

  it("returns null when post-intake block has no original message", () => {
    const body = [
      "Creation **intake just finished**: …",
      "Give a one-sentence acknowledgement…"
    ].join("\n");
    const full = ["TEMPLATE", "", "User request:", body].join("\n");
    expect(transcriptUserBubbleText(full)).toBeNull();
  });

  it("returns null for empty substantive-first-message sentinel", () => {
    expect(transcriptUserBubbleText("There was no substantive first message before intake.")).toBeNull();
  });
});
