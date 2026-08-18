const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CHAT_PANE_WIDTH_STORAGE_KEY,
  DEFAULT_CHAT_PANE_WIDTH,
  DEFAULT_WORKSPACE_MENU_WIDTH,
  MAX_WORKSPACE_MENU_WIDTH,
  MIN_CHAT_PANE_WIDTH,
  MIN_WORKSPACE_MENU_WIDTH,
  WORKSPACE_MENU_WIDTH_STORAGE_KEY,
  WORKSPACE_MENU_COLLAPSED_STORAGE_KEY,
  clampChatPaneWidth,
  clampWorkspaceMenuWidth,
  getStoredChatPaneWidth,
  getStoredWorkspaceMenuWidth,
  getStoredWorkspaceMenuCollapsed,
  nextChatPaneWidthFromDrag,
  nextWorkspaceAndChatWidthsFromDrag,
  nextWorkspaceMenuWidthFromDrag,
  resizeWorkspaceMenuKeepingPaneTotal,
  setStoredChatPaneWidth,
  setStoredWorkspaceMenuWidth,
  setStoredWorkspaceMenuCollapsed
} = require("./splitPaneSizing.ts");

test("clampChatPaneWidth keeps the chat pane inside desktop layout bounds", () => {
  assert.equal(clampChatPaneWidth(120, 1280), MIN_CHAT_PANE_WIDTH);
  assert.equal(clampChatPaneWidth(520, 1280), 520);
  assert.equal(clampChatPaneWidth(1200, 1280), 900);
});

test("clampChatPaneWidth leaves a compact usable area for the emulator pane", () => {
  assert.equal(clampChatPaneWidth(620, 900), 520);
});

test("nextChatPaneWidthFromDrag applies pointer delta from the drag start", () => {
  assert.equal(nextChatPaneWidthFromDrag({
    startClientX: 400,
    currentClientX: 470,
    startWidth: DEFAULT_CHAT_PANE_WIDTH,
    viewportWidth: 1280
  }), DEFAULT_CHAT_PANE_WIDTH + 70);
});

test("chat pane width round-trips through local storage", () => {
  const values = new Map();
  global.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    }
  };

  setStoredChatPaneWidth(731.6);

  assert.equal(values.get(CHAT_PANE_WIDTH_STORAGE_KEY), "732");
  assert.equal(getStoredChatPaneWidth(), 732);
  delete global.window;
});

test("invalid or unavailable stored widths use the default", () => {
  global.window = {
    localStorage: {
      getItem: () => "not-a-width",
      setItem: () => {
        throw new Error("storage unavailable");
      }
    }
  };

  assert.equal(getStoredChatPaneWidth(), DEFAULT_CHAT_PANE_WIDTH);
  assert.doesNotThrow(() => setStoredChatPaneWidth(720));
  delete global.window;
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

test("workspace menu resizing preserves emulator width by taking space from chat", () => {
  assert.deepEqual(nextWorkspaceAndChatWidthsFromDrag({
    startClientX: 280,
    currentClientX: 340,
    startMenuWidth: 280,
    startChatWidth: 680
  }), {
    menuWidth: 340,
    chatWidth: 620
  });
});

test("workspace menu stops growing when chat reaches its minimum width", () => {
  assert.deepEqual(resizeWorkspaceMenuKeepingPaneTotal({
    targetMenuWidth: MAX_WORKSPACE_MENU_WIDTH,
    menuWidth: 280,
    chatWidth: 360
  }), {
    menuWidth: 320,
    chatWidth: MIN_CHAT_PANE_WIDTH
  });
});

test("workspace menu width round-trips through local storage", () => {
  const values = new Map();
  global.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    }
  };

  setStoredWorkspaceMenuWidth(311.6);

  assert.equal(values.get(WORKSPACE_MENU_WIDTH_STORAGE_KEY), "312");
  assert.equal(getStoredWorkspaceMenuWidth(), 312);
  delete global.window;
});

test("workspace menu collapsed state round-trips through local storage", () => {
  const values = new Map();
  global.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    }
  };

  setStoredWorkspaceMenuCollapsed(true);

  assert.equal(values.get(WORKSPACE_MENU_COLLAPSED_STORAGE_KEY), "true");
  assert.equal(getStoredWorkspaceMenuCollapsed(), true);
  delete global.window;
});
