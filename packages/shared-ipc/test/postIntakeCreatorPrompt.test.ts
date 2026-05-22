import { describe, expect, it } from "vitest";
import {
  POST_INTAKE_BUILD_REQUEST_PREFIX,
  buildPostIntakeCreatorUserPrompt
} from "../src/postIntakeCreatorPrompt";

describe("buildPostIntakeCreatorUserPrompt", () => {
  it("instructs semantic build-now after intake for explicit English requests", () => {
    const prompt = buildPostIntakeCreatorUserPrompt("create a smoothing widget for me", {
      forceBuildAfterIntake: true
    });
    expect(prompt).toContain("**Build now (mandatory):**");
    expect(prompt).toContain("by meaning");
    expect(prompt).toContain("karpathy-guidelines");
    expect(prompt).toContain("Success criteria");
    expect(prompt).toContain("creator-incremental");
    expect(prompt).toContain(POST_INTAKE_BUILD_REQUEST_PREFIX);
    expect(prompt).toContain("create a smoothing widget for me");
    expect(prompt).not.toContain("ask what they want");
  });

  it("instructs semantic build-now for Chinese open-ended prompts after intake", () => {
    const prompt = buildPostIntakeCreatorUserPrompt("给我点儿惊喜", { forceBuildAfterIntake: true });
    expect(prompt).toContain("**Build now (mandatory):**");
    expect(prompt).toContain("给我点儿惊喜");
    expect(prompt).toContain("one concrete");
    expect(prompt).not.toContain("ask what they want");
  });

  it("mentions asset-later intent in build-now instructions", () => {
    const prompt = buildPostIntakeCreatorUserPrompt("我将提供素材", { forceBuildAfterIntake: true });
    expect(prompt).toContain("我将提供素材");
    expect(prompt).toContain("asset");
  });

  it("uses semantic interpret path when not forced after intake", () => {
    const prompt = buildPostIntakeCreatorUserPrompt("hello");
    expect(prompt).toContain("semantically");
    expect(prompt).not.toContain("**Build now (mandatory):**");
  });

  it("forces build-now for surprise me when chained after intake", () => {
    const prompt = buildPostIntakeCreatorUserPrompt("surprise me", { forceBuildAfterIntake: true });
    expect(prompt).toContain("**Build now (mandatory):**");
    expect(prompt).toContain("surprise me");
    expect(prompt).not.toContain("ask what they want");
  });
});
