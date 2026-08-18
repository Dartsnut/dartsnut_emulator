import type { WidgetConfigSnapshot } from "@dartsnut/shared-ipc";

export function shouldShowWidgetParams(
  projectType: string | null | undefined,
  configStatus: WidgetConfigSnapshot["status"],
): boolean {
  const normalizedProjectType = projectType?.toLowerCase() ?? null;
  if (normalizedProjectType === "widget") return true;
  if (normalizedProjectType === "game") return false;
  return configStatus === "ready";
}
