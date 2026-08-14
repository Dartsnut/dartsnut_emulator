import fs from "node:fs";
import path from "node:path";
import {
  WIDGET_DISPLAY_SIZES,
  type ProjectType,
  type WidgetSize
} from "@dartsnut/shared-ipc";

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
  const confPath = path.join(absoluteWorkspacePath, "conf.json");
  if (!fs.existsSync(confPath)) return null;
  try {
    const conf = JSON.parse(fs.readFileSync(confPath, "utf-8")) as {
      type?: string;
      size?: unknown;
    };
    if (conf.type === "widget") {
      return {
        templateMode: "widget-creator",
        projectType: "widget",
        widgetSize: parseConfWidgetSize(conf.size)
      };
    }
    if (conf.type === "game") {
      return { templateMode: "game-creator", projectType: "game" };
    }
  } catch {
    return null;
  }
  return null;
}
