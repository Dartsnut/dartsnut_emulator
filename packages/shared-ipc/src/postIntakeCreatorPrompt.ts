/** Exported for transcript extraction (see `transcriptUserBubbleText`). */
export const POST_INTAKE_BUILD_REQUEST_PREFIX = "User's build request (implement now):";

const VAGUE_ONLY =
  /^(?:hi|hello|hey|yo|sup|test|help|\?|thanks|thank you|ok|okay|start|go)[\s!.?,]*$/i;

const BUILD_VERBS =
  /\b(?:create|make|build|implement|write|add|design|show|display|visualize|need|want)\b/i;

const PRODUCT_OR_FEATURE =
  /\b(?:widget|game|clock|score|timer|smoothing|smooth|trajectory|counter|dart|display|animation|gradient|countdown|weather|temperature)\b/i;

/** Open-ended creative prompts where the model must pick one concept and stick to it. */
const OPEN_ENDED_CREATIVE =
  /\b(?:surprise\s+me|surprise\s+us|surprise|anything|whatever|up to you|your choice|dealer'?s choice)\b/i;

export function isOpenEndedCreativePrompt(originalUserPrompt: string): boolean {
  const original = originalUserPrompt.trim();
  if (original.length < 2) {
    return false;
  }
  if (OPEN_ENDED_CREATIVE.test(original)) {
    return true;
  }
  if (VAGUE_ONLY.test(original)) {
    return true;
  }
  const words = original.split(/\s+/).filter(Boolean);
  return words.length <= 2 && !BUILD_VERBS.test(original) && !PRODUCT_OR_FEATURE.test(original);
}

/**
 * True when the user's first composer message already names what to build
 * (post-intake should instruct the agent to implement, not ask).
 */
export function postIntakeCreatorStatesBuildIntent(originalUserPrompt: string): boolean {
  const original = originalUserPrompt.trim();
  if (original.length < 3) {
    return false;
  }
  if (VAGUE_ONLY.test(original)) {
    return false;
  }
  if (BUILD_VERBS.test(original) || PRODUCT_OR_FEATURE.test(original)) {
    return true;
  }
  const words = original.split(/\s+/).filter(Boolean);
  return words.length >= 3;
}

export interface BuildPostIntakeCreatorUserPromptOptions {
  /**
   * When true (default for host-chained intake → creator), always use the build-now
   * instructions even if the first message was vague (e.g. "surprise me") — type and size
   * were already chosen via intake.
   */
  forceBuildAfterIntake?: boolean;
}

/**
 * User message for the automatic creator run chained after creation intake.
 */
export function buildPostIntakeCreatorUserPrompt(
  originalUserPrompt: string,
  options?: BuildPostIntakeCreatorUserPromptOptions
): string {
  const original = originalUserPrompt.trim();
  const shared = [
    "Creation **intake just finished**: the empty workspace is selected and **Creation context** above already has project type and (for widgets) display size.",
    "Do **not** open with a generic **Hello / Welcome to Dartsnut Chat** or repeat product onboarding — the user already completed intake."
  ];

  if (options?.forceBuildAfterIntake || postIntakeCreatorStatesBuildIntent(originalUserPrompt)) {
    const openEnded = isOpenEndedCreativePrompt(originalUserPrompt);
    const buildNowLead = openEnded
      ? "**Build now (mandatory):** The user asked for an open-ended surprise — **pick exactly one concrete widget/game concept** (name it in assistant text), post **Agent steps** (8–15 micro-step bullets, no code) in the assistant message, then scaffold per the **Build guidelines**: load **`creator-incremental`**, **`conf-contract`**, **`pydartsnut-core`** with **`get_dartsnut_skill`** (parallel OK), **`write_file`** **`conf.json` only**, **`reload_emulator`**, then minimal **`main.py`**. After the stub, each round: **`read_file` `main.py`**, then one small edit. **Do not** run a second brainstorm after skill results return."
      : "**Build now (mandatory):** The user's first message already states what to create. Post **Agent steps** (8–15 micro-step bullets, no code) in the assistant message before the first **`write_file`**, then scaffold per the **Build guidelines**: load **`creator-incremental`**, **`conf-contract`**, **`pydartsnut-core`** first, then **`conf.json`**, **`reload_emulator`**, stub **`main.py`**. After the stub, each round: **`read_file` `main.py`**, then one small edit — never a whole phase in thinking only. Load other skills only when that step needs them.";
    const buildRequestLine = openEnded
      ? `Original vibe (already satisfied by intake — do not re-interpret as a new request after skills load): ${original || "surprise"}`
      : `${POST_INTAKE_BUILD_REQUEST_PREFIX} ${original}`;
    return [
      ...shared,
      "",
      buildNowLead,
      "Pick sensible defaults for any ambiguous details and mention them briefly in your final reply — **do not** ask what to build or offer multiple design directions unless you are truly blocked (e.g. missing required size).",
      buildRequestLine
    ].join("\n");
  }

  const originalLine =
    original.length > 0
      ? `Original first message (use only if it already states what to build): ${original}`
      : "There was no substantive first message before intake.";
  return [
    ...shared,
    "Give a **one-sentence** acknowledgement that the folder is ready (you may mention type/size from context), then ask what they want this project to display or do, with a few short examples if helpful.",
    originalLine
  ].join("\n");
}
