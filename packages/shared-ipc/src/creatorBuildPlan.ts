import type { ProjectType, WidgetSize } from "./contracts";

export type CreatorBuildPlanTemplateMode = "game-creator" | "widget-creator";

export interface FormatCreatorBuildPlanOptions {
  templateMode: CreatorBuildPlanTemplateMode;
  projectType: ProjectType;
  widgetSize?: WidgetSize;
}

/**
 * Minimal workspace metadata for creator prompts (no creative direction).
 */
export function formatCreatorBuildPlanMessage(options: FormatCreatorBuildPlanOptions): string {
  const { templateMode, projectType, widgetSize } = options;
  const kind = projectType === "widget" ? "widget" : "game";
  const sizeLine =
    projectType === "widget" && widgetSize
      ? `Widget display size: **${widgetSize}** (must match \`conf.json\` \`size\`).`
      : templateMode === "game-creator"
        ? "Default game framebuffer size: **[128, 160]** unless intake metadata overrides."
        : "";

  const lines = [
    "## Workspace metadata",
    "",
    `- Project type: **${kind}**`,
    ...(sizeLine ? [sizeLine] : []),
    "",
    "Use **Creation context** and the user request; load deferred skills and tools as you judge necessary.",
    ""
  ];
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
