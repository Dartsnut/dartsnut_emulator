import TOML from "@iarna/toml";
import type { ProjectType } from "./contracts";

export type DartsnutProjectInvalidReason =
  | "missing_pyproject"
  | "invalid_pyproject"
  | "missing_project_name"
  | "missing_project_version"
  | "missing_pydartsnut"
  | "broken_widget";

export type DartsnutProjectClassification =
  | {
      ok: true;
      appId: string;
      version: string;
      projectType: ProjectType;
      conf: Record<string, unknown> | null;
    }
  | { ok: false; reason: DartsnutProjectInvalidReason; message: string };

function normalizedDistributionName(requirement: string): string | null {
  const match = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(requirement);
  return match ? match[1].toLowerCase().replace(/[._-]+/g, "") : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function classifyDartsnutProjectFiles(
  pyprojectText: string | null,
  confJsonText: string | null
): DartsnutProjectClassification {
  if (pyprojectText === null) {
    return { ok: false, reason: "missing_pyproject", message: "pyproject.toml was not found." };
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(pyprojectText);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_pyproject",
      message: error instanceof Error ? `Could not parse pyproject.toml: ${error.message}` : "Could not parse pyproject.toml."
    };
  }

  if (!isObject(parsed) || !isObject(parsed.project)) {
    return { ok: false, reason: "invalid_pyproject", message: "pyproject.toml must contain a [project] table." };
  }
  const project = parsed.project;
  const appId = typeof project.name === "string" ? project.name.trim() : "";
  if (!appId) {
    return { ok: false, reason: "missing_project_name", message: "pyproject.toml [project].name must not be empty." };
  }
  const version = typeof project.version === "string" ? project.version.trim() : "";
  if (!version) {
    return { ok: false, reason: "missing_project_version", message: "pyproject.toml [project].version must not be empty." };
  }
  if (!Array.isArray(project.dependencies) || !project.dependencies.every((item) => typeof item === "string")) {
    return {
      ok: false,
      reason: "invalid_pyproject",
      message: "pyproject.toml [project].dependencies must be an array of strings."
    };
  }
  if (!project.dependencies.some((item) => normalizedDistributionName(item) === "pydartsnut")) {
    return { ok: false, reason: "missing_pydartsnut", message: "pyproject.toml must declare pydartsnut in [project].dependencies." };
  }

  if (confJsonText === null) {
    return { ok: true, appId, version, projectType: "game", conf: null };
  }

  let conf: unknown;
  try {
    conf = JSON.parse(confJsonText);
  } catch (error) {
    return {
      ok: false,
      reason: "broken_widget",
      message: error instanceof Error ? `Could not parse conf.json: ${error.message}` : "Could not parse conf.json."
    };
  }
  if (!isObject(conf)) {
    return { ok: false, reason: "broken_widget", message: "conf.json must contain a JSON object." };
  }
  if (conf.type === "game") {
    return { ok: true, appId, version, projectType: "game", conf: null };
  }
  if (!Object.prototype.hasOwnProperty.call(conf, "size") || !Object.prototype.hasOwnProperty.call(conf, "fields")) {
    return { ok: false, reason: "broken_widget", message: "conf.json must contain size and fields." };
  }
  return { ok: true, appId, version, projectType: "widget", conf };
}
