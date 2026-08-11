export const DEFAULT_CHAT_PANE_WIDTH = 680;
export const MIN_CHAT_PANE_WIDTH = 320;
export const MIN_EMULATOR_PANE_WIDTH = 360;
export const CHAT_PANE_WIDTH_STORAGE_KEY = "dartsnut-chat-pane-width";
const SPLIT_LAYOUT_GUTTER_PX = 20;

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function maxChatPaneWidthForViewport(viewportWidth: number): number {
  const availableWidth =
    finiteNumber(viewportWidth, DEFAULT_CHAT_PANE_WIDTH + MIN_EMULATOR_PANE_WIDTH + SPLIT_LAYOUT_GUTTER_PX) -
    MIN_EMULATOR_PANE_WIDTH -
    SPLIT_LAYOUT_GUTTER_PX;
  return Math.max(MIN_CHAT_PANE_WIDTH, availableWidth);
}

export function clampChatPaneWidth(width: number, viewportWidth: number): number {
  const rounded = Math.round(finiteNumber(width, DEFAULT_CHAT_PANE_WIDTH));
  const maxWidth = maxChatPaneWidthForViewport(viewportWidth);
  return Math.min(Math.max(rounded, MIN_CHAT_PANE_WIDTH), maxWidth);
}

export function getStoredChatPaneWidth(): number {
  if (typeof window === "undefined") {
    return DEFAULT_CHAT_PANE_WIDTH;
  }
  try {
    const storedWidth = Number(window.localStorage.getItem(CHAT_PANE_WIDTH_STORAGE_KEY));
    return Number.isFinite(storedWidth) && storedWidth > 0
      ? Math.round(storedWidth)
      : DEFAULT_CHAT_PANE_WIDTH;
  } catch {
    return DEFAULT_CHAT_PANE_WIDTH;
  }
}

export function setStoredChatPaneWidth(width: number): void {
  if (typeof window === "undefined" || !Number.isFinite(width)) {
    return;
  }
  try {
    window.localStorage.setItem(CHAT_PANE_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Storage is optional and may be unavailable in restricted renderer contexts.
  }
}

export function nextChatPaneWidthFromDrag(input: {
  startClientX: number;
  currentClientX: number;
  startWidth: number;
  viewportWidth: number;
}): number {
  const delta = finiteNumber(input.currentClientX, input.startClientX) - finiteNumber(input.startClientX, 0);
  return clampChatPaneWidth(finiteNumber(input.startWidth, DEFAULT_CHAT_PANE_WIDTH) + delta, input.viewportWidth);
}
