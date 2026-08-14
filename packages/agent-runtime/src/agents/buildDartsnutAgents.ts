import { Agent } from "@openai/agents";
import { buildLanguageSystemPrompt, type UserLocale } from "@dartsnut/shared-ipc";
import { buildAgentTools } from "../agentTools";
import type { AgentToolsOptions } from "../agentToolsTypes";
import type { DartsnutRunContext } from "../dartsnutRunContext";
import { formatRunContextSnapshot } from "../dartsnutRunContext";
import { resolveSkillRouterPrompt } from "../skillBundle";
import { createModelRetrySettings, type ModelRetryDiagnostic } from "../modelRetry";

export type BuildDartsnutAgentsOptions = {
  model: string;
  toolsBase: Omit<AgentToolsOptions, "profile">;
  contextSnapshot: DartsnutRunContext;
  preferredUserLocale?: UserLocale | null;
  onModelRetry?: (diagnostic: ModelRetryDiagnostic) => void;
};

export const DARTSNUT_MAIN_AGENT_NAME = "DartsnutAgent";

const MAIN_INSTRUCTIONS = [
  "Build and modify Dartsnut games and widgets. Use the workspace and emulator tools; decline unrelated work.",
  "Inspect existing files before editing. Load `dartsnut-core` plus the relevant game, widget, or asset skill before changing that domain.",
  "For a new project, infer type, display size, and concept from the request, existing files, and template hints. Choose a reasonable reversible option when unspecified. Vague creative freedom such as `surprise me` means choose and build.",
  "Ask one concise natural-language question only when missing information blocks progress or equally plausible choices would fundamentally change the project. Otherwise proceed without intake ceremony.",
  "After Python changes run `check_python`, then reload and observe the emulator and read logs. Exercise at least one input path for games. Fix failures before finishing.",
  "Keep changes scoped to the request."
].join("\n");

const ASSET_INSTRUCTIONS = [
  "Apply already-bound assets to existing Dartsnut slots.",
  "Load `dartsnut-core` and `dartsnut-assets`, inspect the manifest and draw sites, and change only the named slots or loader code required by them."
].join("\n");

export function buildDartsnutAgent(options: BuildDartsnutAgentsOptions): Agent<DartsnutRunContext> {
  const { model, toolsBase, contextSnapshot, preferredUserLocale = null } = options;
  const assetMode = contextSnapshot.assetApplierMode || contextSnapshot.templateMode === "asset-applier";
  const instructions = [
    assetMode ? ASSET_INSTRUCTIONS : MAIN_INSTRUCTIONS,
    buildLanguageSystemPrompt(preferredUserLocale),
    resolveSkillRouterPrompt(contextSnapshot.skillsDir, assetMode ? "asset-applier" : null),
    "Runtime context:",
    formatRunContextSnapshot(contextSnapshot)
  ].filter(Boolean).join("\n\n");

  return new Agent<DartsnutRunContext>({
    name: DARTSNUT_MAIN_AGENT_NAME,
    model,
    instructions,
    modelSettings: { retry: createModelRetrySettings(options.onModelRetry) },
    tools: buildAgentTools({
      ...toolsBase,
      profile: assetMode ? "asset-applier" : "full"
    })
  });
}
