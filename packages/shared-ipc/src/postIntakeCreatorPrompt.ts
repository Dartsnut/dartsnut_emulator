/** Exported for transcript extraction (see `transcriptUserBubbleText`). */
export const POST_INTAKE_BUILD_REQUEST_PREFIX = "User request:";

export interface BuildPostIntakeCreatorUserPromptOptions {
  /**
   * When true (default for host-chained intake → creator), pass the original user text through
   * without adding build direction — intake already recorded type/size.
   */
  forceBuildAfterIntake?: boolean;
}

/**
 * User message for the automatic creator run chained after creation intake.
 * Host does not add creative direction; the model follows the user's original message.
 */
export function buildPostIntakeCreatorUserPrompt(
  originalUserPrompt: string,
  _options?: BuildPostIntakeCreatorUserPromptOptions
): string {
  const original = originalUserPrompt.trim();
  const shared = [
    "Creation **intake just finished**. Project type and (for widgets) display size are in workspace metadata / **Creation context** above.",
    "Runtime is OpenAI-agent based. Continue with native tool calls only (no XML/JSON envelope text).",
    "Do **not** open with a generic **Hello / Welcome to Dartsnut Chat** or repeat product onboarding."
  ];

  const userLine =
    original.length > 0
      ? `${POST_INTAKE_BUILD_REQUEST_PREFIX} ${original}`
      : `${POST_INTAKE_BUILD_REQUEST_PREFIX} (none recorded before intake)`;

  return [...shared, "", userLine].join("\n");
}
