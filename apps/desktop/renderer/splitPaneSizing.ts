export const DEFAULT_CHAT_PANE_WIDTH = 680;
export const MIN_CHAT_PANE_WIDTH = 320;
export const MIN_EMULATOR_PANE_WIDTH = 360;
export const CHAT_PANE_WIDTH_STORAGE_KEY = "dartsnut-chat-pane-width";
export const DEFAULT_WORKSPACE_MENU_WIDTH = 280;
export const MIN_WORKSPACE_MENU_WIDTH = 190;
export const MAX_WORKSPACE_MENU_WIDTH = 420;
export const WORKSPACE_MENU_WIDTH_STORAGE_KEY = "dartsnut-workspace-menu-width";
export const WORKSPACE_MENU_COLLAPSED_STORAGE_KEY = "dartsnut-workspace-menu-collapsed";
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

export function clampWorkspaceMenuWidth(width: number): number {
  const rounded = Math.round(finiteNumber(width, DEFAULT_WORKSPACE_MENU_WIDTH));
  return Math.min(Math.max(rounded, MIN_WORKSPACE_MENU_WIDTH), MAX_WORKSPACE_MENU_WIDTH);
}

export function getStoredWorkspaceMenuWidth(): number {
  if (typeof window === "undefined") {
    return DEFAULT_WORKSPACE_MENU_WIDTH;
  }
  try {
    const storedWidth = Number(window.localStorage.getItem(WORKSPACE_MENU_WIDTH_STORAGE_KEY));
    return Number.isFinite(storedWidth) && storedWidth > 0
      ? clampWorkspaceMenuWidth(storedWidth)
      : DEFAULT_WORKSPACE_MENU_WIDTH;
  } catch {
    return DEFAULT_WORKSPACE_MENU_WIDTH;
  }
}

export function setStoredWorkspaceMenuWidth(width: number): void {
  if (typeof window === "undefined" || !Number.isFinite(width)) {
    return;
  }
  try {
    window.localStorage.setItem(WORKSPACE_MENU_WIDTH_STORAGE_KEY, String(clampWorkspaceMenuWidth(width)));
  } catch {
    // Storage is optional and may be unavailable in restricted renderer contexts.
  }
}

export function nextWorkspaceMenuWidthFromDrag(input: {
  startClientX: number;
  currentClientX: number;
  startWidth: number;
}): number {
  const delta = finiteNumber(input.currentClientX, input.startClientX) - finiteNumber(input.startClientX, 0);
  return clampWorkspaceMenuWidth(finiteNumber(input.startWidth, DEFAULT_WORKSPACE_MENU_WIDTH) + delta);
}

export function resizeWorkspaceMenuKeepingPaneTotal(input: {
  targetMenuWidth: number;
  menuWidth: number;
  chatWidth: number;
}): { menuWidth: number; chatWidth: number } {
  const currentMenuWidth = clampWorkspaceMenuWidth(input.menuWidth);
  const currentChatWidth = Math.max(
    MIN_CHAT_PANE_WIDTH,
    Math.round(finiteNumber(input.chatWidth, DEFAULT_CHAT_PANE_WIDTH))
  );
  const combinedWidth = currentMenuWidth + currentChatWidth;
  const maxMenuWidth = Math.min(MAX_WORKSPACE_MENU_WIDTH, combinedWidth - MIN_CHAT_PANE_WIDTH);
  const targetMenuWidth = Math.round(finiteNumber(input.targetMenuWidth, currentMenuWidth));
  const menuWidth = Math.min(Math.max(targetMenuWidth, MIN_WORKSPACE_MENU_WIDTH), maxMenuWidth);
  return {
    menuWidth,
    chatWidth: combinedWidth - menuWidth
  };
}

export function nextWorkspaceAndChatWidthsFromDrag(input: {
  startClientX: number;
  currentClientX: number;
  startMenuWidth: number;
  startChatWidth: number;
}): { menuWidth: number; chatWidth: number } {
  const delta = finiteNumber(input.currentClientX, input.startClientX) - finiteNumber(input.startClientX, 0);
  return resizeWorkspaceMenuKeepingPaneTotal({
    targetMenuWidth: finiteNumber(input.startMenuWidth, DEFAULT_WORKSPACE_MENU_WIDTH) + delta,
    menuWidth: input.startMenuWidth,
    chatWidth: input.startChatWidth
  });
}

export function getStoredWorkspaceMenuCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(WORKSPACE_MENU_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setStoredWorkspaceMenuCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKSPACE_MENU_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Storage is optional and may be unavailable in restricted renderer contexts.
  }
}
