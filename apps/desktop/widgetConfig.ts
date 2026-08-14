import fs from "node:fs";
import path from "node:path";
import {
  parseWidgetFieldDefinitions,
  type WidgetConfigScope,
  type WidgetConfigSnapshot,
} from "@dartsnut/shared-ipc";
import { readWorkspaceProjectClassification } from "./workspaceProjectMetadata";

export function watchWidgetConfigFile(
  confPath: string,
  onChange: () => void,
  interval = 600,
): () => void {
  fs.watchFile(confPath, { interval }, onChange);
  return () => fs.unwatchFile(confPath, onChange);
}

export function widgetConfigPathForScope(
  scope: WidgetConfigScope,
  workspaceRoot: string | null,
  emulatorWidgetRoot: string | null,
): string | null {
  const root = scope === "workspace" ? workspaceRoot : emulatorWidgetRoot;
  return root ? path.join(path.resolve(root), "conf.json") : null;
}

export function readWidgetConfigSnapshot(
  scope: WidgetConfigScope,
  workspaceRoot: string | null,
  emulatorWidgetRoot: string | null,
): WidgetConfigSnapshot {
  const confPath = widgetConfigPathForScope(scope, workspaceRoot, emulatorWidgetRoot);
  if (!confPath) {
    return {
      scope,
      status: "unavailable",
      configKey: null,
      confPath: null,
      message: scope === "workspace" ? "No workspace is selected." : "No widget is selected in the emulator.",
    };
  }
  const configKey = path.resolve(confPath);
  const projectRoot = path.dirname(confPath);
  try {
    const classification = readWorkspaceProjectClassification(projectRoot);
    if (!classification.ok) {
      return { scope, status: "invalid", configKey, confPath, message: classification.message };
    }
    if (classification.projectType !== "widget" || !classification.conf) {
      return { scope, status: "not_widget", configKey, confPath, message: "The selected project is not a widget." };
    }
    const conf = classification.conf;
    const parsed = parseWidgetFieldDefinitions(conf.fields ?? []);
    return {
      scope,
      status: "ready",
      configKey,
      confPath,
      fields: parsed.fields,
      errors: parsed.errors,
    };
  } catch (error) {
    return {
      scope,
      status: "invalid",
      configKey,
      confPath,
      message: error instanceof Error ? error.message : "Could not read the project configuration.",
    };
  }
}
