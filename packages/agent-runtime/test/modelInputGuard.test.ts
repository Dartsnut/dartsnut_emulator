import { describe, expect, it } from "vitest";
import type { CallModelInputFilter } from "@openai/agents";
import {
  createSafeCallModelInputFilter,
  EMPTY_MODEL_RESPONSE_MESSAGE
} from "../src/modelInputGuard";

describe("modelInputGuard", () => {
  it("reports repeated-input structure without input content", () => {
    const diagnostics: unknown[] = [];
    const filter = createSafeCallModelInputFilter((diagnostic) => diagnostics.push(diagnostic));
    const args = {
      modelData: {
        input: [{ role: "user", content: "private prompt" }],
        instructions: "private instructions"
      },
      agent: {},
      context: undefined
    } as unknown as Parameters<CallModelInputFilter>[0];

    filter(args);
    expect(() => filter(args)).toThrow(EMPTY_MODEL_RESPONSE_MESSAGE);
    expect(diagnostics).toEqual([{ inputItems: 1, instructionsChars: 20 }]);
    expect(JSON.stringify(diagnostics)).not.toContain("private");
  });
});
