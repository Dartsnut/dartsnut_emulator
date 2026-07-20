import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

function replaceProjectValue(section: string, key: "name" | "version", value: string): { text: string; found: boolean } {
  const assignment = new RegExp(`^(\\s*)${key}\\s*=.*$`, "m");
  if (!assignment.test(section)) return { text: section, found: false };
  return {
    text: section.replace(assignment, (_line, indent: string) => `${indent}${key} = ${JSON.stringify(value)}`),
    found: true
  };
}

/** Keep conf.json authoritative while preserving all unrelated pyproject.toml content. */
export function syncPyprojectProjectMetadata(text: string, appId: string, version: string): string {
  const canonicalId = requireValue(appId, "conf.json id");
  const canonicalVersion = requireValue(version, "conf.json version");
  const bounds = projectSectionBounds(text);
  if (!bounds) {
    const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    return `${text}${separator}\n[project]\nname = ${JSON.stringify(canonicalId)}\nversion = ${JSON.stringify(canonicalVersion)}\n`;
  }

  let section = text.slice(bounds.start, bounds.end);
  const nameResult = replaceProjectValue(section, "name", canonicalId);
  section = nameResult.text;
  const versionResult = replaceProjectValue(section, "version", canonicalVersion);
  section = versionResult.text;

  const insertions: string[] = [];
  if (!nameResult.found) insertions.push(`name = ${JSON.stringify(canonicalId)}`);
  if (!versionResult.found) insertions.push(`version = ${JSON.stringify(canonicalVersion)}`);
  if (insertions.length) {
    const leadingBreak = section.startsWith("\r\n") ? "\r\n" : section.startsWith("\n") ? "\n" : "";
    section = `${leadingBreak}\n${insertions.join("\n")}\n${section.slice(leadingBreak.length)}`;
  }
  return text.slice(0, bounds.start) + section + text.slice(bounds.end);
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

/**
 * Synchronize workspace metadata from conf.json. When version is provided, update conf.json and
 * pyproject.toml as one coordinated operation and restore conf.json if the second write fails.
 */
export function syncWorkspaceProjectMetadata(
  workspaceRoot: string,
  version?: string
): WorkspaceProjectMetadata {
  const confPath = path.join(workspaceRoot, "conf.json");
  const pyprojectPath = path.join(workspaceRoot, "pyproject.toml");
  if (!fs.existsSync(confPath)) throw new Error("conf.json does not exist in the current workspace.");
  if (!fs.existsSync(pyprojectPath)) throw new Error("pyproject.toml does not exist in the current workspace.");

  const originalConf = fs.readFileSync(confPath, "utf-8");
  const originalPyproject = fs.readFileSync(pyprojectPath, "utf-8");
  let conf: Record<string, unknown>;
  try {
    const parsed = JSON.parse(originalConf) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("conf.json must contain an object.");
    conf = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Could not parse conf.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  const appId = requireValue(conf.id, "conf.json id");
  const canonicalVersion = version === undefined
    ? requireValue(conf.version, "conf.json version")
    : requireValue(version, "New version");
  if (version !== undefined) conf.version = canonicalVersion;

  const nextConf = version === undefined ? originalConf : `${JSON.stringify(conf, null, 2)}\n`;
  const nextPyproject = syncPyprojectProjectMetadata(originalPyproject, appId, canonicalVersion);
  const confChanged = nextConf !== originalConf;
  const pyprojectChanged = nextPyproject !== originalPyproject;

  if (!confChanged && !pyprojectChanged) return { appId, version: canonicalVersion };

  try {
    if (confChanged) writeAtomic(confPath, nextConf);
    if (pyprojectChanged) writeAtomic(pyprojectPath, nextPyproject);
  } catch (error) {
    if (confChanged) {
      try {
        writeAtomic(confPath, originalConf);
      } catch (rollbackError) {
        throw new Error(
          `Workspace metadata update failed and conf.json could not be restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
    }
    throw error;
  }

  return { appId, version: canonicalVersion };
}
