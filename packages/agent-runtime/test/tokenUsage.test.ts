import { describe, expect, it } from "vitest";
import { normalizeTokenUsage } from "../src/tokenUsage";

describe("normalizeTokenUsage", () => {
  it("normalizes OpenAI response usage fields", () => {
    expect(
      normalizeTokenUsage({
        input_tokens: 33,
        output_tokens: 7,
        total_tokens: 40
      })
    ).toEqual({ inputTokens: 33, outputTokens: 7, totalTokens: 40 });
  });

  it("fills total when only input and output are present", () => {
    expect(
      normalizeTokenUsage({
        input_tokens: 4,
        output_tokens: 6
      })
    ).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
  });

  it("ignores malformed and all-zero usage objects", () => {
    expect(normalizeTokenUsage({ input_tokens: -1, output_tokens: 2 })).toBeNull();
    expect(normalizeTokenUsage({ input_tokens: "5", output_tokens: 2 })).toBeNull();
    expect(normalizeTokenUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })).toBeNull();
    expect(normalizeTokenUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })).toBeNull();
    expect(normalizeTokenUsage(null)).toBeNull();
  });
});
