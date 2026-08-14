import fs from "node:fs";
import path from "node:path";
import {
  WIDGET_DISPLAY_SIZES,
  type ProjectType,
  type WidgetSize
} from "@dartsnut/shared-ipc";
import { classifyDartsnutProjectFiles } from "@dartsnut/shared-ipc/dist/projectClassification";

export function parseConfWidgetSize(size: unknown): WidgetSize | undefined {
  if (!Array.isArray(size) || size.length !== 2) return undefined;
  const key = `${Number(size[0])}x${Number(size[1])}` as WidgetSize;
  return WIDGET_DISPLAY_SIZES.includes(key) ? key : undefined;
}

export function readWorkspaceCreatorHints(absoluteWorkspacePath: string): {
  templateMode: "widget-creator" | "game-creator";
  projectType: ProjectType;
  widgetSize?: WidgetSize;
} | null {
  const pyprojectPath = path.join(absoluteWorkspacePath, "pyproject.toml");
  const confPath = path.join(absoluteWorkspacePath, "conf.json");
  const classification = classifyDartsnutProjectFiles(
    fs.existsSync(pyprojectPath) ? fs.readFileSync(pyprojectPath, "utf-8") : null,
    fs.existsSync(confPath) ? fs.readFileSync(confPath, "utf-8") : null
  );
  if (!classification.ok) return null;
  if (classification.projectType === "widget") {
    return {
      templateMode: "widget-creator",
      projectType: "widget",
      widgetSize: parseConfWidgetSize(classification.conf?.size)
    };
  }
  return { templateMode: "game-creator", projectType: "game" };
}
