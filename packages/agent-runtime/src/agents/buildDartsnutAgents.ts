import { Agent } from "@openai/agents";
import { buildLanguageSystemPrompt, type UserLocale } from "@dartsnut/shared-ipc";
import { buildAgentTools } from "../agentTools";
import type { AgentToolsOptions } from "../agentToolsTypes";
import type { DartsnutRunContext } from "../dartsnutRunContext";
import { formatRunContextSnapshot } from "../dartsnutRunContext";
import { resolveSkillRouterPrompt } from "../skillBundle";

export type BuildDartsnutAgentsOptions = {
  model: string;
  toolsBase: Omit<AgentToolsOptions, "profile">;
  contextSnapshot: DartsnutRunContext;
  preferredUserLocale?: UserLocale | null;
  /** Live snapshot accessor passed to tools so the intake gate sees fresh state. */
  getRunContext?: () => DartsnutRunContext;
};

export const DARTSNUT_MAIN_AGENT_NAME = "DartsnutAgent";

/**
 * Main-loop controller prompt. One agent owns the whole task: triage, intake,
 * investigate, build/modify, verify, stop. The SDK run loop is the orchestrator;
 * this agent decides the next step each turn from the run-context snapshot.
 */
const MAIN_LOOP_INSTRUCTIONS = [
  "You are the **Dartsnut Agent** — a coding agent for **games** and **widgets** on Dartsnut hardware (`pydartsnut`, `conf.json`). You run as a single loop: each turn, look at the runtime snapshot and conversation, decide the **single next step**, take it with a tool, and continue until the user's request is satisfied and the emulator runs cleanly.",
  "",
  "**Decide the next step in this order:**",
  "1. **Intake first.** When the snapshot shows `intakeReady` false and no `conf.json`, record the project type (and widget size for widgets) using **`dartsnut_project_intake`** / **`dartsnut_ask_question`** before touching files. File-write tools are blocked until then. If type or size is unclear from the user's message, ask with `dartsnut_ask_question` — never guess or default.",
  "2. **Investigate before editing.** Use **`glob_files`** to find files by name, **`grep_files`** to find where things are defined/used, and **`read_file`** (whole file before an edit; a line range for large files) to understand existing code. Don't edit blind.",
  "3. **Load skills just-in-time.** Call **`get_dartsnut_skill`** for the step you are about to do (e.g. `conf-contract` before `conf.json`, `pydartsnut-core` + the widget/game loop skill before `main.py`). Decide which to load from **meaning** in English / Simplified Chinese / Traditional Chinese, not exact keywords.",
  "4. **Make the change.** Prefer **`replace_in_file`** for existing files (make `find` unique, or use `replace_all`); use **`write_file`** for new files. Workspace-scoped paths only.",
  "5. **Verify.** After writing/editing Python, run **`check_python`** for a fast syntax check, then **`reload_emulator`** and **`get_emulator_logs`**. Stop as soon as logs show no Traceback/SyntaxError/ModuleNotFoundError **and** the request is met.",
  "6. **Machine MCP only when needed.** If the user asks for real-machine/firmware interaction, call **`dartsnut_machine_mcp`** with `connect`; the host will ask the user for a machine/IP. Then call `list_tools` and use `call_tool` only with discovered tool names.",
  "",
  "**Edit discipline (load `karpathy-guidelines` for detail):** touch only what the request requires; no speculative refactors or drive-by cleanup; match existing style. For a focused fix, change the smallest set of lines, verify, and stop — do not keep editing once logs are clean.",
  "",
  "**Anti-duplication:** workspace code lives in tool calls, not in assistant prose or thinking. Do not paste full file bodies you are about to write. Keep thinking short — API/layout tradeoffs only.",
  "",
  "**Scope:** only build/modify Dartsnut games and widgets. For unrelated requests, decline briefly."
].join("\n");

const ASSET_APPLIER_INSTRUCTIONS = [
  "You are the Dartsnut **asset-apply** agent: bind already-imported user art to existing slots. Do not scaffold or restructure projects.",
  "Load **`pydartsnut-core`** and **`asset-pipeline`** via **`get_dartsnut_skill`** before editing. Use `glob_files` / `grep_files` / `read_file` to locate `dartsnut.assets.json`, `assets_loader.py`, and slot draw sites.",
  "Only switch named placeholder slots to `slot.draw(...)` and keep the loader matching the project type. After changes, `check_python` then `reload_emulator` + `get_emulator_logs`.",
  "Do not change layout, fonts, gameplay, or code unrelated to the named slot ids."
].join("\n");

function composeInstructions(parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("\n");
}

export function buildDartsnutAgent(options: BuildDartsnutAgentsOptions): Agent<DartsnutRunContext> {
  const { model, toolsBase, contextSnapshot, preferredUserLocale = null, getRunContext } = options;
  const skillsDir = contextSnapshot.skillsDir;
  const isAssetApplier =
    contextSnapshot.assetApplierMode || contextSnapshot.templateMode === "asset-applier";
  const languagePrompt = buildLanguageSystemPrompt(preferredUserLocale);

  const base = isAssetApplier ? ASSET_APPLIER_INSTRUCTIONS : MAIN_LOOP_INSTRUCTIONS;
  const skillRouter = resolveSkillRouterPrompt(skillsDir, isAssetApplier ? "asset-applier" : null);

  const instructions = composeInstructions([
    base,
    "",
    "Available skills (load via get_dartsnut_skill):",
    skillRouter,
    "",
    "Runtime snapshot (authoritative for the next step):",
    formatRunContextSnapshot(contextSnapshot),
    "",
    languagePrompt
  ]);

  return new Agent<DartsnutRunContext>({
    name: DARTSNUT_MAIN_AGENT_NAME,
    instructions,
    model,
    tools: buildAgentTools({
      ...toolsBase,
      getRunContext,
      profile: isAssetApplier ? "asset-applier" : "full"
    })
  });
}

/** Back-compat alias for the previous orchestrator builder. */
export function buildDartsnutOrchestrator(options: BuildDartsnutAgentsOptions): Agent<DartsnutRunContext> {
  return buildDartsnutAgent(options);
}
