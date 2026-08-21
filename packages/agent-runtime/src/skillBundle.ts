import fs from "node:fs";
import path from "node:path";

export const DEFERRED_SKILL_IDS = [
  "dartsnut-core",
  "dartsnut-game",
  "dartsnut-widget",
  "dartsnut-assets"
] as const;

export type DeferredSkillId = (typeof DEFERRED_SKILL_IDS)[number];
export type SkillBundleMode = "game-creator" | "widget-creator" | "asset-applier";

const SKILL_FILE: Record<DeferredSkillId, string> = {
  "dartsnut-core": "dartsnut-core.md",
  "dartsnut-game": "dartsnut-game.md",
  "dartsnut-widget": "dartsnut-widget.md",
  "dartsnut-assets": "dartsnut-assets.md"
};

function readSkill(skillsDir: string, id: DeferredSkillId): string {
  const filePath = path.join(skillsDir, SKILL_FILE[id]);
  if (!fs.existsSync(filePath)) throw new Error(`Skill file missing: ${filePath}`);
  return fs.readFileSync(filePath, "utf-8");
}

export function loadSkillBundle(...skillFilePaths: string[]): string {
  if (skillFilePaths.length === 0) throw new Error("loadSkillBundle requires at least one skill path");
  return skillFilePaths.map((filePath) => fs.readFileSync(filePath, "utf-8")).join("\n\n---\n\n");
}

export function allowedDeferredSkillIdsForMode(mode?: SkillBundleMode | null): DeferredSkillId[] {
  if (mode === "asset-applier") return ["dartsnut-core", "dartsnut-assets"];
  return [...DEFERRED_SKILL_IDS];
}

export function resolveSkillRouterPrompt(
  skillsDir: string,
  mode?: SkillBundleMode | null
): string {
  const ids = allowedDeferredSkillIdsForMode(mode);
  return [
    "Load Dartsnut skills only when their domain is needed:",
    ...ids.map((id) => `- ${id}`),
    `Skills directory: ${skillsDir}`
  ].join("\n");
}

export function readDeferredSkillMarkdown(skillsDir: string, skillId: DeferredSkillId): string {
  return readSkill(skillsDir, skillId);
}

export function bundleForTemplateMode(
  skillsDir: string,
  mode?: SkillBundleMode | null
): string {
  return allowedDeferredSkillIdsForMode(mode).map((id) => readSkill(skillsDir, id)).join("\n\n---\n\n");
}
