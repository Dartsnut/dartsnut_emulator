import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { tool } from "@openai/agents";
import type { Tool, ToolInputParameters } from "@openai/agents";
import { DEFERRED_SKILL_IDS, readDeferredSkillMarkdown } from "./skillBundle";
import type { DeferredSkillId } from "./skillBundle";
import {
  AGENT_ASSET_APPLIER_TOOL_SCHEMAS,
  AGENT_TOOL_SCHEMAS,
  getAgentToolDefinition
} from "./toolSchemas";
import type { AgentToolProfile, AgentToolsOptions } from "./agentToolsTypes";
import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";

function schemasForProfile(profile: AgentToolProfile | undefined): ChatCompletionTool[] {
  switch (profile) {
    case "asset-applier":
      return AGENT_ASSET_APPLIER_TOOL_SCHEMAS;
    case "full":
    default:
      return AGENT_TOOL_SCHEMAS;
  }
}

function isDeferredSkillId(value: string): value is DeferredSkillId {
  return (DEFERRED_SKILL_IDS as readonly string[]).includes(value);
}

function stripAssetHashSuffix(value: string): string {
  return value.replace(/-[0-9a-f]{8}(?=\.[^./\\]+$)/i, "");
}

/** Directories never walked by list_files / grep_files / glob_files. */
const SEARCH_SKIP_DIRS = new Set([".dartsnut", "node_modules", ".git", "__pycache__"]);

