import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFERRED_SKILL_IDS,
  allowedDeferredSkillIdsForMode,
  bundleForTemplateMode,
  loadSkillBundle,
  readDeferredSkillMarkdown,
  resolveSkillRouterPrompt
} from "../src/skillBundle";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

describe("consolidated skills", () => {
  it("exposes exactly four source skills", () => {
    expect(DEFERRED_SKILL_IDS).toEqual([
      "dartsnut-core",
      "dartsnut-game",
      "dartsnut-widget",
      "dartsnut-assets"
    ]);
    expect(fs.readdirSync(SKILLS_DIR).filter((file) => file.endsWith(".md")).sort()).toEqual(
      DEFERRED_SKILL_IDS.map((id) => `${id}.md`).sort()
    );
  });

  it("keeps essential runtime and config contracts in core", () => {
    const body = readDeferredSkillMarkdown(SKILLS_DIR, "dartsnut-core");
    expect(body).toContain("`conf.json` is required only for widgets");
    expect(body).toContain("only required top-level sections are `fields` and `size`");
    expect(body).toContain("New games need `main.py` and `pyproject.toml`");
    expect(body).not.toContain("Required keys: `id`, `type`, `name`, `author`, `version`, `description`");
    expect(body).not.toContain('New projects include `"preview": [""]`');
    expect(body).toContain("np.transpose");
    expect(body).toContain("observe_emulator");
    for (const type of ["text", "slider", "dropdown", "checkbox", "location", "image"]) {
      expect(body).toContain(`\`${type}\``);
    }
  });

  it("keeps exact game input APIs and colors", () => {
    const body = readDeferredSkillMarkdown(SKILLS_DIR, "dartsnut-game");
    expect(body).toContain("get_dart_hits()");
    expect(body).toContain("get_button_events()");
    expect(body).toContain("button_events.get(\"btn_a\")");
    expect(body).toContain("A`, `B`, `UP`, `DOWN`, `LEFT`, `RIGHT");
    expect(body).toContain("(255,0,0)");
  });

  it("keeps widget params and font contracts", () => {
    const body = readDeferredSkillMarkdown(SKILLS_DIR, "dartsnut-widget");
    expect(body).toContain("dartsnut.widget_params");
    expect(body).toContain("availableWidgetFonts");
    expect(body).toContain("never import `pygame`");
  });

  it("keeps manifest, loader, and apply-mode contracts", () => {
    const body = readDeferredSkillMarkdown(SKILLS_DIR, "dartsnut-assets");
    expect(body).toContain("dartsnut.assets.json");
    expect(body).toContain("assets_loader.py");
    expect(body).toContain("SlotRenderer.draw");
    expect(body).toContain("Apply mode");
    expect(body).toContain("Assets pane");
  });

  it("concatenates requested files", () => {
    const body = loadSkillBundle(
      path.join(SKILLS_DIR, "dartsnut-core.md"),
      path.join(SKILLS_DIR, "dartsnut-game.md")
    );
    expect(body).toContain("\n\n---\n\n");
  });
});

describe("skill routing", () => {
  it("offers all domains to creators and only core/assets to apply mode", () => {
    expect(allowedDeferredSkillIdsForMode("game-creator")).toEqual([...DEFERRED_SKILL_IDS]);
    expect(allowedDeferredSkillIdsForMode("widget-creator")).toEqual([...DEFERRED_SKILL_IDS]);
    expect(allowedDeferredSkillIdsForMode("asset-applier")).toEqual([
      "dartsnut-core",
      "dartsnut-assets"
    ]);
  });

  it("uses a compact router", () => {
    const router = resolveSkillRouterPrompt(SKILLS_DIR, "widget-creator");
    expect(router).toContain("dartsnut-core");
    expect(router).toContain("dartsnut-widget");
    expect(router).not.toContain("caveman");
    expect(router.split("\n").length).toBeLessThan(10);
  });

  it("bundles only core and assets for apply mode", () => {
    const bundle = bundleForTemplateMode(SKILLS_DIR, "asset-applier");
    expect(bundle).toContain("Dartsnut core");
    expect(bundle).toContain("Dartsnut assets");
    expect(bundle).not.toContain("# Dartsnut game\n");
    expect(bundle).not.toContain("# Dartsnut widget\n");
  });
});

describe("tool surface", () => {
  it("keeps emulator tools and removes intake tools", async () => {
    const { AGENT_TOOL_SCHEMAS } = await import("../src/toolSchemas");
    const names = AGENT_TOOL_SCHEMAS.map((tool) => tool.name);
    expect(names).toContain("get_emulator_logs");
    expect(names).toContain("reload_emulator");
    expect(names).toContain("copy_chat_attachment");
  });
});
