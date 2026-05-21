import type { ProjectType, WidgetSize } from "./contracts";

export type CreatorBuildPlanTemplateMode = "game-creator" | "widget-creator";

export interface FormatCreatorBuildPlanOptions {
  templateMode: CreatorBuildPlanTemplateMode;
  projectType: ProjectType;
  widgetSize?: WidgetSize;
}

/**
 * Markdown checklist injected into creator prompts (visible in chat transcript).
 */
export function formatCreatorBuildPlanMessage(options: FormatCreatorBuildPlanOptions): string {
  const { templateMode, projectType, widgetSize } = options;
  const kind = projectType === "widget" ? "widget" : "game";
  const sizeLine =
    projectType === "widget" && widgetSize
      ? `Display size: **${widgetSize}** (must match \`conf.json\` \`size\`).`
      : templateMode === "game-creator"
        ? "Default game size **[128, 160]** unless Creation context overrides."
        : "";

  const lines = [
    "## Build guidelines (milestones — expand into your own steps)",
    "",
    "These five phases are **guidelines only**, not your full execution plan.",
    "",
    "**Before phase 1 tools:** In the **assistant message** (visible in chat), post an **Agent steps** section: **5–12 numbered bullets** for what you will do next, derived from the user request and Creation context. **No code fences** in that message.",
    "",
    "**After each phase:** One short line in the assistant message marking the phase done, then start the next tool round. Do not re-brainstorm or rewrite the whole plan.",
    "",
    "Skill loading and tool rules live in the system router and `creator-incremental` — not repeated here.",
    "",
    `- [ ] **Phase 0:** One-sentence ${kind} concept (assistant text only; no code fences)`,
    "- [ ] **Phase 1:** `write_file` **`conf.json` only** → **`reload_emulator`**",
    `- [ ] **Phase 2:** Minimal **\`main.py\`** stub (preview runs; ${kind === "widget" ? "Pillow blank frame" : "pygame shell"})`,
    "- [ ] **Phase 3:** Core behavior with **`read_file`** + **`replace_in_file`**",
    "- [ ] **Phase 4:** Fonts / assets only if needed (`widget-fonts`, `asset-pipeline`, `copy_asset_file`)",
    ""
  ];
  if (sizeLine) {
    lines.push(sizeLine, "");
  }
  return lines.join("\n").trimEnd();
}

/** True when the routed prompt should include a fresh scaffold build plan. */
export function shouldIncludeCreatorBuildPlan(
  templateMode: string | undefined,
  confJsonExists: boolean
): boolean {
  if (templateMode !== "game-creator" && templateMode !== "widget-creator") {
    return false;
  }
  return !confJsonExists;
}
