const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_CHAT_PANE_WIDTH,
  MIN_CHAT_PANE_WIDTH,
  clampChatPaneWidth,
  nextChatPaneWidthFromDrag
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
