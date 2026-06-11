/** Exported for transcript extraction (see `transcriptUserBubbleText`). */
export const POST_INTAKE_BUILD_REQUEST_PREFIX = "User request:";

export interface BuildPostIntakeCreatorUserPromptOptions {
  forceBuildAfterIntake?: boolean;
}

/**
 * Optional user message when chaining a separate creator run after intake (legacy).
 * The current runtime uses a single agent that builds in the same run, so this is
 * unused on the live path; kept only for the transcript prefix constant.
 */
export function buildPostIntakeCreatorUserPrompt(
  originalUserPrompt: string,
  _options?: BuildPostIntakeCreatorUserPromptOptions
): string {
  const original = originalUserPrompt.trim();
  const userLine =
    original.length > 0
      ? `${POST_INTAKE_BUILD_REQUEST_PREFIX} ${original}`
      : `${POST_INTAKE_BUILD_REQUEST_PREFIX} (none recorded before intake)`;
  return [
    "Intake is complete. Project metadata is in **Creation context** when present.",
    "Fulfill the user request with native tool calls only (no XML/JSON envelope text).",
    "",
    userLine
  ].join("\n");
}
