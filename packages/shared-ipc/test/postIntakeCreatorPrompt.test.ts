import { describe, expect, it } from "vitest";
import {
  POST_INTAKE_BUILD_REQUEST_PREFIX,
  buildPostIntakeCreatorUserPrompt,
  postIntakeCreatorStatesBuildIntent
} from "../src/postIntakeCreatorPrompt";

describe("postIntakeCreatorStatesBuildIntent", () => {
  it("returns true for explicit widget requests", () => {
    expect(postIntakeCreatorStatesBuildIntent("create a smoothing widget for me")).toBe(true);
    expect(postIntakeCreatorStatesBuildIntent("Trajectory smoothing")).toBe(true);
    expect(postIntakeCreatorStatesBuildIntent("make a clock widget")).toBe(true);
  });

  it("returns false for vague greetings", () => {
    expect(postIntakeCreatorStatesBuildIntent("hello")).toBe(false);
    expect(postIntakeCreatorStatesBuildIntent("hi!")).toBe(false);
    expect(postIntakeCreatorStatesBuildIntent("")).toBe(false);
  });
});

describe("buildPostIntakeCreatorUserPrompt", () => {
  it("instructs build-now when intent is clear", () => {
    const prompt = buildPostIntakeCreatorUserPrompt("create a smoothing widget for me");
    expect(prompt).toContain("**Build now (mandatory):**");
    expect(prompt).toContain(POST_INTAKE_BUILD_REQUEST_PREFIX);
    expect(prompt).toContain("create a smoothing widget for me");
    expect(prompt).not.toContain("ask what they want");
  });

  it("instructs ask-first when intent is vague", () => {
    const prompt = buildPostIntakeCreatorUserPrompt("hello");
    expect(prompt).toContain("ask what they want");
    expect(prompt).not.toContain("**Build now (mandatory):**");
  });

  it("forces build-now after intake when type/size were already chosen", () => {
    const prompt = buildPostIntakeCreatorUserPrompt("surprise me", { forceBuildAfterIntake: true });
    expect(prompt).toContain("**Build now (mandatory):**");
    expect(prompt).toContain("same concept");
    expect(prompt).toContain("do not re-interpret");
    expect(prompt).not.toContain(POST_INTAKE_BUILD_REQUEST_PREFIX);
    expect(prompt).not.toContain("ask what they want");
  });
});
