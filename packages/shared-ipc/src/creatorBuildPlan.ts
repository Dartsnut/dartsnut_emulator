import type { ProjectType, WidgetSize } from "./contracts";

export type CreatorBuildPlanTemplateMode = "game-creator" | "widget-creator";

export interface FormatCreatorBuildPlanOptions {
  templateMode: CreatorBuildPlanTemplateMode;
  projectType: ProjectType;
  widgetSize?: WidgetSize;
}

/**
 * Markdown success criteria injected into creator prompts (visible in chat transcript).
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
    "## Success criteria",
    "",
    "Plan and execute using **`get_dartsnut_skill`** (`karpathy-guidelines`, `creator-incremental`, domain skills). The host does **not** prescribe step order or phase numbers.",
    "",
    `- [ ] **\`conf.json\`** valid for this ${kind} (type, size, required keys)`,
    `- [ ] **\`main.py\`** runs in the emulator (reload + logs without Traceback / SyntaxError)`,
    `- [ ] Behavior matches the user request (confirm with \`read_file\` and emulator behavior)`,
    `- [ ] Logs clean before you declare done`,
    "",
    "**Verify:** After material changes to **`conf.json`** or **`main.py`**, or before declaring done — **`reload_emulator`** then **`get_emulator_logs`**.",
    "",
    "Skill loading and editing rules live in the system router and deferred skills — not repeated here.",
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
