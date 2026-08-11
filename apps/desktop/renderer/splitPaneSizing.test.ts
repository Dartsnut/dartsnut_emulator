const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CHAT_PANE_WIDTH_STORAGE_KEY,
  DEFAULT_CHAT_PANE_WIDTH,
  MIN_CHAT_PANE_WIDTH,
  clampChatPaneWidth,
  getStoredChatPaneWidth,
  nextChatPaneWidthFromDrag,
  setStoredChatPaneWidth
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
