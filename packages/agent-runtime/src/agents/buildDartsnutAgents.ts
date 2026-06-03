import { Agent, handoff } from "@openai/agents";
import type { RunContext } from "@openai/agents";
import { buildLanguageSystemPrompt, type UserLocale } from "@dartsnut/shared-ipc";
import { buildAgentTools } from "../agentTools";
import type { AgentToolsOptions } from "../agentToolsTypes";
import type { DartsnutRunContext } from "../dartsnutRunContext";
import { formatRunContextSnapshot } from "../dartsnutRunContext";
import { bundleForTemplateMode, resolveSkillRouterPrompt } from "../skillBundle";
import { buildModificationWorkflowPrompt } from "../modificationWorkflow";
import {
  DARTSNUT_AGENT_NAMES,
  handoffToAssetApplierEnabled,
  handoffToGameCreatorEnabled,
  handoffToGameModifierEnabled,
  handoffToInfoGathererEnabled,
  handoffToSurgicalFixerEnabled,
  handoffToWidgetCreatorEnabled,
  handoffToWidgetModifierEnabled
} from "./handoffGates";

export type BuildDartsnutAgentsOptions = {
  model: string;
  toolsBase: Omit<AgentToolsOptions, "profile">;
  contextSnapshot: DartsnutRunContext;
  preferredUserLocale?: UserLocale | null;
};

export type DartsnutAgentGraph = {
  orchestrator: Agent<DartsnutRunContext>;
  widgetCreator: Agent<DartsnutRunContext>;
  gameCreator: Agent<DartsnutRunContext>;
};

function runCtx(runContext: RunContext<DartsnutRunContext>): DartsnutRunContext {
  return runContext.context;
}

function gateEnabled(predicate: (ctx: DartsnutRunContext) => boolean) {
  return ({ runContext }: { runContext: RunContext<DartsnutRunContext> }) =>
    predicate(runCtx(runContext));
}

const CREATOR_AFTER_INTAKE_HINT = [
  "Intake already recorded project type and widget size (when applicable).",
  "Fulfill the **user's original request** from conversation history — load deferred skills as needed.",
  "Ensure a **runnable** workspace (`conf.json`, `main.py` as required); use **`reload_emulator`** and **`get_emulator_logs`** to verify before you finish.",
  "Do not repeat intake or ask project type/size again."
].join("\n");

const SURGICAL_FIXER_INSTRUCTIONS = [
  "You are the Dartsnut **SurgicalFixer** specialist — one tight pass on an existing project.",
  "Load **karpathy-guidelines** via `get_dartsnut_skill` before any edit.",
  "- Touch only what the user request requires; prefer **replace_in_file** over **write_file**.",
  "- **read_file** before edits; after material changes run **reload_emulator** then **get_emulator_logs**.",
  "- No speculative refactors or drive-by cleanup.",
  "- When logs show no Traceback/SyntaxError/ModuleNotFoundError, stop immediately."
].join("\n");

const ORCHESTRATOR_INSTRUCTIONS = [
  "You are the Dartsnut **Orchestrator**. Triage each user message and **hand off** to the right specialist.",
  "Never edit workspace files yourself — use handoff tools only.",
  "When **intakeReady** is false, hand off to **InfoGatherer** only.",
  "When **intakeReady** is true and the workspace has no complete scaffold yet, hand off to **WidgetCreator** or **GameCreator** (match **projectType**).",
  "When **initialPassComplete** is true, hand off to the matching modifier or SurgicalFixer for small edits.",
  "Prefer the narrowest specialist; specialists choose tools and skills — do not micromanage step order.",
  "When asset-applier mode is active, hand off to AssetApplier only.",
  "The runtime snapshot below reflects intake readiness and artifacts; handoff tools enforce hard gates."
].join("\n");

function buildOrchestratorInstructions(snapshot: DartsnutRunContext, locale: UserLocale | null): string {
  const languagePrompt = buildLanguageSystemPrompt(locale);
  return [
    ORCHESTRATOR_INSTRUCTIONS,
    "",
    "Runtime snapshot (authoritative for routing):",
    formatRunContextSnapshot(snapshot),
    "",
    languagePrompt
  ].join("\n");
}

function buildSpecialistInstructions(
  base: string,
  locale: UserLocale | null,
  projectHint?: string
): string {
  const languagePrompt = buildLanguageSystemPrompt(locale);
  const parts = [base];
  if (projectHint) {
    parts.push("", projectHint);
  }
  parts.push("", languagePrompt);
  return parts.join("\n");
}

