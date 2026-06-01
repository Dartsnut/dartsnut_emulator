import { describe, expect, it } from "vitest";
import {
  POST_INTAKE_BUILD_REQUEST_PREFIX,
  buildPostIntakeCreatorUserPrompt
} from "../src/postIntakeCreatorPrompt";

describe("buildPostIntakeCreatorUserPrompt", () => {
  it("passes through the original user request after intake", () => {
    const prompt = buildPostIntakeCreatorUserPrompt("create a smoothing widget for me", {
      forceBuildAfterIntake: true
    });
    expect(prompt).toContain("intake just finished");
    expect(prompt).toContain(POST_INTAKE_BUILD_REQUEST_PREFIX);
    expect(prompt).toContain("create a smoothing widget for me");
    expect(prompt).not.toContain("Build now");
    expect(prompt).not.toContain("pick exactly one");
    expect(prompt).not.toContain("Success criteria");
  });

  it("does not add open-ended concept picking for surprise prompts", () => {
    const prompt = buildPostIntakeCreatorUserPrompt("给我点儿惊喜", { forceBuildAfterIntake: true });
    expect(prompt).toContain("给我点儿惊喜");
    expect(prompt).not.toContain("one concrete");
    expect(prompt).not.toContain("surprise me");
  });

  it("uses the same passthrough shape when not forced after intake", () => {
    const prompt = buildPostIntakeCreatorUserPrompt("hello");
    expect(prompt).toContain("User request:");
    expect(prompt).toContain("hello");
    expect(prompt).not.toContain("Build now");
  });

  it("handles empty pre-intake user text", () => {
    const prompt = buildPostIntakeCreatorUserPrompt("   ", { forceBuildAfterIntake: true });
    expect(prompt).toContain("(none recorded before intake)");
  });
});
