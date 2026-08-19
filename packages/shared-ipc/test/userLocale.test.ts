import { describe, expect, it } from "vitest";
import { buildLanguageSystemPrompt } from "../src/userLocale";

describe("buildLanguageSystemPrompt", () => {
  it("returns concise static current-message guidance", () => {
    const prompt = buildLanguageSystemPrompt();
    expect(prompt).toBe(
      "Respond in the language used by the user in their current message when possible."
    );
    expect(prompt).not.toMatch(/locale|detect|persist|guess|zh-Hans|zh-Hant/i);
  });
});
