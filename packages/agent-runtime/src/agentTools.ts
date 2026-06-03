import fsp from "node:fs/promises";
import path from "node:path";
import { tool } from "@openai/agents";
import type { Tool, ToolInputParameters } from "@openai/agents";
import { DEFERRED_SKILL_IDS, readDeferredSkillMarkdown } from "./skillBundle";
import type { DeferredSkillId } from "./skillBundle";
import {
  AGENT_ASSET_APPLIER_TOOL_SCHEMAS,
  AGENT_CREATION_INTAKE_TOOL_SCHEMAS,
  AGENT_CREATOR_TOOL_SCHEMAS,
  AGENT_MODIFIER_TOOL_SCHEMAS,
  AGENT_SURGICAL_TOOL_SCHEMAS,
  AGENT_TOOL_SCHEMAS,
  getAgentToolDefinition
} from "./toolSchemas";
import type { AgentToolProfile, AgentToolsOptions } from "./agentToolsTypes";
import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";

function schemasForProfile(profile: AgentToolProfile | undefined): ChatCompletionTool[] {
  switch (profile) {
    case "intake":
      return AGENT_CREATION_INTAKE_TOOL_SCHEMAS;
    case "creator":
      return AGENT_CREATOR_TOOL_SCHEMAS;
    case "modifier":
      return AGENT_MODIFIER_TOOL_SCHEMAS;
    case "surgical":
      return AGENT_SURGICAL_TOOL_SCHEMAS;
    case "asset-applier":
      return AGENT_ASSET_APPLIER_TOOL_SCHEMAS;
    case "orchestrator":
      return [];
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
  const listFiles = defineJsonSchemaTool("list_files", async (args) => {
    const rel = typeof args.path === "string" ? args.path : ".";
    try {
      const target = options.workspacePolicy.resolveWithinRoot(rel);
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const abs = path.join(dir, entry.name);
          const relative = path.relative(target, abs).replace(/\\/g, "/");
          if (entry.isDirectory()) {
            await walk(abs);
            continue;
          }
          out.push(relative);
        }
      };
      await walk(target);
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
    try {
      const target = options.workspacePolicy.resolveWithinRoot(rel);
      const content = await fsp.readFile(target, "utf-8");
      return JSON.stringify({ ok: true, content });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const writeFile = defineJsonSchemaTool("write_file", async (args) => {
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
    const rel = typeof args.path === "string" ? args.path : "";
    const find = typeof args.find === "string" ? args.find : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    try {
      const target = options.workspacePolicy.resolveWithinRoot(rel);
      const content = await fsp.readFile(target, "utf-8");
      if (!find || !content.includes(find)) {
        return JSON.stringify({ ok: false, error: "find target not present in file" });
      }
      await fsp.writeFile(target, content.replace(find, replace), "utf-8");
      return JSON.stringify({ ok: true, path: rel });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const copyAssetFile = defineJsonSchemaTool("copy_asset_file", async (args) => {
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

  const registry: Record<string, Tool> = {
    list_files: listFiles,
    read_file: readFile,
    write_file: writeFile,
    replace_in_file: replaceInFile,
    copy_asset_file: copyAssetFile,
    get_dartsnut_skill: getSkill,
    dartsnut_project_intake: projectIntake,
    dartsnut_ask_question: askQuestion,
    reload_emulator: reloadEmulator,
    get_emulator_logs: getEmulatorLogs
  };

  const requested = new Set(
    (options.completionTools ?? schemasForProfile(options.profile))
      .map((entry) => (entry.type === "function" ? entry.function?.name : undefined))
      .filter((name): name is string => Boolean(name))
  );
  if (requested.size === 0 && options.profile === "orchestrator") {
    return [];
  }
  if (requested.size === 0) {
    return Object.values(registry);
  }
  return [...requested].map((name) => registry[name]).filter((entry): entry is Tool => Boolean(entry));
}
