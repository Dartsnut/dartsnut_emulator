import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  classifyDartsnutProjectFiles,
  type DartsnutProjectClassification
} from "@dartsnut/shared-ipc/dist/projectClassification";

export type WorkspaceProjectMetadata = {
  appId: string;
  version: string;
};

function requireValue(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty.`);
  }
  return normalized;
}

function projectSectionBounds(text: string): { start: number; end: number } | null {
  const projectHeader = /^\s*\[project\]\s*(?:#.*)?$/m.exec(text);
  if (!projectHeader || projectHeader.index == null) return null;
  const start = projectHeader.index + projectHeader[0].length;
  const remaining = text.slice(start);
  const nextHeader = /^\s*\[[^\]\n]+\]\s*(?:#.*)?$/m.exec(remaining);
  return { start, end: nextHeader?.index == null ? text.length : start + nextHeader.index };
}

/** Update only [project].version while preserving unrelated pyproject.toml content. */
export function updatePyprojectProjectVersion(text: string, version: string): string {
  const canonicalVersion = requireValue(version, "New version");
  const bounds = projectSectionBounds(text);
  if (!bounds) throw new Error("pyproject.toml must contain a [project] table.");
  const section = text.slice(bounds.start, bounds.end);
  const assignment = /^(\s*)version\s*=.*$/m;
  if (!assignment.test(section)) throw new Error("pyproject.toml [project].version must not be empty.");
  const nextSection = section.replace(assignment, (_line, indent: string) => `${indent}version = ${JSON.stringify(canonicalVersion)}`);
  return text.slice(0, bounds.start) + nextSection + text.slice(bounds.end);
}

export function readWorkspaceProjectClassification(workspaceRoot: string): DartsnutProjectClassification {
  const pyprojectPath = path.join(workspaceRoot, "pyproject.toml");
  const confPath = path.join(workspaceRoot, "conf.json");
  const pyprojectText = fs.existsSync(pyprojectPath) ? fs.readFileSync(pyprojectPath, "utf-8") : null;
  const confJsonText = fs.existsSync(confPath) ? fs.readFileSync(confPath, "utf-8") : null;
  return classifyDartsnutProjectFiles(pyprojectText, confJsonText);
}

function writeAtomic(targetPath: string, contents: string): void {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, contents, "utf-8");
    fs.renameSync(tempPath, targetPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

/** Read canonical project metadata and optionally update [project].version atomically. */
export function syncWorkspaceProjectMetadata(
  workspaceRoot: string,
  version?: string
): WorkspaceProjectMetadata {
  const pyprojectPath = path.join(workspaceRoot, "pyproject.toml");
  if (!fs.existsSync(pyprojectPath)) throw new Error("pyproject.toml does not exist in the current workspace.");
  const classification = readWorkspaceProjectClassification(workspaceRoot);
  if (!classification.ok) throw new Error(classification.message);
  const originalPyproject = fs.readFileSync(pyprojectPath, "utf-8");
  const canonicalVersion = version === undefined
    ? classification.version
    : requireValue(version, "New version");
  if (version !== undefined) {
    const nextPyproject = updatePyprojectProjectVersion(originalPyproject, canonicalVersion);
    if (nextPyproject !== originalPyproject) writeAtomic(pyprojectPath, nextPyproject);
  }
  return { appId: classification.appId, version: canonicalVersion };
}