export function buildDartsnutAgentGraph(options: BuildDartsnutAgentsOptions): DartsnutAgentGraph {
  const { model, toolsBase, contextSnapshot, preferredUserLocale = null } = options;
  const skillsDir = contextSnapshot.skillsDir;

  const widgetCreator = new Agent<DartsnutRunContext>({
    name: DARTSNUT_AGENT_NAMES.widgetCreator,
    instructions: buildSpecialistInstructions(
      resolveSkillRouterPrompt(skillsDir, "widget-creator"),
      preferredUserLocale,
      ["Project type: **widget**.", CREATOR_AFTER_INTAKE_HINT].join("\n")
    ),
    model,
    tools: buildAgentTools({ ...toolsBase, profile: "creator" })
  });

  const gameCreator = new Agent<DartsnutRunContext>({
    name: DARTSNUT_AGENT_NAMES.gameCreator,
    instructions: buildSpecialistInstructions(
      resolveSkillRouterPrompt(skillsDir, "game-creator"),
      preferredUserLocale,
      ["Project type: **game**.", CREATOR_AFTER_INTAKE_HINT].join("\n")
    ),
    model,
    tools: buildAgentTools({ ...toolsBase, profile: "creator" })
  });

  const infoGatherer = new Agent<DartsnutRunContext>({
    name: DARTSNUT_AGENT_NAMES.infoGatherer,
    instructions: buildSpecialistInstructions(
      [
        bundleForTemplateMode(skillsDir, "creation-intake"),
        "",
        "After **`read_workspace_conf`**, you **must** hand off to **WidgetCreator** or **GameCreator** (matching recorded project type) in this same run — do not stop after a confirmation message. The creator reads the user request from conversation history; do not describe the creative concept yourself."
      ].join("\n"),
      preferredUserLocale
    ),
    model,
    tools: buildAgentTools({ ...toolsBase, profile: "intake" }),
    handoffs: [
      handoff(widgetCreator, { isEnabled: gateEnabled(handoffToWidgetCreatorEnabled) }),
      handoff(gameCreator, { isEnabled: gateEnabled(handoffToGameCreatorEnabled) })
    ]
  });

  const widgetModifier = new Agent<DartsnutRunContext>({
    name: DARTSNUT_AGENT_NAMES.widgetModifier,
    instructions: buildSpecialistInstructions(
      buildModificationWorkflowPrompt({ userPrompt: "(see conversation for user request)" }),
      preferredUserLocale,
      "Project type: **widget** — modification pass on an existing widget project."
    ),
    model,
    tools: buildAgentTools({ ...toolsBase, profile: "modifier" })
  });

  const gameModifier = new Agent<DartsnutRunContext>({
    name: DARTSNUT_AGENT_NAMES.gameModifier,
    instructions: buildSpecialistInstructions(
      buildModificationWorkflowPrompt({ userPrompt: "(see conversation for user request)" }),
      preferredUserLocale,
      "Project type: **game** — modification pass on an existing game project."
    ),
    model,
    tools: buildAgentTools({ ...toolsBase, profile: "modifier" })
  });

  const surgicalFixer = new Agent<DartsnutRunContext>({
    name: DARTSNUT_AGENT_NAMES.surgicalFixer,
    instructions: buildSpecialistInstructions(SURGICAL_FIXER_INSTRUCTIONS, preferredUserLocale),
    model,
    tools: buildAgentTools({ ...toolsBase, profile: "surgical" })
  });

  const assetApplier = new Agent<DartsnutRunContext>({
    name: DARTSNUT_AGENT_NAMES.assetApplier,
    instructions: buildSpecialistInstructions(
      resolveSkillRouterPrompt(skillsDir, "asset-applier"),
      preferredUserLocale
    ),
    model,
    tools: buildAgentTools({ ...toolsBase, profile: "asset-applier" })
  });

  const orchestrator = new Agent<DartsnutRunContext>({
    name: DARTSNUT_AGENT_NAMES.orchestrator,
    instructions: buildOrchestratorInstructions(contextSnapshot, preferredUserLocale),
    model,
    tools: buildAgentTools({ ...toolsBase, profile: "orchestrator" }),
    handoffs: [
      handoff(infoGatherer, { isEnabled: gateEnabled(handoffToInfoGathererEnabled) }),
      handoff(widgetCreator, { isEnabled: gateEnabled(handoffToWidgetCreatorEnabled) }),
      handoff(gameCreator, { isEnabled: gateEnabled(handoffToGameCreatorEnabled) }),
      handoff(widgetModifier, { isEnabled: gateEnabled(handoffToWidgetModifierEnabled) }),
      handoff(gameModifier, { isEnabled: gateEnabled(handoffToGameModifierEnabled) }),
      handoff(surgicalFixer, { isEnabled: gateEnabled(handoffToSurgicalFixerEnabled) }),
      handoff(assetApplier, { isEnabled: gateEnabled(handoffToAssetApplierEnabled) })
    ]
  });

  return { orchestrator, widgetCreator, gameCreator };
}

export function buildDartsnutOrchestrator(options: BuildDartsnutAgentsOptions): Agent<DartsnutRunContext> {
  return buildDartsnutAgentGraph(options).orchestrator;
}
