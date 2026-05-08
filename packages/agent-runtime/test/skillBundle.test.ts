import { describe, expect, it } from "vitest";
import path from "node:path";
import { loadSkillBundle } from "../src/skillBundle";

describe("loadSkillBundle", () => {
  it("throws when bundle file is missing", () => {
    expect(() => loadSkillBundle("/tmp/does-not-exist-skill.md")).toThrow();
  });

  it("loads the game creator template", () => {
    const templatePath = path.resolve(__dirname, "../skills/game-creator.md");
    const content = loadSkillBundle(templatePath);
    expect(content).toContain("game creator template");
  });

  it("loads the widget creator template", () => {
    const templatePath = path.resolve(__dirname, "../skills/widget-creator.md");
    const content = loadSkillBundle(templatePath);
    expect(content).toContain("widget creator template");
    expect(content).toContain("widget size");
  });

  it("loads the dartsnut pydartsnut runtime skill", () => {
    const templatePath = path.resolve(__dirname, "../skills/dartsnut-skill.md");
    const content = loadSkillBundle(templatePath);
    expect(content).toContain("pydartsnut");
    expect(content).toContain("update_frame_buffer");
    expect(content).toContain("Strict scope");
  });
});
