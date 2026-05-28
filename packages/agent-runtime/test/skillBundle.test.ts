import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  allowedDeferredSkillIdsForMode,
  bundleForTemplateMode,
  loadSkillBundle,
  readDeferredSkillMarkdown,
  resolveSkillRouterPrompt
} from "../src/skillBundle";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

describe("loadSkillBundle", () => {
  it("throws when bundle file is missing", () => {
    expect(() => loadSkillBundle("/tmp/does-not-exist-skill.md")).toThrow();
  });

  it("loads the game creator template", () => {
    const templatePath = path.join(SKILLS_DIR, "game-creator.md");
    const content = loadSkillBundle(templatePath);
    expect(content).toContain("game creator template");
    expect(content).toContain("creator-incremental");
    expect(content).not.toContain('"id": "<game-slug>"');
  });

  it("loads the widget creator template", () => {
    const templatePath = path.join(SKILLS_DIR, "widget-creator.md");
    const content = loadSkillBundle(templatePath);
    expect(content).toContain("widget creator template");
    expect(content).toContain("widget-fonts");
    expect(content).not.toContain("load_widget_font");
  });

  it("loads pydartsnut-core runtime skill", () => {
    const content = loadSkillBundle(path.join(SKILLS_DIR, "pydartsnut-core.md"));
    expect(content).toContain("update_frame_buffer");
    expect(content).toContain("Dartsnut()");
  });

  it("loads creator-incremental scaffold constraints skill", () => {
    const content = loadSkillBundle(path.join(SKILLS_DIR, "creator-incremental.md"));
    expect(content).toContain("Success criteria");
    expect(content).toContain("paste full `conf.json`");
    expect(content).toContain("Verify run");
    expect(content).toContain("get_emulator_logs");
  });

  it("loads karpathy-guidelines skill", () => {
    const content = loadSkillBundle(path.join(SKILLS_DIR, "karpathy-guidelines.md"));
    expect(content).toContain("Goal-Driven Execution");
    expect(content).toContain("Dartsnut creator overlay");
  });

  it("loads the dartsnut display mapping skill", () => {
    const templatePath = path.join(SKILLS_DIR, "dartsnut-display-mapping.md");
    const content = loadSkillBundle(templatePath);
    expect(content).toContain("dartsnut-display-mapping");
    expect(content).toContain("128×160");
    expect(content).toContain("framebuffer merges");
  });

  it("loads the compact console design skill", () => {
    const templatePath = path.join(SKILLS_DIR, "design-console-smallform.md");
    const content = loadSkillBundle(templatePath);
    expect(content).toContain("design-console-smallform");
    expect(content).toContain("pixel-perfect");
    expect(content).toContain("console-game-favor");
  });

  it("concatenates multiple skills with a separator when given several paths", () => {
    const corePath = path.join(SKILLS_DIR, "pydartsnut-core.md");
    const displayPath = path.join(SKILLS_DIR, "dartsnut-display-mapping.md");
    const combined = loadSkillBundle(corePath, displayPath);
    expect(combined).toContain("update_frame_buffer");
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

  it("directs user image offers to Assets pane bind, not chat paste", () => {
    const content = loadSkillBundle(assetPipelinePath);
    expect(content).toContain("我来给你一个皮卡丘的图片");
    expect(content).toContain("Do not");
    expect(content).toContain("paste");
    expect(content).toContain("Assets");
    expect(content).toContain("Choose File");
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

  it("dartsnut-skill legacy index points at granular ids", () => {
    const dartsnutSkill = loadSkillBundle(path.join(SKILLS_DIR, "dartsnut-skill.md"));
    expect(dartsnutSkill).toContain("pydartsnut-core");
    expect(dartsnutSkill).toContain("karpathy-guidelines");
    expect(dartsnutSkill).toContain("creator-incremental");
    expect(dartsnutSkill).not.toMatch(/```json[\s\S]*"slots"[\s\S]*```/);
  });

  it("creator skills do NOT duplicate the loader-helper code snippet", () => {
    const gameCreator = loadSkillBundle(path.join(SKILLS_DIR, "game-creator.md"));
    const widgetCreator = loadSkillBundle(path.join(SKILLS_DIR, "widget-creator.md"));
    expect(gameCreator).not.toContain("class SlotRenderer");
    expect(widgetCreator).not.toContain("class SlotRenderer");
  });

  it("game-dart-colors holds RGB table removed from game-creator template", () => {
    const colors = loadSkillBundle(path.join(SKILLS_DIR, "game-dart-colors.md"));
    expect(colors).toContain("(255, 0, 0)");
    const gameCreator = loadSkillBundle(path.join(SKILLS_DIR, "game-creator.md"));
    expect(gameCreator).not.toContain("(255, 0, 0)");
  });
});

describe("bundleForTemplateMode", () => {
  it("includes pydartsnut-core, display-mapping, and asset-pipeline for game-creator mode", () => {
    const bundle = bundleForTemplateMode(SKILLS_DIR, "game-creator");
    expect(bundle).toContain("update_frame_buffer");
    expect(bundle).toContain("dartsnut-display-mapping");
    expect(bundle).toContain("dartsnut.assets.json");
    expect(bundle).toContain("load_slot");
  });

  it("includes pydartsnut-core, display-mapping, and asset-pipeline for widget-creator mode", () => {
    const bundle = bundleForTemplateMode(SKILLS_DIR, "widget-creator");
    expect(bundle).toContain("update_frame_buffer");
    expect(bundle).toContain("dartsnut-display-mapping");
    expect(bundle).toContain("dartsnut.assets.json");
  });

  it("includes the full bundle when no mode is specified (default behavior preserved)", () => {
    const bundle = bundleForTemplateMode(SKILLS_DIR);
    expect(bundle).toContain("update_frame_buffer");
    expect(bundle).toContain("dartsnut-display-mapping");
    expect(bundle).toContain("dartsnut.assets.json");
  });

  it("for asset-applier mode bundles only pydartsnut-core + asset-pipeline", () => {
    const bundle = bundleForTemplateMode(SKILLS_DIR, "asset-applier");
    expect(bundle).toContain("update_frame_buffer");
    expect(bundle).toContain("dartsnut.assets.json");
    expect(bundle).toContain("Apply mode");
    expect(bundle).not.toContain("Firmware coordinate note");
    expect(bundle).not.toContain("Partial-size widgets");
    expect(bundle).not.toContain("game creator template");
    expect(bundle).not.toContain("widget creator template");
  });

  it("for creation-intake mode bundles only creation-intake skill", () => {
    const bundle = bundleForTemplateMode(SKILLS_DIR, "creation-intake");
    const single = loadSkillBundle(path.join(SKILLS_DIR, "creation-intake.md"));
    expect(bundle).toBe(single);
    expect(bundle).toContain("creation intake");
    expect(bundle).not.toContain("update_frame_buffer");
  });
});

describe("deferred skill router", () => {
  it("allowedDeferredSkillIdsForMode lists creator granular skills and asset-applier subset", () => {
    expect(allowedDeferredSkillIdsForMode("asset-applier")).toEqual([
      "pydartsnut-core",
      "asset-pipeline",
      "dartsnut-skill"
    ]);
    expect(allowedDeferredSkillIdsForMode("creation-intake")).toEqual([]);
    const creatorIds = allowedDeferredSkillIdsForMode("game-creator");
    expect(creatorIds).toContain("karpathy-guidelines");
    expect(creatorIds).toContain("creator-incremental");
    expect(creatorIds).toContain("conf-contract");
    expect(creatorIds).toContain("pydartsnut-core");
    expect(creatorIds).toContain("dartsnut-display-mapping");
    expect(creatorIds).toContain("design-console-smallform");
  });

  it("resolveSkillRouterPrompt uses just-in-time loading for creators", () => {
    const router = resolveSkillRouterPrompt(SKILLS_DIR, "widget-creator");
    expect(router).toContain("just-in-time");
    expect(router).toContain("Simplified Chinese");
    expect(router).toContain("meaning");
    expect(router).toContain("我来给你一个");
    expect(router).toContain("Assets pane");
    expect(router).toContain("never ask to paste");
    expect(router).toContain("Load first");
    expect(router).toContain("creator-incremental");
    expect(router).toContain("conf-contract");
    expect(router).not.toContain("loaded **every** skill");
    expect(router).not.toContain("Agent steps");
    expect(router).toContain("karpathy-guidelines");
    expect(router).toContain("Goal-driven");
    expect(router).toContain("read_file");
    expect(router).toContain("Verify run");
    expect(router).toContain("get_emulator_logs");
    expect(router).toContain("design-console-smallform");
    expect(router).toContain("pixel-perfect polish");
  });

  it("resolveSkillRouterPrompt for asset-applier mentions pydartsnut-core", () => {
    const router = resolveSkillRouterPrompt(SKILLS_DIR, "asset-applier");
    expect(router).toContain("pydartsnut-core");
    expect(router).toContain("asset-pipeline");
    expect(router).not.toContain("dartsnut-display-mapping");
  });

  it("readDeferredSkillMarkdown expands legacy dartsnut-skill", () => {
    const body = readDeferredSkillMarkdown(SKILLS_DIR, "dartsnut-skill");
    expect(body).toContain("legacy index");
    expect(body).toContain("update_frame_buffer");
    expect(body).toContain("get_dart_hits");
  });

  it("readDeferredSkillMarkdown returns conf-contract body", () => {
    const body = readDeferredSkillMarkdown(SKILLS_DIR, "conf-contract");
    expect(body).toContain("conf.json contract");
    expect(body).toContain("reload_emulator");
    expect(body).toContain("get_emulator_logs");
  });
});

describe("AGENT_TOOL_SCHEMAS", () => {
  it("includes intake question and emulator verification tools", async () => {
    const { AGENT_TOOL_SCHEMAS } = await import("../src/toolSchemas");
    const names = AGENT_TOOL_SCHEMAS.map((t) =>
      t.type === "function" ? t.function.name : ""
    );
    expect(names).toContain("dartsnut_ask_question");
    expect(names).toContain("get_emulator_logs");
    expect(names).toContain("reload_emulator");
  });
});