/** Skip obviously-binary contents in grep (NUL byte in first chunk). */
function looksBinary(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 4096);
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/** Convert a glob (supporting `*`, `?`, `**`) to a RegExp anchored to a full relative path. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**` matches across path separators; consume an optional following slash.
        re += ".*";
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|[]{}".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

async function walkRelativeFiles(rootDir: string, startDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        await walk(path.join(dir, entry.name));
        continue;
      }
      const abs = path.join(dir, entry.name);
      out.push(path.relative(rootDir, abs).replace(/\\/g, "/"));
    }
  };
  await walk(startDir);
  return out;
}

type JsonObjectToolParameters = Extract<ToolInputParameters, { type: "object" }>;

function defineJsonSchemaTool(
  name: string,
  execute: (args: Record<string, unknown>) => Promise<string>
): Tool {
  const def = getAgentToolDefinition(name);
  if (!def) {
    throw new Error(`Missing tool schema: ${name}`);
  }
  // Chat Completions schemas keep optional fields out of `required` and may use
  // additionalProperties: false even when strict mode is off — cast for SDK typing.
  return tool({
    name,
    description: def.description,
    strict: false,
    parameters: def.parameters as unknown as JsonObjectToolParameters,
    execute: async (args) => execute(args as Record<string, unknown>)
  } as Parameters<typeof tool>[0]);
}

export function buildAgentTools(options: AgentToolsOptions): Tool[] {
  /** Hard gate: refuse file mutations until intake recorded project type (and size) or a project already exists. */
  const fileMutationBlockedReason = (): string | undefined => {
    const ctx = options.getRunContext?.();
    if (!ctx) {
      return undefined;
    }
    if (ctx.assetApplierMode) {
      return undefined;
    }
    if (ctx.intakeReady || ctx.artifacts.confJson) {
      return undefined;
    }
    return "Record the project type (and widget size for widgets) via dartsnut_project_intake / dartsnut_ask_question before writing workspace files.";
  };

  const listFiles = defineJsonSchemaTool("list_files", async (args) => {
    const rel = typeof args.path === "string" ? args.path : ".";
    try {
      const target = options.workspacePolicy.resolveWithinRoot(rel);
      const out = await walkRelativeFiles(target, target);
      out.sort((a, b) => a.localeCompare(b));
      return JSON.stringify({ ok: true, files: out });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const readFile = defineJsonSchemaTool("read_file", async (args) => {
    const rel = typeof args.path === "string" ? args.path : "";
    const hasOffset = typeof args.offset === "number" && Number.isFinite(args.offset);
    const hasLimit = typeof args.limit === "number" && Number.isFinite(args.limit);
    try {
      const target = options.workspacePolicy.resolveWithinRoot(rel);
      const content = await fsp.readFile(target, "utf-8");
      if (!hasOffset && !hasLimit) {
        return JSON.stringify({ ok: true, content });
      }
      const lines = content.split(/\r?\n/);
      const lineCount = lines.length;
      const start = Math.max(1, hasOffset ? Math.floor(args.offset as number) : 1);
      const limit = hasLimit ? Math.max(1, Math.floor(args.limit as number)) : 2000;
      const end = Math.min(lineCount, start + limit - 1);
      const slice = lines
        .slice(start - 1, end)
        .map((text, i) => `${start + i}\t${text}`)
        .join("\n");
      return JSON.stringify({ ok: true, content: slice, startLine: start, endLine: end, lineCount });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const grepFiles = defineJsonSchemaTool("grep_files", async (args) => {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (!pattern) {
      return JSON.stringify({ ok: false, error: "pattern is required" });
    }
    const globArg = typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : undefined;
    const rel = typeof args.path === "string" && args.path.trim() ? args.path.trim() : ".";
    const ignoreCase = args.ignore_case === true;
    const cap = Math.min(
      1000,
      Math.max(1, typeof args.max_results === "number" ? Math.floor(args.max_results) : 200)
    );
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (error) {
      return JSON.stringify({ ok: false, error: `Invalid regex: ${error instanceof Error ? error.message : String(error)}` });
    }
    const root = options.workspacePolicy.getRoot();
    let target: string;
    try {
      target = options.workspacePolicy.resolveWithinRoot(rel);
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    const globRe = globArg ? globToRegExp(globArg) : undefined;
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let truncated = false;
    const relFiles = await walkRelativeFiles(root, target);
    relFiles.sort((a, b) => a.localeCompare(b));
    for (const relPath of relFiles) {
      if (globRe && !globRe.test(relPath)) {
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = await fsp.readFile(path.join(root, relPath));
      } catch {
        continue;
      }
      if (looksBinary(buffer)) {
        continue;
      }
      const fileLines = buffer.toString("utf-8").split(/\r?\n/);
      for (let i = 0; i < fileLines.length; i += 1) {
        if (regex.test(fileLines[i])) {
          if (matches.length >= cap) {
            truncated = true;
            break;
          }
          matches.push({ path: relPath, line: i + 1, text: fileLines[i].slice(0, 500) });
        }
      }
      if (truncated) {
        break;
      }
    }
    return JSON.stringify({ ok: true, matches, truncated });
  });

  const globFiles = defineJsonSchemaTool("glob_files", async (args) => {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (!pattern) {
      return JSON.stringify({ ok: false, error: "pattern is required" });
    }
    const rel = typeof args.path === "string" && args.path.trim() ? args.path.trim() : ".";
    const cap = Math.min(
      2000,
      Math.max(1, typeof args.max_results === "number" ? Math.floor(args.max_results) : 500)
    );
    const root = options.workspacePolicy.getRoot();
    let target: string;
    try {
      target = options.workspacePolicy.resolveWithinRoot(rel);
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    const globRe = globToRegExp(pattern);
    const relFiles = await walkRelativeFiles(root, target);
    const out = relFiles.filter((relPath) => globRe.test(relPath)).sort((a, b) => a.localeCompare(b));
    const truncated = out.length > cap;
    return JSON.stringify({ ok: true, files: out.slice(0, cap), truncated });
  });

  const writeFile = defineJsonSchemaTool("write_file", async (args) => {
    const blocked = fileMutationBlockedReason();
    if (blocked) {
      return JSON.stringify({ ok: false, error: blocked });
    }
    const rel = typeof args.path === "string" ? args.path : "";
    const content = typeof args.content === "string" ? args.content : "";
    try {
      const target = options.workspacePolicy.resolveWithinRoot(rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, "utf-8");
      return JSON.stringify({ ok: true, path: rel });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const replaceInFile = defineJsonSchemaTool("replace_in_file", async (args) => {
    const blocked = fileMutationBlockedReason();
    if (blocked) {
      return JSON.stringify({ ok: false, error: blocked });
    }
    const rel = typeof args.path === "string" ? args.path : "";
    const find = typeof args.find === "string" ? args.find : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    const replaceAll = args.replace_all === true;
    try {
      const target = options.workspacePolicy.resolveWithinRoot(rel);
      const content = await fsp.readFile(target, "utf-8");
      if (!find) {
        return JSON.stringify({ ok: false, error: "find must be non-empty" });
      }
      const occurrences = content.split(find).length - 1;
      if (occurrences === 0) {
        return JSON.stringify({ ok: false, error: "find target not present in file" });
      }
      if (occurrences > 1 && !replaceAll) {
        return JSON.stringify({
          ok: false,
          error: `find matches ${occurrences} times; include more surrounding context to make it unique, or set replace_all to true.`
        });
      }
      const next = replaceAll ? content.split(find).join(replace) : content.replace(find, replace);
      await fsp.writeFile(target, next, "utf-8");
      return JSON.stringify({ ok: true, path: rel, replaced: replaceAll ? occurrences : 1 });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const copyAssetFile = defineJsonSchemaTool("copy_asset_file", async (args) => {
    const blocked = fileMutationBlockedReason();
    if (blocked) {
      return JSON.stringify({ ok: false, error: blocked });
    }
    const sourceRaw = typeof args.source === "string" ? args.source : "";
    const toRaw = typeof args.path === "string" ? args.path : "";
    const source = stripAssetHashSuffix(sourceRaw);
    const to = stripAssetHashSuffix(toRaw);
    const root = options.assetRoots?.widgetFonts;
    if (!root) {
      return JSON.stringify({ ok: false, error: "Widget font asset root is not configured." });
    }
    try {
      const sourceAbs = path.join(root, path.basename(source));
      const destAbs = options.workspacePolicy.resolveWithinRoot(to);
      await fsp.mkdir(path.dirname(destAbs), { recursive: true });
      await fsp.copyFile(sourceAbs, destAbs);
      return JSON.stringify({ ok: true, source, path: to });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const getSkill = defineJsonSchemaTool("get_dartsnut_skill", async (args) => {
    const skillIdRaw = typeof args.skill_id === "string" ? args.skill_id : "";
    if (!isDeferredSkillId(skillIdRaw)) {
      return JSON.stringify({ ok: false, error: `Unknown skill_id: ${skillIdRaw}` });
    }
    const allowed = options.skillLibrary?.allowedIds ?? [];
    if (options.skillLibrary && !allowed.includes(skillIdRaw)) {
      return JSON.stringify({ ok: false, error: `${skillIdRaw} is unavailable in this session.` });
    }
    if (!options.skillLibrary) {
      return JSON.stringify({ ok: false, error: "Skill library is not configured." });
    }
    try {
      const content = readDeferredSkillMarkdown(options.skillLibrary.skillsDir, skillIdRaw);
      return JSON.stringify({ ok: true, skill_id: skillIdRaw, content });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const projectIntake = defineJsonSchemaTool("dartsnut_project_intake", async (args) => {
    if (!options.hostIntakeToolHandler) {
      return JSON.stringify({ ok: false, error: "Intake handler unavailable." });
    }
    return options.hostIntakeToolHandler(args);
  });

  const askQuestion = defineJsonSchemaTool("dartsnut_ask_question", async (args) => {
    if (!options.hostAskQuestionHandler) {
      return JSON.stringify({ ok: false, error: "Ask-question handler unavailable." });
    }
    return options.hostAskQuestionHandler(args);
  });

  const reloadEmulator = defineJsonSchemaTool("reload_emulator", async () => {
    if (!options.hostReloadEmulatorHandler) {
      return JSON.stringify({ ok: false, error: "reload_emulator handler unavailable." });
    }
    return options.hostReloadEmulatorHandler();
  });

  const getEmulatorLogs = defineJsonSchemaTool("get_emulator_logs", async (args) => {
    const max_lines = typeof args.max_lines === "number" ? Math.floor(args.max_lines) : undefined;
    if (!options.hostGetEmulatorLogsHandler) {
      return JSON.stringify({ ok: false, error: "get_emulator_logs handler unavailable." });
    }
    return options.hostGetEmulatorLogsHandler({ max_lines });
  });

  const checkPython = defineJsonSchemaTool("check_python", async (args) => {
    if (!options.hostCheckPythonHandler) {
      return JSON.stringify({ ok: false, error: "check_python handler unavailable." });
    }
    const paths = Array.isArray(args.paths)
      ? args.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : undefined;
    return options.hostCheckPythonHandler({ paths });
  });

  const machineMcp = defineJsonSchemaTool("dartsnut_machine_mcp", async (args) => {
    if (!options.hostMachineMcpHandler) {
      return JSON.stringify({ ok: false, error: "Machine MCP handler unavailable." });
    }
    return options.hostMachineMcpHandler(args);
  });

  const registry: Record<string, Tool> = {
    list_files: listFiles,
    read_file: readFile,
    grep_files: grepFiles,
    glob_files: globFiles,
    write_file: writeFile,
    replace_in_file: replaceInFile,
    copy_asset_file: copyAssetFile,
    get_dartsnut_skill: getSkill,
    dartsnut_project_intake: projectIntake,
    dartsnut_ask_question: askQuestion,
    reload_emulator: reloadEmulator,
    get_emulator_logs: getEmulatorLogs,
    check_python: checkPython,
    dartsnut_machine_mcp: machineMcp
  };

  const requested = new Set(
    (options.completionTools ?? schemasForProfile(options.profile))
      .map((entry) => (entry.type === "function" ? entry.function?.name : undefined))
      .filter((name): name is string => Boolean(name))
  );
  if (requested.size === 0) {
    return Object.values(registry);
  }
  return [...requested].map((name) => registry[name]).filter((entry): entry is Tool => Boolean(entry));
}
