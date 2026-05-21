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
    "**Before phase 1 tools:** In the **assistant message** (visible in chat), post an **Agent steps** section: **8–15 numbered micro-steps** (each = one read → small edit round). **No code fences** in that message.",
    "",
    "**After each phase:** One short line in the assistant message marking the phase done, then start the next tool round. Do not re-brainstorm or rewrite the whole plan.",
    "",
    "**After phase 2 (iteration loop):** Every round: **`read_file` `main.py` first**, then at most **one** small **`replace_in_file`** (or one `copy_asset_file`, then read + wire next round). No tool-free rounds until a final one-sentence done status.",
    "",
    "Skill loading and tool rules live in the system router and `creator-incremental` — not repeated here.",
    "",
    `- [ ] **Phase 0:** One-sentence ${kind} concept (assistant text only; no code fences)`,
    "- [ ] **Phase 1:** `write_file` **`conf.json` only** → **`reload_emulator`**",
    `- [ ] **Phase 2:** Minimal **\`main.py\`** stub (preview runs; ${kind === "widget" ? "Pillow blank frame" : "pygame shell"})`,
    "- [ ] **Phase 3:** Core behavior — repeated **`read_file` `main.py`** + one small **`replace_in_file`** per round",
    "- [ ] **Phase 4:** Fonts / assets — **one** `copy_asset_file` per round, then read `main.py` and wire",
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
