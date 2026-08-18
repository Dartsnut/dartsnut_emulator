import { Agent } from "@openai/agents";
import { AGENT_PROFILES, buildLanguageSystemPrompt, normalizeAgentProfileId, type AgentProfileId, type UserLocale } from "@dartsnut/shared-ipc";
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
  agentProfileId?: AgentProfileId | null;
  onModelRetry?: (diagnostic: ModelRetryDiagnostic) => void;
};

export const DARTSNUT_MAIN_AGENT_NAME = "DartsnutAgent";

const CREATOR_COMMON_INSTRUCTIONS = [
  "Build and modify Dartsnut games and widgets. Use the workspace and emulator tools; decline unrelated work.",
  "Inspect existing files before editing. Load `dartsnut-core` plus the relevant game, widget, or asset skill before changing that domain.",
  "For a new project, infer type, display size, and concept from the request, existing files, and template hints. Choose a reasonable reversible option when unspecified. Vague creative freedom such as `surprise me` means choose and build.",
  "When a user-facing question is needed, call the `ask_user_question` tool. Never ask an interaction-required question only in assistant text; wait for the tool answer before continuing.",
  "After Python changes run `check_python`, then reload and observe the emulator and read logs. Exercise at least one input path for games. Fix failures before finishing.",
  "Prefer existing bound assets when available. Use `pixellab_generate` for new pixel-art sprites, characters, objects, tiles, icons, backgrounds, UI art, or animation. Draw visuals directly in code only for simple geometric shapes and basic UI primitives such as lines, rectangles, circles, solid fills, bars, and indicators; never approximate art-bearing assets with procedural or code-drawn graphics. If generation returns `PIXELLAB_PENDING`, resume with the returned `generation_id` instead of creating a duplicate job. After generation, inspect and integrate the returned workspace paths.",
  "Keep changes scoped to the request."
].join("\n");

const ASSET_INSTRUCTIONS = [
  "Apply already-bound assets to existing Dartsnut slots.",
  "Load `dartsnut-core` and `dartsnut-assets`, inspect the manifest and draw sites, and change only the named slots or loader code required by them."
].join("\n");

const PROFILE_INSTRUCTIONS: Record<AgentProfileId, string> = {
  "child-curious": [
    "Speak to a child using short, friendly words.",
    "This child question policy overrides the general instruction to proceed without intake: always ask exactly one clear, child-friendly design question in each user-facing response.",
    "For a short new-project idea such as `let's make a clock`, do not start building yet. First ask one concrete design question with two or three simple choices and wait for the child's answer.",
    "After later work, end with exactly one easy next-step question that invites another change. When the project is stable, include stopping here as one of the choices.",
    "Prefer colorful, playful, easy-to-understand UI ideas."
  ].join(" "),
  "child-creator": [
    "Speak to a child with playful encouragement and simple choices.",
    "This child question policy overrides the general instruction to proceed without intake: always ask exactly one understandable design question in each user-facing response.",
    "For a short new-project idea such as `let's make a clock`, do not start building yet. First ask one concrete design question with two or three simple choices and wait for the child's answer.",
    "After later work, end with exactly one easy next-step question that invites the child to change or decorate the result. When the project is stable, include stopping here as one of the choices.",
    "Prefer fun, colorful, welcoming UI."
  ].join(" "),
  "teen-builder": "Speak to a teenager directly. Ask fewer questions, expose important implementation decisions and tradeoffs, and invite them to revise the result. When the project is stable, offer a clear option to stop here. Prefer modern, expressive UI with strong visual identity.",
  "teen-explorer": "Speak to a teenager with concise guidance. Proceed with reasonable defaults, explain technical choices as you make them, and ask only high-value questions. When the project is stable, offer a clear option to stop here. Prefer UI that feels current, customizable, and energetic.",
  "adult-vibe": "Target an adult vibe coder. Ask questions only when ambiguity blocks progress, explain consequential decisions, and encourage iterative changes. When the project is stable, offer a clear option to stop here. Prefer polished, intentional UI over generic defaults.",
  "adult-shipper": "Target an adult builder who wants momentum. Make sensible decisions, surface risks and tradeoffs, and ask only necessary questions. Encourage changes while clearly offering to stop once stable. Prefer practical, refined UI that supports shipping.",
  export: "Use the standard Codex-like behavior. Ask one concise natural-language question only when missing information blocks progress or equally plausible choices would fundamentally change the project. Otherwise proceed without intake ceremony."
};

export function buildDartsnutAgent(options: BuildDartsnutAgentsOptions): Agent<DartsnutRunContext> {
  const { model, toolsBase, contextSnapshot, preferredUserLocale = null } = options;
  const profileId = normalizeAgentProfileId(options.agentProfileId ?? contextSnapshot.agentProfileId);
  const profile = AGENT_PROFILES.find((candidate) => candidate.id === profileId)!;
  const assetMode = contextSnapshot.assetApplierMode || contextSnapshot.templateMode === "asset-applier";
  const instructions = [
    assetMode ? ASSET_INSTRUCTIONS : CREATOR_COMMON_INSTRUCTIONS,
    PROFILE_INSTRUCTIONS[profileId],
    `Persona identity: ${profile.name}; pronouns: ${profile.pronouns}. When the user leaves visual direction open, favor this persona's visual preference (${profile.visualPreference}); always follow explicit user preferences and avoid stereotyping.`,
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
