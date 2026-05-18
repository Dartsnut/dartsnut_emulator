/** Exported for transcript extraction (see `transcriptUserBubbleText`). */
export const POST_INTAKE_BUILD_REQUEST_PREFIX = "User's build request (implement now):";

const VAGUE_ONLY =
  /^(?:hi|hello|hey|yo|sup|test|help|\?|thanks|thank you|ok|okay|start|go)[\s!.?,]*$/i;

const BUILD_VERBS =
  /\b(?:create|make|build|implement|write|add|design|show|display|visualize|need|want)\b/i;

const PRODUCT_OR_FEATURE =
  /\b(?:widget|game|clock|score|timer|smoothing|smooth|trajectory|counter|dart|display|animation|gradient|countdown|weather|temperature)\b/i;

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

/**
 * User message for the automatic creator run chained after creation intake.
 */
export function buildPostIntakeCreatorUserPrompt(originalUserPrompt: string): string {
  const original = originalUserPrompt.trim();
  const shared = [
    "Creation **intake just finished**: the empty workspace is selected and **Creation context** above already has project type and (for widgets) display size.",
    "Do **not** open with a generic **Hello / Welcome to Dartsnut Chat** or repeat product onboarding — the user already completed intake."
  ];

  if (postIntakeCreatorStatesBuildIntent(originalUserPrompt)) {
    return [
      ...shared,
      "",
      "**Build now (mandatory):** The user's first message already states what to create. Load any required skills with **`get_dartsnut_skill`** if not already loaded in this session, then create runnable project files in the workspace using tools (`write_file`, `copy_asset_file`, and **`reload_emulator`** after `conf.json`).",
      "Pick sensible defaults for any ambiguous details and mention them briefly in your final reply — **do not** ask what to build or offer multiple design directions unless you are truly blocked (e.g. missing required size).",
      `${POST_INTAKE_BUILD_REQUEST_PREFIX} ${original}`
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
