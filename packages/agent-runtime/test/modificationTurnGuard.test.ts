import { describe, expect, it } from "vitest";
import {
  decideModificationLoopStep,
  MODIFICATION_MAX_STEPS
} from "../src/modificationTurnGuard";

describe("decideModificationLoopStep", () => {
  it("continues while under the step budget with pending tools", () => {
    const decision = decideModificationLoopStep({
      step: 2,
      toolCallCount: 1
    });
    expect(decision.type).toBe("continue");
  });

  it("completes on the last allowed step when tools are still pending", () => {
    const decision = decideModificationLoopStep({
      step: MODIFICATION_MAX_STEPS - 1,
      toolCallCount: 2
    });
    expect(decision).toMatchObject({
      type: "complete",
      summary: expect.stringContaining("step budget")
    });
  });
});
