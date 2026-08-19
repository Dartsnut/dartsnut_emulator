export const DEFAULT_CHAT_PANE_WIDTH = 680;
export const MIN_CHAT_PANE_WIDTH = 320;
export const MIN_EMULATOR_PANE_WIDTH = 360;
export const CHAT_PANE_WIDTH_STORAGE_KEY = "dartsnut-chat-pane-width";
export const CHAT_PANE_RATIO_STORAGE_KEY = "dartsnut-chat-pane-ratio";
export const DEFAULT_WORKSPACE_MENU_WIDTH = 280;
export const MIN_WORKSPACE_MENU_WIDTH = 190;
export const MAX_WORKSPACE_MENU_WIDTH = 420;
export const WORKSPACE_MENU_WIDTH_STORAGE_KEY = "dartsnut-workspace-menu-width";
export const WORKSPACE_MENU_COLLAPSED_STORAGE_KEY = "dartsnut-workspace-menu-collapsed";

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
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

export function getStoredChatPaneRatio(): number | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const ratio = Number(window.localStorage.getItem(CHAT_PANE_RATIO_STORAGE_KEY));
    return Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : null;
  } catch {
    return null;
  }
}

export function setStoredChatPaneRatio(ratio: number): void {
  if (typeof window === "undefined" || !Number.isFinite(ratio)) {
    return;
  }
  try {
    window.localStorage.setItem(CHAT_PANE_RATIO_STORAGE_KEY, String(ratio));
  } catch {
    // Storage is optional and may be unavailable in restricted renderer contexts.
  }
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

export function clampChatPaneRatio(ratio: number, panelWidth: number): number {
  const width = Math.max(1, Math.round(finiteNumber(panelWidth, DEFAULT_CHAT_PANE_WIDTH + MIN_EMULATOR_PANE_WIDTH)));
  const minRatio = MIN_CHAT_PANE_WIDTH / width;
  const maxRatio = Math.max(minRatio, (width - MIN_EMULATOR_PANE_WIDTH) / width);
  return Math.min(Math.max(finiteNumber(ratio, DEFAULT_CHAT_PANE_WIDTH / width), minRatio), maxRatio);
}

export function chatPaneWidthFromRatio(ratio: number, panelWidth: number): number {
  const width = Math.max(1, Math.round(finiteNumber(panelWidth, DEFAULT_CHAT_PANE_WIDTH + MIN_EMULATOR_PANE_WIDTH)));
  return Math.round(clampChatPaneRatio(ratio, width) * width);
}

export function chatPaneRatioFromWidth(chatWidth: number, panelWidth: number): number {
  const width = Math.max(1, Math.round(finiteNumber(panelWidth, DEFAULT_CHAT_PANE_WIDTH + MIN_EMULATOR_PANE_WIDTH)));
  return clampChatPaneRatio(finiteNumber(chatWidth, DEFAULT_CHAT_PANE_WIDTH) / width, width);
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
