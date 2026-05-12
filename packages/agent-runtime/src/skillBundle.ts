import fs from "node:fs";
import path from "node:path";

const SKILL_SEPARATOR = "\n\n---\n\n";

/** Skill documents exposed via `get_dartsnut_skill` (filenames under `skillsDir`). */
export const DEFERRED_SKILL_IDS = [
  "dartsnut-skill",
  "dartsnut-display-mapping",
  "asset-pipeline"
] as const;

export type DeferredSkillId = (typeof DEFERRED_SKILL_IDS)[number];

export const DEFERRED_SKILL_FILE: Record<DeferredSkillId, string> = {
  "dartsnut-skill": "dartsnut-skill.md",
  "dartsnut-display-mapping": "dartsnut-display-mapping.md",
  "asset-pipeline": "asset-pipeline.md"
};

const SKILL_INDEX_BLURB: Record<DeferredSkillId, string> = {
  "dartsnut-skill":
    "`pydartsnut` / `Dartsnut()`, main loop, `update_frame_buffer`, strict deps, README / Chat run steps.",
  "dartsnut-display-mapping":
    "Physical panels ↔ framebuffer merge, layout, fonts, dart-hit mapping, clipping.",
  "asset-pipeline":
    "`dartsnut.assets.json`, `assets_loader.py`, placeholders, art-bearing entities, apply mode."
};

/** Template-mode-aware bundle selectors. Superset of `PromptRequest.templateMode`. */
export type SkillBundleMode = "game-creator" | "widget-creator" | "asset-applier" | "creation-intake";

/**
 * Read one or more skill markdown files and concatenate them with a horizontal-rule separator.
 * Throws when any path is missing — skill bundles are not optional.
 */
export function loadSkillBundle(...skillFilePaths: string[]): string {
  if (skillFilePaths.length === 0) {
    throw new Error("loadSkillBundle requires at least one skill path");
  }
  const parts = skillFilePaths.map((skillFilePath) => {
    if (!fs.existsSync(skillFilePath)) {
      throw new Error(`Skill bundle is missing at ${skillFilePath}`);
    }
    return fs.readFileSync(skillFilePath, "utf-8");
  });
  return parts.join(SKILL_SEPARATOR);
}

export interface SkillBundlePaths {
  dartsnutSkill: string;
  displayMapping: string;
  assetPipeline: string;
}

export function resolveSkillBundlePaths(skillsDir: string): SkillBundlePaths {
  return {
    dartsnutSkill: path.join(skillsDir, "dartsnut-skill.md"),
    displayMapping: path.join(skillsDir, "dartsnut-display-mapping.md"),
    assetPipeline: path.join(skillsDir, "asset-pipeline.md")
  };
}

export function deferredSkillMarkdownPath(skillsDir: string, skillId: DeferredSkillId): string {
  return path.join(skillsDir, DEFERRED_SKILL_FILE[skillId]);
}

/**
 * Which deferred skills are in play for this session (mirrors {@link bundleForTemplateMode} composition).
 * `creation-intake` is listed for completeness; intake sessions use the inlined bundle instead of the tool.
 */
export function allowedDeferredSkillIdsForMode(mode?: SkillBundleMode | null): DeferredSkillId[] {
  if (mode === "asset-applier") {
    return ["dartsnut-skill", "asset-pipeline"];
  }
  if (mode === "creation-intake") {
    return ["dartsnut-skill"];
  }
  return ["dartsnut-skill", "dartsnut-display-mapping", "asset-pipeline"];
}

/**
 * Slim system prompt: router + index. Full skill text is loaded via `get_dartsnut_skill`.
 * Do not use for `creation-intake` (keep {@link bundleForTemplateMode} inlined there).
 */
export function resolveSkillRouterPrompt(
  skillsDir: string,
  mode?: SkillBundleMode | null
): string {
  const allowed = allowedDeferredSkillIdsForMode(mode);
  const indexLines = allowed.map(
    (id) => `- **${id}** (${DEFERRED_SKILL_FILE[id]}) — ${SKILL_INDEX_BLURB[id]}`
  );
  return [
    "You are the Dartsnut Chat coding agent for **games** and **widgets** on Dartsnut hardware (`pydartsnut`, `conf.json`).",
    "",
    "**Skill loading (mandatory before coding):** Do not call `write_file`, `replace_in_file`, or `copy_asset_file` until you have loaded **every** skill listed below for this session using **`get_dartsnut_skill`** (you may issue parallel tool calls). Treat returned `content` as authoritative procedure text.",
    "",
    "Skills available in this session:",
    ...indexLines,
    "",
    `Skills directory (for your reasoning only; files are read via the tool): ${skillsDir}`,
    "",
    "After skills are loaded, follow the user message and any creator template it contains. Obey the separate system message about native tool calling (no JSON/XML tool envelopes in assistant text)."
  ].join("\n");
}

export function readDeferredSkillMarkdown(skillsDir: string, skillId: DeferredSkillId): string {
  const filePath = deferredSkillMarkdownPath(skillsDir, skillId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Skill file missing: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Resolve the system-prompt skill bundle for a given template mode.
 *
 * - `asset-applier` — minimal: `dartsnut-skill` + `asset-pipeline` only.
 *   No display-mapping (apply mode does not touch layout/fonts) and no creator
 *   skills (apply mode forbids scaffolding).
 * - `creation-intake` — `dartsnut-skill` only (no file writes; host tools handle workspace setup).
 * - All other modes (game-creator, widget-creator, or unset) — full bundle:
 *   `dartsnut-skill` + `dartsnut-display-mapping` + `asset-pipeline`. Creator
 *   templates are still injected separately into the user prompt.
 */
export function bundleForTemplateMode(
  skillsDir: string,
  mode?: SkillBundleMode | null
): string {
  const paths = resolveSkillBundlePaths(skillsDir);
  if (mode === "asset-applier") {
    return loadSkillBundle(paths.dartsnutSkill, paths.assetPipeline);
  }
  if (mode === "creation-intake") {
    return loadSkillBundle(paths.dartsnutSkill);
  }
  return loadSkillBundle(paths.dartsnutSkill, paths.displayMapping, paths.assetPipeline);
}
