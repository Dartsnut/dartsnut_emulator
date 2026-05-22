/** Exported for transcript extraction (see `transcriptUserBubbleText`). */
export const POST_INTAKE_BUILD_REQUEST_PREFIX = "User's build request (implement now):";

export interface BuildPostIntakeCreatorUserPromptOptions {
  /**
   * When true (default for host-chained intake → creator), use build-now instructions.
   * Type and size were already chosen via intake; interpret the original message semantically.
   */
  forceBuildAfterIntake?: boolean;
}

/**
 * User message for the automatic creator run chained after creation intake.
 * Host does not classify intent via keywords — the model interprets the original message
 * in any supported language (English, zh-Hans, zh-Hant).
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

  if (options?.forceBuildAfterIntake) {
    const buildNowLead = [
      "**Build now (mandatory):** Interpret the user's first message **by meaning** in whatever language they used (English, Simplified Chinese, or Traditional Chinese).",
      "If it is open-ended or creative (e.g. surprise me, 给我点儿惊喜, 隨便做一個), **pick exactly one concrete widget/game concept** (one short line in assistant text if needed), then implement per **Success criteria**.",
      "If it names a product, feature, or build goal (including plans to provide art/assets later, e.g. 我将提供素材 / I'll provide assets later), implement that interpretation with sensible defaults.",
      "Load **`karpathy-guidelines`**, **`creator-incremental`**, **`conf-contract`**, **`pydartsnut-core`** with **`get_dartsnut_skill`** (parallel OK), then tool-first scaffold and iteration.",
      "**Do not** run a second brainstorm after skill results return or ask what to build unless truly blocked (e.g. missing required size)."
    ].join(" ");
    const buildRequestLine =
      original.length > 0
        ? `${POST_INTAKE_BUILD_REQUEST_PREFIX} ${original}`
        : "User gave no substantive first message before intake — pick one sensible concept from context and implement.";
    return [
      ...shared,
      "",
      buildNowLead,
      "Pick sensible defaults for ambiguous details and mention them briefly in your final reply.",
      buildRequestLine
    ].join("\n");
  }

  const interpretLine = [
    "Interpret the user's original message **semantically** (English, Simplified Chinese, or Traditional Chinese).",
    "If it already states what to build or clearly asks for implementation, proceed with **Build now** per **Success criteria** (load core skills first, tool-first).",
    "If it is empty or truly vague with no product intent, give a **one-sentence** acknowledgement that the folder is ready, then ask one focused question about what to display or do."
  ].join(" ");
  const originalLine =
    original.length > 0
      ? `Original first message: ${original}`
      : "There was no substantive first message before intake.";
  return [...shared, "", interpretLine, originalLine].join("\n");
}
