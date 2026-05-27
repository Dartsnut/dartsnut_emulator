export function isCreatorTemplateMode(mode: string | null | undefined): boolean {
  return mode === "game-creator" || mode === "widget-creator";
}

export function isFileMutationToolName(name: string): boolean {
  return name === "write_file" || name === "replace_in_file" || name === "copy_asset_file";
}

export function readCreatorArtifactStatus(
  existsSync: (absolutePath: string) => boolean,
  resolveWithinRoot: (relativePath: string) => string
): { confJson: boolean; mainPy: boolean } {
  try {
    return {
      confJson: existsSync(resolveWithinRoot("conf.json")),
      mainPy: existsSync(resolveWithinRoot("main.py"))
    };
  } catch {
    return { confJson: false, mainPy: false };
  }
}

/** Combined assistant prose (content + reasoning) with no native tools before artifacts exist. */
export const CREATOR_PROSE_ONLY_STALL_CHARS = 8_000;

/** @deprecated Use CREATOR_PROSE_ONLY_STALL_CHARS — kept for tests referencing the old name. */
export const CREATOR_REASONING_ONLY_STALL_CHARS = CREATOR_PROSE_ONLY_STALL_CHARS;

/** After both artifacts exist, end if the model only verifies for this many tool rounds. */
export const CREATOR_MAX_VERIFY_STEPS_AFTER_ARTIFACTS = 6;

export interface CreatorLoopSignals {
  step: number;
  toolCallCount: number;
  /** Visible assistant message text (excludes stripped XML tool blocks). */
  contentChars: number;
  reasoningChars: number;
  filesWrittenThisTurn: number;
  workspaceHasConfJson: boolean;
  workspaceHasMainPy: boolean;
  toolNames: string[];
}

/** Creator tool-loop rounds before failing when conf.json and main.py are not both present. */
export const CREATOR_MAX_STEPS_WITHOUT_ARTIFACTS = 10;

/** @deprecated Use CREATOR_MAX_STEPS_WITHOUT_ARTIFACTS */
export const CREATOR_MAX_STEPS_WITHOUT_CONF = CREATOR_MAX_STEPS_WITHOUT_ARTIFACTS;

export type CreatorLoopDecision =
  | { type: "continue" }
  | { type: "complete"; summary: string }
  | { type: "stall_turn"; reason: string; nudgeUser: string }
  | { type: "fail"; reason: string; message: string };

function isVerificationOnlyTool(name: string): boolean {
  return (
    name === "read_file" ||
    name === "get_emulator_logs" ||
    name === "get_dartsnut_skill" ||
    name === "list_files" ||
    name === "reload_emulator"
  );
}

/**
 * Decide whether to end the creator tool loop early or nudge the model out of a stall.
 */
export function decideCreatorLoopStep(
  signals: CreatorLoopSignals,
  verifyStepsSinceArtifactsReady: number,
  stepsWithoutConfJson = 0
): CreatorLoopDecision {
  const artifactsReady = signals.workspaceHasConfJson && signals.workspaceHasMainPy;

  if (
    !artifactsReady &&
    stepsWithoutConfJson >= CREATOR_MAX_STEPS_WITHOUT_ARTIFACTS
  ) {
    return {
      type: "fail",
      reason: "artifacts_missing_after_step_budget",
      message: `Creator did not produce conf.json and main.py within ${CREATOR_MAX_STEPS_WITHOUT_ARTIFACTS} tool-loop steps.`
    };
  }

  if (artifactsReady && signals.toolCallCount === 0) {
    return {
      type: "complete",
      summary:
        signals.reasoningChars > 0
          ? "Widget scaffold is ready in the workspace."
          : "Widget scaffold is ready in the workspace."
    };
  }

  const proseChars = signals.contentChars + signals.reasoningChars;
  if (
    !artifactsReady &&
    signals.toolCallCount === 0 &&
    proseChars >= CREATOR_PROSE_ONLY_STALL_CHARS
  ) {
    return {
      type: "stall_turn",
      reason: "prose_only_without_tools",
      nudgeUser:
        "Stop extended prose. Use file tools now: write conf.json and main.py, then reload_emulator and get_emulator_logs."
    };
  }

  if (artifactsReady && signals.toolCallCount > 0) {
    const onlyVerification = signals.toolNames.every((name) => isVerificationOnlyTool(name));
    if (
      onlyVerification &&
      verifyStepsSinceArtifactsReady >= CREATOR_MAX_VERIFY_STEPS_AFTER_ARTIFACTS
    ) {
      return {
        type: "complete",
        summary: "Widget files are in place; ending after verification tool rounds."
      };
    }
  }

  return { type: "continue" };
}
