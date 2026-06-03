import type { ProjectType, WidgetSize } from "./contracts";

export interface BuildCreationIntakeUserPromptOptions {
  widgetSizeFromPicker?: WidgetSize;
  projectTypeFromPicker?: ProjectType;
}

export function buildCreationIntakeUserPrompt(
  userRequest: string,
  opts?: BuildCreationIntakeUserPromptOptions
): string {
  const projectTypeLine =
    opts?.projectTypeFromPicker != null
      ? `\n\n[UI] User chose project type **${opts.projectTypeFromPicker}** from the in-app **Game / Widget** chip row. Call \`set_project_type\` with that exact \`project_type\` value, then continue intake per the procedure (widget size if \`widget\`, then \`read_workspace_conf\`). Do not ask game vs widget again.`
      : "";
  const pickerLine =
    opts?.widgetSizeFromPicker != null
      ? `\n\n[UI] User chose widget display size **${opts.widgetSizeFromPicker}** from the in-app size chip row. Call \`set_project_type\` with \`widget\` then \`set_widget_size\` with exactly that WxH token, then continue intake (\`read_workspace_conf\`). Do not ask for size again.`
      : "";
  return [
    "## New project intake (mandatory tool use)",
    "An empty workspace directory is already selected on disk. Complete intake, then hand off to the creator specialist (same session).",
    "This turn runs on the OpenAI agent runtime. Use native function tool calls only; do not emit XML/JSON tool envelopes in assistant text.",
    "Use **only** these host tools via native `tool_calls`: **`dartsnut_ask_question`** and **`dartsnut_project_intake`**.",
    "**Blocking questions (`dartsnut_ask_question`):** Each call shows the matching desktop UI (Game/Widget chips or widget size chips) and **does not return** until the user answers. You **must** call this tool when you need that input and cannot take it reliably from the user's message alone — do **not** rely on hidden marker lines or prose-only prompts for those choices.",
    "Allowed `question_id` values: **`project_type`**, **`widget_display_size`** (only after `project_type` is `widget`).",
    "Procedure:",
    "1. Infer **game** vs **widget** from the user's text **by meaning** in any supported language (English, Simplified Chinese, Traditional Chinese), then call `set_project_type`. Examples (non-exhaustive): game / 游戏 / 遊戲; widget / 小组件 / 小組件 / 組件. When intent is **not** clear — including **\"surprise me\"**, **\"随便\"**, or purely creative briefs with no game/widget signal — call **`dartsnut_ask_question`** with `question_id` **`project_type`** (then continue from the tool result). The host rejects guessed types.",
    "2. For **widget** display size: supported values are exactly **128x160**, **128x128**, **128x64**, **64x32**. If the message includes one of those WxH literals, call `set_widget_size` with it. If the user describes dimensions in Chinese (or other wording) and the meaning maps unambiguously to one supported token, use that token. Otherwise call **`dartsnut_ask_question`** with `question_id` **`widget_display_size`** — **never** assume a default, invent a size, or call `set_widget_size` or `read_workspace_conf` until they have answered (via chips or typed follow-up). If the message is **only** one of those four literals (no other words), treat it as their size choice for a widget: call `set_project_type` with `widget` then `set_widget_size` with that token, then continue.",
    "3. Call **`read_workspace_conf`** once type (and widget size if applicable) are resolved.",
    "4. Use `guidance_notes`, `deploy_eligibility`, and `conf_status` to ask **at most one** focused follow-up when the folder is not a blank slate or types disagree.",
    "5. After step 3, **immediately hand off** to **WidgetCreator** or **GameCreator** (matching recorded type). You may add **one short sentence** confirming type and (for widgets) display size, then hand off. **Do not** end the run with only a promise to build later. **Do not** propose or describe a specific widget/game concept — the creator fulfills the user's request.",
    "",
    "User request:",
    `${userRequest}${projectTypeLine}${pickerLine}`
  ].join("\n");
}
