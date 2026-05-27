import { describe, expect, it } from "vitest";
import {
  CREATOR_MAX_STEPS_WITHOUT_ARTIFACTS,
  CREATOR_MAX_VERIFY_STEPS_AFTER_ARTIFACTS,
  CREATOR_PROSE_ONLY_STALL_CHARS,
  decideCreatorLoopStep,
  isCreatorTemplateMode,
  isFileMutationToolName,
  readCreatorArtifactStatus
} from "../src/creatorTurnGuard";

describe("readCreatorArtifactStatus", () => {
  it("reports conf and main presence from existsSync", () => {
    const exists = new Set(["/ws/conf.json", "/ws/main.py"]);
    const status = readCreatorArtifactStatus(
      (p) => exists.has(p),
      (rel) => `/ws/${rel}`
    );
    expect(status).toEqual({ confJson: true, mainPy: true });
  });

  it("returns false when paths are missing", () => {
    const status = readCreatorArtifactStatus(
      () => false,
      (rel) => `/ws/${rel}`
    );
    expect(status).toEqual({ confJson: false, mainPy: false });
  });
});

describe("isCreatorTemplateMode", () => {
  it("is true for creator modes only", () => {
    expect(isCreatorTemplateMode("widget-creator")).toBe(true);
    expect(isCreatorTemplateMode("game-creator")).toBe(true);
    expect(isCreatorTemplateMode("asset-applier")).toBe(false);
    expect(isCreatorTemplateMode(null)).toBe(false);
  });
});

describe("decideCreatorLoopStep", () => {
  it("completes when artifacts exist and the model returns no tools", () => {
    const decision = decideCreatorLoopStep(
      {
        step: 5,
        toolCallCount: 0,
        contentChars: 0,
        reasoningChars: 100,
        filesWrittenThisTurn: 0,
        workspaceHasConfJson: true,
        workspaceHasMainPy: true,
        toolNames: []
      },
      0
    );
    expect(decision.type).toBe("complete");
  });

  it("nudges on prose-only stall before artifacts exist", () => {
    const decision = decideCreatorLoopStep(
      {
        step: 2,
        toolCallCount: 0,
        contentChars: CREATOR_PROSE_ONLY_STALL_CHARS,
        reasoningChars: 0,
        filesWrittenThisTurn: 0,
        workspaceHasConfJson: false,
        workspaceHasMainPy: false,
        toolNames: []
      },
      0
    );
    expect(decision).toMatchObject({ type: "stall_turn", reason: "prose_only_without_tools" });
  });

  it("fails when artifacts are still missing after the step budget", () => {
    const decision = decideCreatorLoopStep(
      {
        step: 11,
        toolCallCount: 0,
        contentChars: 100,
        reasoningChars: 0,
        filesWrittenThisTurn: 0,
        workspaceHasConfJson: true,
        workspaceHasMainPy: false,
        toolNames: []
      },
      0,
      CREATOR_MAX_STEPS_WITHOUT_ARTIFACTS
    );
    expect(decision).toMatchObject({
      type: "fail",
      reason: "artifacts_missing_after_step_budget"
    });
  });

  it("completes after repeated verification-only tool rounds", () => {
    const decision = decideCreatorLoopStep(
      {
        step: 20,
        toolCallCount: 2,
        contentChars: 0,
        reasoningChars: 0,
        filesWrittenThisTurn: 0,
        workspaceHasConfJson: true,
        workspaceHasMainPy: true,
        toolNames: ["read_file", "get_emulator_logs"]
      },
      CREATOR_MAX_VERIFY_STEPS_AFTER_ARTIFACTS
    );
    expect(decision.type).toBe("complete");
  });
});

describe("isFileMutationToolName", () => {
  it("includes write, replace, and copy asset tools", () => {
    expect(isFileMutationToolName("write_file")).toBe(true);
    expect(isFileMutationToolName("replace_in_file")).toBe(true);
    expect(isFileMutationToolName("copy_asset_file")).toBe(true);
    expect(isFileMutationToolName("read_file")).toBe(false);
  });
});
