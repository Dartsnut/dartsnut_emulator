import { describe, expect, it } from "vitest";
import path from "node:path";
import { bundleForTemplateMode, loadSkillBundle } from "../src/skillBundle";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

describe("loadSkillBundle", () => {
  it("throws when bundle file is missing", () => {
    expect(() => loadSkillBundle("/tmp/does-not-exist-skill.md")).toThrow();
  });

  it("loads the game creator template", () => {
    const templatePath = path.join(SKILLS_DIR, "game-creator.md");
    const content = loadSkillBundle(templatePath);
    expect(content).toContain("game creator template");
  });

  it("loads the widget creator template", () => {
    const templatePath = path.join(SKILLS_DIR, "widget-creator.md");
    const content = loadSkillBundle(templatePath);
    expect(content).toContain("widget creator template");
    expect(content).toContain("widget size");
  });

  it("loads the dartsnut pydartsnut runtime skill", () => {
    const templatePath = path.join(SKILLS_DIR, "dartsnut-skill.md");
    const content = loadSkillBundle(templatePath);
    expect(content).toContain("pydartsnut");
    expect(content).toContain("update_frame_buffer");
    expect(content).toContain("Strict scope");
  });

  it("loads the dartsnut display mapping skill", () => {
    const templatePath = path.join(SKILLS_DIR, "dartsnut-display-mapping.md");
    const content = loadSkillBundle(templatePath);
    expect(content).toContain("dartsnut-display-mapping");
    expect(content).toContain("128×160");
    expect(content).toContain("framebuffer merges");
  });

  it("concatenates multiple skills with a separator when given several paths", () => {
    const corePath = path.join(SKILLS_DIR, "dartsnut-skill.md");
    const displayPath = path.join(SKILLS_DIR, "dartsnut-display-mapping.md");
    const combined = loadSkillBundle(corePath, displayPath);
    expect(combined).toContain("pydartsnut");
    expect(combined).toContain("dartsnut-display-mapping");
    expect(combined).toContain("\n\n---\n\n");
  });
});

describe("asset-pipeline skill", () => {
  const assetPipelinePath = path.join(SKILLS_DIR, "asset-pipeline.md");

  it("declares the manifest schema and loader interface", () => {
    const content = loadSkillBundle(assetPipelinePath);
    expect(content).toContain("dartsnut.assets.json");
    expect(content).toContain("assets_loader.py");
    expect(content).toContain("load_slot");
    expect(content).toContain("SlotRenderer");
    expect(content).toContain("frame_count");
    expect(content).toContain("frame_duration_ms");
  });

  it("documents both pygame and Pillow backends", () => {
    const content = loadSkillBundle(assetPipelinePath);
    expect(content).toContain("pygame");
    expect(content).toContain("Pillow");
    expect(content).toContain("ImageDraw");
    expect(content).toContain("never import `pygame`");
  });

  it("declares apply-mode constraints", () => {
    const content = loadSkillBundle(assetPipelinePath);
    expect(content).toContain("Apply mode");
    expect(content).toMatch(/forbidden|Forbidden/);
    expect(content).toContain("scaffold");
  });
});

describe("creator skills reference asset-pipeline without duplicating rules", () => {
  it("game-creator references asset-pipeline", () => {
    const gameCreator = loadSkillBundle(path.join(SKILLS_DIR, "game-creator.md"));
    expect(gameCreator).toContain("asset-pipeline");
    expect(gameCreator).toContain("dartsnut.assets.json");
    expect(gameCreator).toContain("assets_loader.py");
  });

  it("widget-creator references asset-pipeline", () => {
    const widgetCreator = loadSkillBundle(path.join(SKILLS_DIR, "widget-creator.md"));
    expect(widgetCreator).toContain("asset-pipeline");
    expect(widgetCreator).toContain("dartsnut.assets.json");
    expect(widgetCreator).toContain("assets_loader.py");
  });

  it("dartsnut-skill cross-references asset-pipeline without restating its rules", () => {
    const dartsnutSkill = loadSkillBundle(path.join(SKILLS_DIR, "dartsnut-skill.md"));
    expect(dartsnutSkill).toContain("asset-pipeline");
    expect(dartsnutSkill).not.toMatch(/```json[\s\S]*"slots"[\s\S]*```/);
  });

  it("creator skills do NOT duplicate the loader-helper code snippet", () => {
    const gameCreator = loadSkillBundle(path.join(SKILLS_DIR, "game-creator.md"));
    const widgetCreator = loadSkillBundle(path.join(SKILLS_DIR, "widget-creator.md"));
    expect(gameCreator).not.toContain("class SlotRenderer");
    expect(widgetCreator).not.toContain("class SlotRenderer");
  });
});

describe("bundleForTemplateMode", () => {
  it("includes dartsnut-skill, display-mapping, and asset-pipeline for game-creator mode", () => {
    const bundle = bundleForTemplateMode(SKILLS_DIR, "game-creator");
    expect(bundle).toContain("pydartsnut");
    expect(bundle).toContain("dartsnut-display-mapping");
    expect(bundle).toContain("dartsnut.assets.json");
    expect(bundle).toContain("load_slot");
  });

  it("includes dartsnut-skill, display-mapping, and asset-pipeline for widget-creator mode", () => {
    const bundle = bundleForTemplateMode(SKILLS_DIR, "widget-creator");
    expect(bundle).toContain("pydartsnut");
    expect(bundle).toContain("dartsnut-display-mapping");
    expect(bundle).toContain("dartsnut.assets.json");
  });

  it("includes the full bundle when no mode is specified (default behavior preserved)", () => {
    const bundle = bundleForTemplateMode(SKILLS_DIR);
    expect(bundle).toContain("pydartsnut");
    expect(bundle).toContain("dartsnut-display-mapping");
    expect(bundle).toContain("dartsnut.assets.json");
  });

  it("for asset-applier mode bundles only dartsnut-skill + asset-pipeline (no display-mapping, no creator skills)", () => {
    const bundle = bundleForTemplateMode(SKILLS_DIR, "asset-applier");
    expect(bundle).toContain("pydartsnut");
    expect(bundle).toContain("dartsnut.assets.json");
    expect(bundle).toContain("Apply mode");
    expect(bundle).not.toContain("Firmware coordinate note");
    expect(bundle).not.toContain("Partial-size widgets");
    expect(bundle).not.toContain("game creator template");
    expect(bundle).not.toContain("widget creator template");
  });
});
