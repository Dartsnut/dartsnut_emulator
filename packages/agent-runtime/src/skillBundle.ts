import fs from "node:fs";
import path from "node:path";

const SKILL_SEPARATOR = "\n\n---\n\n";

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
