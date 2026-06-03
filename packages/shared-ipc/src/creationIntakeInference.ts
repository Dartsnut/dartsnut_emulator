import type { ProjectType, WidgetSize } from "./contracts";
import { WIDGET_DISPLAY_SIZES } from "./contracts";

/** Prompts that defer creative/type choices to the agent — intake must ask explicitly. */
const VAGUE_CREATION_PROMPT =
  /\b(surprise\s*me|surprise\s*us|anything\s*you\s*like|whatever\s*you\s*want|you\s+pick|you\s+choose|up\s+to\s+you|dealer'?s\s+choice|random\s+(?:idea|thing|project)|随便|隨便|你定|你來定|你决定|你決定)\b/i;

const WIDGET_SIZE_LITERAL = /\b(128x160|128x128|128x64|64x32)\b/i;

const GAME_HINT =
  /\b(game|games|pygame|dart\s*hits?|button\s*events?|游戏|遊戲|游戲)\b/i;

const WIDGET_HINT =
  /\b(widget|widgets|pil\s*loop|widget_params|小组件|小組件|組件|组件|組件)\b/i;

export function isVagueCreationUserPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  return VAGUE_CREATION_PROMPT.test(trimmed);
}

export function parseExplicitWidgetSizeToken(text: string): WidgetSize | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const only = trimmed.match(/^(128x160|128x128|128x64|64x32)$/i);
  if (only) {
    const token = only[1]!.toLowerCase() as WidgetSize;
    return WIDGET_DISPLAY_SIZES.includes(token) ? token : undefined;
  }
  const match = trimmed.match(WIDGET_SIZE_LITERAL);
  if (!match) {
    return undefined;
  }
  const token = match[1]!.toLowerCase() as WidgetSize;
  return WIDGET_DISPLAY_SIZES.includes(token) ? token : undefined;
}

/**
 * Infer game vs widget only when the user message states it clearly (not vague creative briefs).
 */
export function inferProjectTypeFromUserText(text: string): ProjectType | undefined {
  const trimmed = text.trim();
  if (!trimmed || isVagueCreationUserPrompt(trimmed)) {
    return undefined;
  }
  const game = GAME_HINT.test(trimmed);
  const widget = WIDGET_HINT.test(trimmed);
  if (game && !widget) {
    return "game";
  }
  if (widget && !game) {
    return "widget";
  }
  return undefined;
}

export function canRecordProjectTypeFromUserText(text: string, projectType: ProjectType): boolean {
  const inferred = inferProjectTypeFromUserText(text);
  return inferred === projectType;
}

export function canRecordWidgetSizeFromUserText(text: string, widgetSize: WidgetSize): boolean {
  const trimmed = text.trim();
  if (!trimmed || isVagueCreationUserPrompt(trimmed)) {
    return false;
  }
  const token = parseExplicitWidgetSizeToken(trimmed);
  return token === widgetSize;
}
