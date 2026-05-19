import { describe, expect, it } from "vitest";
import { workspaceNeedsCreationIntake } from "../src/workspaceIntake";

describe("workspaceNeedsCreationIntake", () => {
  it("is false when workspace root is null", () => {
    expect(workspaceNeedsCreationIntake(null, false)).toBe(false);
    expect(workspaceNeedsCreationIntake(null, true)).toBe(false);
  });

  it("is true when workspace exists but conf.json does not", () => {
    expect(workspaceNeedsCreationIntake("/tmp/dartsnut-chat-abc", false)).toBe(true);
  });

  it("is false when conf.json exists", () => {
    expect(workspaceNeedsCreationIntake("/tmp/dartsnut-chat-abc", true)).toBe(false);
  });
});
