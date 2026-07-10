import type { AgentEvent, UserLocale, WidgetSize } from "@dartsnut/shared-ipc";

export function buildIntakeProjectTypePromptEvent(
  visible: boolean,
  locale?: UserLocale | null,
  at = 0
): AgentEvent {
  if (!visible) {
    return { type: "intake_project_type_prompt", at, visible: false };
  }
  return {
    type: "intake_project_type_prompt",
    at,
    visible: true,
    options: ["game", "widget"],
    ...(locale ? { locale } : {})
  };
}

export function buildIntakeWidgetSizePromptEvent(
  visible: boolean,
  sizes: readonly WidgetSize[],
  locale?: UserLocale | null,
  at = 0
): AgentEvent {
  if (!visible) {
    return { type: "intake_widget_size_prompt", at, visible: false };
  }
  return {
    type: "intake_widget_size_prompt",
    at,
    visible: true,
    sizes: [...sizes],
    ...(locale ? { locale } : {})
  };
}
