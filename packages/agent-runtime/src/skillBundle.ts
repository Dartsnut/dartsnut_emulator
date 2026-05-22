import fs from "node:fs";
import path from "node:path";

const SKILL_SEPARATOR = "\n\n---\n\n";

/** Granular + legacy skill documents exposed via `get_dartsnut_skill`. */
export const DEFERRED_SKILL_IDS = [
  "karpathy-guidelines",
  "creator-incremental",
  "conf-contract",
  "pydartsnut-core",
  "pydartsnut-game-io",
  "pydartsnut-widget-loop",
  "widget-fonts",
  "game-dart-colors",
  "dartsnut-display-mapping",
  "asset-pipeline",
  "dartsnut-skill"
] as const;

export type DeferredSkillId = (typeof DEFERRED_SKILL_IDS)[number];

export const DEFERRED_SKILL_FILE: Record<DeferredSkillId, string> = {
  "karpathy-guidelines": "karpathy-guidelines.md",
  "creator-incremental": "creator-incremental.md",
  "conf-contract": "conf-contract.md",
  "pydartsnut-core": "pydartsnut-core.md",
  "pydartsnut-game-io": "pydartsnut-game-io.md",
  "pydartsnut-widget-loop": "pydartsnut-widget-loop.md",
  "widget-fonts": "widget-fonts.md",
  "game-dart-colors": "game-dart-colors.md",
  "dartsnut-display-mapping": "dartsnut-display-mapping.md",
  "asset-pipeline": "asset-pipeline.md",
  "dartsnut-skill": "dartsnut-skill.md"
};

const SKILL_INDEX_BLURB: Record<DeferredSkillId, string> = {
  "karpathy-guidelines":
    "Goal-driven execution, simplicity, surgical edits; brief plan + verify checks; tool-first creator turns.",
  "creator-incremental":
    "Dartsnut scaffold constraints (conf → stub → iterate); verify run; anti-prose duplication.",
  "conf-contract": "Root `conf.json` keys, defaults, size, `reload_emulator` after changes.",
  "pydartsnut-core":
    "`Dartsnut()`, loop guard, `update_frame_buffer`, deps boundary, Chat Start/Reload/Logs.",
  "pydartsnut-game-io": "Game pygame loop, `get_dart_hits` / `get_button_events`, forbidden APIs.",
  "pydartsnut-widget-loop": "Widget PIL loop, `widget_params`, no pygame.",
  "widget-fonts": "`availableWidgetFonts` (file + glyph size), `copy_asset_file` → `./fonts/`.",
  "game-dart-colors": "Dart index % 4 color map and RGB table for game UI.",
  "dartsnut-display-mapping":
    "Physical panels ↔ framebuffer merge, layout, fonts on canvas, clipping.",
  "asset-pipeline":
    "`dartsnut.assets.json`, `assets_loader.py`, placeholders, art-bearing entities, apply mode.",
  "dartsnut-skill": "Legacy index — prefer granular ids above; expands to core + game + widget loops when loaded."
};

/** Legacy id `dartsnut-skill` returns concatenated granular bodies (for asset-applier and old sessions). */
const LEGACY_SKILL_EXPANSION: Partial<Record<DeferredSkillId, readonly DeferredSkillId[]>> = {
  "dartsnut-skill": ["pydartsnut-core", "pydartsnut-game-io", "pydartsnut-widget-loop"]
};

const CREATOR_ALWAYS_LOAD: readonly DeferredSkillId[] = [
  "karpathy-guidelines",
  "creator-incremental",
  "conf-contract",
  "pydartsnut-core"
];

const CREATOR_OPTIONAL_SKILLS: readonly DeferredSkillId[] = [
  "pydartsnut-game-io",
  "pydartsnut-widget-loop",
  "widget-fonts",
  "game-dart-colors",
  "dartsnut-display-mapping",
  "asset-pipeline",
  "dartsnut-skill"
];

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
  creationIntake: string;
  pydartsnutCore: string;
}

export function resolveSkillBundlePaths(skillsDir: string): SkillBundlePaths {
  return {
    dartsnutSkill: path.join(skillsDir, "dartsnut-skill.md"),
    displayMapping: path.join(skillsDir, "dartsnut-display-mapping.md"),
    assetPipeline: path.join(skillsDir, "asset-pipeline.md"),
    creationIntake: path.join(skillsDir, "creation-intake.md"),
    pydartsnutCore: path.join(skillsDir, "pydartsnut-core.md")
  };
}

export function deferredSkillMarkdownPath(skillsDir: string, skillId: DeferredSkillId): string {
  return path.join(skillsDir, DEFERRED_SKILL_FILE[skillId]);
}

