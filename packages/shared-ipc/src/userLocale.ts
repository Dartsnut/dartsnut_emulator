/** Static response-language guidance for the agent. */
export function buildLanguageSystemPrompt(): string {
  return "Respond in the language used by the user in their current message when possible.";
}
