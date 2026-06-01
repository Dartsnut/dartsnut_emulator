export const MODIFICATION_MAX_STEPS = 8;

export interface ModificationLoopSignals {
  step: number;
  toolCallCount: number;
}

export type ModificationLoopDecision =
  | { type: "continue" }
  | { type: "complete"; summary: string };

/**
 * Stop surgical modification once the step budget is spent.
 * Tool-free replies are handled by the normal SessionEngine exit path.
 */
export function decideModificationLoopStep(
  signals: ModificationLoopSignals
): ModificationLoopDecision {
  if (signals.step >= MODIFICATION_MAX_STEPS - 1 && signals.toolCallCount > 0) {
    return {
      type: "complete",
      summary: "Surgical modification pass complete (step budget reached)."
    };
  }

  return { type: "continue" };
}