function readSkillFile(skillsDir: string, skillId: DeferredSkillId): string {
  const filePath = deferredSkillMarkdownPath(skillsDir, skillId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Skill file missing: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Which deferred skills are in play for this session (mirrors {@link bundleForTemplateMode} composition).
 * `creation-intake` is listed for completeness; intake sessions use the inlined bundle instead of the tool.
 */
export function allowedDeferredSkillIdsForMode(mode?: SkillBundleMode | null): DeferredSkillId[] {
  if (mode === "asset-applier") {
    return ["pydartsnut-core", "asset-pipeline", "dartsnut-skill"];
  }
  if (mode === "creation-intake") {
    return [];
  }
  return [...CREATOR_ALWAYS_LOAD, ...CREATOR_OPTIONAL_SKILLS];
}

function formatSkillIndexLines(allowed: readonly DeferredSkillId[]): string[] {
  return allowed.map((id) => `- **${id}** (${DEFERRED_SKILL_FILE[id]}) — ${SKILL_INDEX_BLURB[id]}`);
}

function formatCreatorRouterBody(skillsDir: string, allowed: readonly DeferredSkillId[]): string[] {
  const always = CREATOR_ALWAYS_LOAD.filter((id) => allowed.includes(id));
  const optional = CREATOR_OPTIONAL_SKILLS.filter((id) => allowed.includes(id));
  return [
    "You are the Dartsnut Chat coding agent for **games** and **widgets** on Dartsnut hardware (`pydartsnut`, `conf.json`).",
    "",
    "**Skill loading (just-in-time):** Use **`get_dartsnut_skill`** before the step that needs it. Follow host **Success criteria** in the user prompt when present.",
    "",
    "**Goal-driven execution:** Load **`karpathy-guidelines`** and plan with brief steps + verify checks (optional ≤5 lines in assistant text when non-trivial). Otherwise go **tool-first** — minimal chat, no mandatory Agent-steps lists or phase announcements.",
    "",
    "**Editing:** `read_file` workspace files before edits. You decide batch size; prefer smaller hunks when risk is high. Do not end creator work with only prose when files still need changes.",
    "",
    "**Verify run:** After material `conf.json` / `main.py` changes or before declaring done → `reload_emulator` then `get_emulator_logs`. Fix Traceback / SyntaxError before continuing.",
    "",
    "**Load first** (parallel `get_dartsnut_skill` calls OK) before scaffolding files:",
    ...always.map((id) => `- **${id}**`),
    "",
    "**Load before use** (only when that step applies):",
    ...optional.map((id) => `- **${id}** — ${SKILL_INDEX_BLURB[id]}`),
    "",
    `Skills directory (reasoning only; read via tool): ${skillsDir}`,
    "",
    "After skill results return, **continue the same concept** toward Success criteria — do not re-brainstorm a different project. Do not paste full file bodies in assistant text or in thinking; write with tools. Obey the separate system message about native tool calling (no JSON/XML tool envelopes in assistant text)."
  ];
}

function formatAssetApplierRouterBody(skillsDir: string, allowed: readonly DeferredSkillId[]): string[] {
  return [
    "You are the Dartsnut **asset apply** agent (bind user art to existing slots).",
    "",
    "**Skill loading:** Load **`pydartsnut-core`** and **`asset-pipeline`** with **`get_dartsnut_skill`** before editing files. Do not scaffold new projects.",
    "",
    "Skills available in this session:",
    ...formatSkillIndexLines(allowed),
    "",
    `Skills directory: ${skillsDir}`
  ];
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
  if (mode === "asset-applier") {
    return formatAssetApplierRouterBody(skillsDir, allowed).join("\n");
  }
  return formatCreatorRouterBody(skillsDir, allowed).join("\n");
}

export function readDeferredSkillMarkdown(skillsDir: string, skillId: DeferredSkillId): string {
  const expansion = LEGACY_SKILL_EXPANSION[skillId];
  if (expansion) {
    const header = readSkillFile(skillsDir, skillId);
    const bodies = expansion.map((id) => readSkillFile(skillsDir, id));
    return [header, ...bodies].join(SKILL_SEPARATOR);
  }
  return readSkillFile(skillsDir, skillId);
}

/**
 * Resolve the system-prompt skill bundle for a given template mode.
 *
 * - `asset-applier` — minimal: `pydartsnut-core` + `asset-pipeline`.
 * - `creation-intake` — intake-only skill (no file writes; host tools handle workspace setup).
 * - Tests / legacy full bundle — concatenates core + display + asset files.
 */
export function bundleForTemplateMode(
  skillsDir: string,
  mode?: SkillBundleMode | null
): string {
  const paths = resolveSkillBundlePaths(skillsDir);
  if (mode === "asset-applier") {
    return loadSkillBundle(paths.pydartsnutCore, paths.assetPipeline);
  }
  if (mode === "creation-intake") {
    return loadSkillBundle(paths.creationIntake);
  }
  return loadSkillBundle(paths.pydartsnutCore, paths.displayMapping, paths.assetPipeline);
}
