import { describe, expect, it } from "vitest";
import { loadSkillBundle } from "../src/skillBundle";

describe("loadSkillBundle", () => {
  it("throws when bundle file is missing", () => {
    expect(() => loadSkillBundle("/tmp/does-not-exist-skill.md")).toThrow();
  });
});
