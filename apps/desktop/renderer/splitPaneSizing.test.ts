const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CHAT_PANE_RATIO_STORAGE_KEY,
  DEFAULT_CHAT_PANE_WIDTH,
  DEFAULT_WORKSPACE_MENU_WIDTH,
  MAX_WORKSPACE_MENU_WIDTH,
  MIN_CHAT_PANE_WIDTH,
  MIN_WORKSPACE_MENU_WIDTH,
  WORKSPACE_MENU_WIDTH_STORAGE_KEY,
  WORKSPACE_MENU_COLLAPSED_STORAGE_KEY,
  chatPaneRatioFromWidth,
  chatPaneWidthFromRatio,
  clampChatPaneRatio,
  clampWorkspaceMenuWidth,
  getStoredChatPaneWidth,
  getStoredChatPaneRatio,
  getStoredWorkspaceMenuWidth,
  getStoredWorkspaceMenuCollapsed,
  nextWorkspaceMenuWidthFromDrag,
  setStoredChatPaneRatio,
  setStoredWorkspaceMenuWidth,
  setStoredWorkspaceMenuCollapsed
} = require("./splitPaneSizing.ts");

test("legacy chat pane width remains readable for ratio migration", () => {
  const values = new Map<string, string>();
  global.window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
  } as unknown as Window & typeof globalThis;

  values.set("dartsnut-chat-pane-width", "732");

  assert.equal(getStoredChatPaneWidth(), 732);
  Reflect.deleteProperty(global, "window");
});

test("invalid or unavailable stored widths use the default", () => {
  global.window = {
    localStorage: {
      getItem: () => "not-a-width",
      setItem: () => undefined
    }
  } as unknown as Window & typeof globalThis;

  assert.equal(getStoredChatPaneWidth(), DEFAULT_CHAT_PANE_WIDTH);
  Reflect.deleteProperty(global, "window");
});

test("workspace menu width clamps and follows pointer movement", () => {
  assert.equal(clampWorkspaceMenuWidth(100), MIN_WORKSPACE_MENU_WIDTH);
  assert.equal(clampWorkspaceMenuWidth(900), MAX_WORKSPACE_MENU_WIDTH);
  assert.equal(nextWorkspaceMenuWidthFromDrag({
    startClientX: 280,
    currentClientX: 340,
    startWidth: DEFAULT_WORKSPACE_MENU_WIDTH
  }), DEFAULT_WORKSPACE_MENU_WIDTH + 60);
});

test("chat and emulator panes preserve ratio as panel width changes", () => {
  const ratio = chatPaneRatioFromWidth(680, 1280);
  assert.equal(chatPaneWidthFromRatio(ratio, 960), 510);
  assert.equal(chatPaneWidthFromRatio(ratio, 1440), 765);
});

test("temporary minimum clamp does not replace the preferred ratio", () => {
  const preferredRatio = 0.55;
  assert.equal(chatPaneWidthFromRatio(preferredRatio, 700), 340);
  assert.equal(chatPaneWidthFromRatio(preferredRatio, 1000), 550);
});

test("chat ratio keeps both pane minimums", () => {
  assert.equal(chatPaneWidthFromRatio(0, 1000), MIN_CHAT_PANE_WIDTH);
  assert.equal(chatPaneWidthFromRatio(1, 1000), 640);
  assert.equal(clampChatPaneRatio(0.5, 500), 0.64);
});

test("chat pane ratio round-trips through local storage", () => {
  const values = new Map<string, string>();
  global.window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
  } as unknown as Window & typeof globalThis;

  setStoredChatPaneRatio(0.53125);

  assert.equal(values.get(CHAT_PANE_RATIO_STORAGE_KEY), "0.53125");
  assert.equal(getStoredChatPaneRatio(), 0.53125);
  Reflect.deleteProperty(global, "window");
});

test("workspace menu width round-trips through local storage", () => {
  const values = new Map<string, string>();
  global.window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
  } as unknown as Window & typeof globalThis;

  setStoredWorkspaceMenuWidth(311.6);

  assert.equal(values.get(WORKSPACE_MENU_WIDTH_STORAGE_KEY), "312");
  assert.equal(getStoredWorkspaceMenuWidth(), 312);
  Reflect.deleteProperty(global, "window");
});

test("workspace menu collapsed state round-trips through local storage", () => {
  const values = new Map<string, string>();
  global.window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
  } as unknown as Window & typeof globalThis;

  setStoredWorkspaceMenuCollapsed(true);

  assert.equal(values.get(WORKSPACE_MENU_COLLAPSED_STORAGE_KEY), "true");
  assert.equal(getStoredWorkspaceMenuCollapsed(), true);
  Reflect.deleteProperty(global, "window");
});
